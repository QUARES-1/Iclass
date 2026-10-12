"""Prepare public speech and synthetic codec fixtures; never read teacher data."""
import argparse
import shutil
import subprocess
import urllib.request
import wave
from pathlib import Path
import imageio_ffmpeg

SOURCE_URL = 'https://isv-data.oss-cn-hangzhou.aliyuncs.com/ics/MaaS/ASR/test_audio/asr_example_zh.wav'
root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, help='Local copy of the public Chinese speech fixture')
parser.add_argument('--output-dir', type=Path, default=root / 'artifacts/audio')
args = parser.parse_args()
target = args.output_dir.resolve()
target.mkdir(parents=True, exist_ok=True)
speech = target / 'asr-example-zh.wav'
if args.source:
    if args.source.resolve() != speech:
        shutil.copyfile(args.source, speech)
elif not speech.exists():
    temporary = speech.with_suffix('.download')
    try:
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        with wave.open(str(temporary)) as audio:
            if not audio.getnframes():
                raise ValueError('Downloaded fixture has no audio frames')
        temporary.replace(speech)
    finally:
        temporary.unlink(missing_ok=True)
with wave.open(str(speech)) as audio:
    duration = audio.getnframes() / audio.getframerate()
    if duration <= 0:
        raise ValueError('Speech fixture has no audio frames')
codec_fixture = target / 'adpcm_ima_wav.wav'
subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '10', '-ac', '1', '-c:a', 'adpcm_ima_wav', str(codec_fixture)], check=True)
print(f'Speech fixture ready: {speech} ({duration:.3f}s)')
print(f'Synthetic ADPCM fixture ready: {codec_fixture}')
