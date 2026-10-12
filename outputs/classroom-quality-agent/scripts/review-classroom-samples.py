"""Re-decode real excerpts to inspect long-lecture timing and chunk boundaries.
This is an independent-window ASR consistency check, not a human accuracy score.
The full-lecture transcript is never overwritten by this script.
"""
import json
import subprocess
import time
from difflib import SequenceMatcher
from pathlib import Path
import imageio_ffmpeg
from faster_whisper import WhisperModel

root = Path(__file__).resolve().parent.parent
out = root / 'artifacts/live/classroom-samples'
out.mkdir(parents=True, exist_ok=True)
record = json.loads((root / 'artifacts/live/classroom-transcription.json').read_text())
source = record['source']
transcript = record['transcript']
duration = source['durationSeconds']
model = WhisperModel(str(root / 'data/models/whisper-small'), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
points = [(30, 'opening'), (duration / 2, 'middle'), (duration - 30, 'ending')]
points += [(c['start'], 'boundary') for c in transcript['processing']['chunks'][1:]]
results = []
started = time.monotonic()
for center, kind in points:
    start, end = max(0, center - 10), min(duration, center + 10)
    clip = out / f'{kind}-{int(center):04d}.wav'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-ss', str(start), '-i', str(root / source['audioPath']), '-t', str(end-start), '-map_metadata', '-1', '-ac', '1', '-ar', '16000', str(clip)], check=True)
    # No three-minute partitioning and no explicit VAD-span splitting here:
    # alignment is decoded afresh in a standalone twenty-second window.
    decoded, _ = model.transcribe(str(clip), language='zh', beam_size=5, vad_filter=False, word_timestamps=True, condition_on_previous_text=False)
    independent = [{'start': round(start+s.start, 3), 'end': round(start+s.end, 3), 'text': s.text} for s in decoded]
    original = [s for s in transcript['segments'] if s['start'] < end and s['end'] > start]
    text = ''.join(s['text'] for s in independent)
    normalized = lambda value: ''.join(c for c in value if c.isalnum()).lower()
    a, b = normalized(''.join(s['text'] for s in original)), normalized(text)
    ratio = round(SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)
    result = {'kind': kind, 'start': start, 'end': end, 'clip': str(clip.relative_to(root)), 'fullLectureSegments': original, 'independentWindowSegments': independent, 'textSimilarity': ratio, 'note': 'Window-edge context may differ; similarity is not accuracy. Review the audio before correcting uncertain content.'}
    results.append(result)
    (out.parent / 'classroom-sample-review.json').write_text(json.dumps({'method': 'Independent twenty-second-window re-decoding of actual audio, including every chunk boundary; not human listening or an accuracy benchmark', 'elapsedSeconds': round(time.monotonic()-started, 3), 'samples': results}, ensure_ascii=False, indent=2))
    print(json.dumps({'kind': kind, 'center': center, 'textSimilarity': ratio, 'text': text}, ensure_ascii=False), flush=True)
