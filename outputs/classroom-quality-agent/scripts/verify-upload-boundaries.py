"""Real PyAV upload probes, isolated fixtures; no external model requests."""
import json,subprocess,sys,os,wave
from pathlib import Path
import imageio_ffmpeg
root=Path(__file__).resolve().parent.parent
out=root/'artifacts/boundaries';out.mkdir(parents=True,exist_ok=True)
source=root/'artifacts/audio/asr-example-zh.wav'
results=[]
def check(label,file,success,contains=None,env=None):
    child=subprocess.run([sys.executable,str(root/'speech/worker.py'),'probe',str(file)],capture_output=True,text=True,env={**os.environ,**(env or {})})
    events=[json.loads(s) for s in child.stdout.splitlines() if s.startswith('{')];final=events[-1] if events else {'error':child.stderr}
    passed=(child.returncode==0)==success and (contains is None or contains in final.get('error',''))
    results.append({'case':label,'passed':passed,'event':final});print(json.dumps(results[-1],ensure_ascii=False),flush=True)
check('valid-wav',source,True)
check('duration-limit-real',source,False,'时长',{'AUDIO_MAX_SECONDS':'1'})
check('invalid-limit-fallback',source,True,env={'AUDIO_MAX_SECONDS':'NaN'})
empty=out/'empty-track.wav'
with wave.open(str(empty),'wb') as file:file.setnchannels(1);file.setsampwidth(2);file.setframerate(16000)
check('container-without-audio-frames',empty,False)
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
video=out/'renamed-video.m4a'
subprocess.run([ffmpeg,'-v','error','-y','-f','lavfi','-i','color=black:s=32x32:r=1','-i',str(source),'-t','1','-c:v','mpeg4','-c:a','aac','-f','mp4',str(video)],check=True)
check('video-renamed-as-audio',video,False,'视频轨道')
ogg=out/'real.ogg'
subprocess.run([ffmpeg,'-v','error','-y','-i',str(source),'-c:a','libopus',str(ogg)],check=True)
check('valid-ogg',ogg,True)
(out/'real-probe-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
if not all(r['passed'] for r in results):sys.exit(1)
