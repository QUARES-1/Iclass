"""Bounded-memory local speech worker; NDJSON events are consumed by Node.
No templates or fallback transcript are used. Run prepare.py before inference.
"""
import json
import os
import sys
import tempfile
import subprocess
import time
import uuid
import resource
import math
from pathlib import Path

try:
    MAX_SECONDS = float(os.environ.get('AUDIO_MAX_SECONDS', '10800'))
    if not math.isfinite(MAX_SECONDS) or MAX_SECONDS <= 0:
        MAX_SECONDS = 10800
except ValueError:
    MAX_SECONDS = 10800
CHUNK_SECONDS = float(os.environ.get('ASR_CHUNK_SECONDS', '180'))

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def probe(file):
    import av
    from av.stream import Disposition
    try:
        with av.open(file, metadata_errors='replace') as container:
            streams = list(container.streams.audio)
            if not streams:
                raise ValueError('文件没有可解码的音轨。')
            if any(not (s.disposition & Disposition.attached_pic) for s in container.streams.video):
                raise ValueError('检测到视频轨道，请先提取音频再上传；仅修改扩展名无效。')
            stream = streams[0]
            frames = container.decode(stream)
            first_frame = next(frames, None)
            if first_frame is None or first_frame.samples <= 0:
                raise ValueError('音轨没有可解码的音频帧。')
            duration = float(stream.duration * stream.time_base) if stream.duration else float(container.duration / av.time_base) if container.duration else 0
            # WebM recorded by MediaRecorder may have no duration metadata.
            if duration <= 0:
                duration = first_frame.samples / first_frame.sample_rate
                for frame in frames:
                    duration += frame.samples / frame.sample_rate
                    if duration > MAX_SECONDS:
                        break
            if not 0 < duration <= MAX_SECONDS:
                raise ValueError(f'音频时长无效或超过 {MAX_SECONDS:g} 秒限制。')
            return {'duration': duration, 'codec': stream.codec_context.name, 'sampleRate': stream.codec_context.sample_rate, 'format': container.format.name}
    except Exception as exc:
        raise ValueError('音频损坏、格式不支持或时长超限：' + str(exc)) from exc

def transcribe(file):
    started = time.monotonic()
    emit({'stage': 'processing'})
    info = probe(file)
    emit({'stage': 'loading-model', 'duration': info['duration']})
    from faster_whisper import WhisperModel
    import imageio_ffmpeg
    model_path = os.environ.get('ASR_MODEL', str(Path(__file__).resolve().parent.parent / 'data/models/whisper-small'))
    model = WhisperModel(model_path, device=os.environ.get('ASR_DEVICE', 'cpu'), compute_type=os.environ.get('ASR_COMPUTE_TYPE', 'int8'), cpu_threads=int(os.environ.get('ASR_THREADS', '4')), local_files_only=True)
    duration = info['duration']
    checkpoint_path = os.environ.get('ASR_CHECKPOINT')
    fingerprint = {'file': str(Path(file).resolve()), 'bytes': Path(file).stat().st_size, 'mtime': Path(file).stat().st_mtime_ns, 'chunkSeconds': CHUNK_SECONDS, 'model': model_path}
    checkpoint = {}
    if checkpoint_path and Path(checkpoint_path).exists():
        checkpoint = json.loads(Path(checkpoint_path).read_text())
        if checkpoint.get('fingerprint') != fingerprint:
            raise ValueError('录音或识别配置已变化，请新建转写任务，不沿用旧分段。')
    offset = float(checkpoint.get('offset', 0))
    merged = checkpoint.get('segments', [])
    chunks = checkpoint.get('chunks', [])
    overlap = 2.0
    if CHUNK_SECONDS < 10 or CHUNK_SECONDS > 600:
        raise ValueError('分段时长需在 10～600 秒之间。')
    with tempfile.TemporaryDirectory(prefix='classroom-asr-') as temp:
        while offset < duration:
            start = max(0, offset - overlap)
            end = min(duration, offset + CHUNK_SECONDS + overlap)
            wav = str(Path(temp) / 'chunk.wav')
            emit({'stage': 'processing', 'chunkStart': start, 'chunkEnd': end})
            args = [os.environ.get('FFMPEG_PATH') or imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-ss', str(start), '-i', file, '-t', str(end-start), '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', wav]
            converted = subprocess.run(args, capture_output=True, timeout=180)
            if converted.returncode:
                raise ValueError('音频转换失败：' + converted.stderr.decode(errors='replace')[:300])
            emit({'stage': 'transcribing', 'chunkStart': offset, 'chunkEnd': min(duration, offset + CHUNK_SECONDS)})
            from faster_whisper.audio import decode_audio
            from faster_whisper.vad import get_speech_timestamps, VadOptions
            audio = decode_audio(wav, sampling_rate=16000)
            # Transcribe each real VAD span separately. This prevents an alignment
            # at a stitched VAD boundary from spanning minutes of removed silence.
            spans = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=250, max_speech_duration_s=30, min_silence_duration_ms=600, speech_pad_ms=300))
            owned = []
            for span in spans:
                local_offset = start + span['start'] / 16000
                span_duration = (span['end'] - span['start']) / 16000
                segments, _ = model.transcribe(audio[span['start']:span['end']], language='zh', beam_size=5, vad_filter=False, word_timestamps=True, condition_on_previous_text=False)
                for segment in segments:
                    words = [w for w in (segment.words or []) if offset <= local_offset + (w.start + w.end) / 2 < min(duration, offset + CHUNK_SECONDS)]
                    if not words:
                        continue
                    text = ''.join(w.word for w in words).strip()
                    a = max(local_offset, local_offset + words[0].start)
                    b = min(duration, local_offset + span_duration, local_offset + words[-1].end)
                    if not text or b <= a:
                        continue
                    owned.append({'id': str(uuid.uuid4()), 'start': round(a, 3), 'end': round(b, 3), 'text': text, 'timestampSource': 'whisper-word-alignment+vad-offset+chunk-offset'})
            merged.extend(owned)
            chunks.append({'start': offset, 'end': min(duration, offset+CHUNK_SECONDS), 'segmentCount': len(owned), 'status': 'complete'})
            offset += CHUNK_SECONDS
            if checkpoint_path:
                target = Path(checkpoint_path)
                temporary = target.with_suffix('.tmp')
                temporary.write_text(json.dumps({'fingerprint': fingerprint, 'offset': offset, 'segments': merged, 'chunks': chunks}, ensure_ascii=False))
                temporary.chmod(0o600)
                temporary.replace(target)
            emit({'stage': 'chunk-complete', 'completedParts': len(chunks), 'totalParts': math.ceil(duration / CHUNK_SECONDS)})
    merged.sort(key=lambda s: s['start'])
    if not merged:
        raise ValueError('未识别到语音，请检查录音内容和音量。')
    emit({'stage': 'completed', 'result': {'segments': merged, 'duration': duration, 'chunks': chunks, 'model': model_path, 'device': os.environ.get('ASR_DEVICE', 'cpu'), 'computeType': os.environ.get('ASR_COMPUTE_TYPE', 'int8'), 'elapsedSeconds': round(time.monotonic()-started, 3), 'peakResidentBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)}})

def playback(file):
    import imageio_ffmpeg
    target = os.environ.get('PLAYBACK_TARGET')
    if not target:
        raise ValueError('缺少回放文件路径。')
    result = subprocess.run([os.environ.get('FFMPEG_PATH') or imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-i', file, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', target], capture_output=True, timeout=540)
    if result.returncode:
        raise ValueError('无法准备浏览器回放音频：' + result.stderr.decode(errors='replace')[:300])
    emit({'stage': 'completed', 'result': {'prepared': True}})

if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: worker.py probe|transcribe AUDIO')
        if sys.argv[1] == 'probe':
            emit({'stage': 'completed', 'result': probe(sys.argv[2])})
        elif sys.argv[1] == 'transcribe':
            transcribe(sys.argv[2])
        elif sys.argv[1] == 'playback':
            playback(sys.argv[2])
        else:
            raise ValueError('未知语音任务。')
    except Exception as exc:
        text = str(exc)
        if isinstance(exc, (ImportError, ModuleNotFoundError)):
            text = '语音依赖未安装，请按 README 准备 Python 环境。' + text
        elif isinstance(exc, MemoryError) or 'out of memory' in text.lower():
            text = '内存或显存不足，请关闭其他推理任务后重试。'
        elif 'model' in text.lower() or 'local' in text.lower() or 'huggingface' in text.lower():
            text = '本地语音模型不可用，请先准备模型。' + text
        emit({'stage': 'failed', 'error': text[:800]})
        sys.exit(1)
