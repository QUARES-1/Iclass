"""Real decoding/inference checks; generated boundary fixture is NOT a lesson."""
import json
import subprocess
import os
import sys
from pathlib import Path
import imageio_ffmpeg
root=Path(__file__).resolve().parent.parent
out=root/'artifacts/audio'
out.mkdir(parents=True,exist_ok=True)
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
source=out/'asr-example-zh.wav'
results=[]
def convert(args):
    subprocess.run([ffmpeg,'-v','error','-y',*args],check=True)
def run(label,file,mode='transcribe',expect_success=True,env=None):
    child=subprocess.run([sys.executable,str(root/'speech/worker.py'),mode,str(file)],capture_output=True,text=True,env={**os.environ,**(env or {})})
    events=[json.loads(line) for line in child.stdout.splitlines() if line.startswith('{')]
    final=events[-1] if events else {'stage':'failed','error':child.stderr}
    success=child.returncode==0
    result={'case':label,'file':str(file.relative_to(root)),'mode':mode,'passed':success==expect_success,'result':final}
    if final.get('result',{}).get('peakResidentBytes'): result['peakResidentBytes']=final['result']['peakResidentBytes']
    results.append(result)
    (out/(label+'.ndjson')).write_text(child.stdout)
    print(json.dumps({'case':label,'passed':result['passed'],'result':final},ensure_ascii=False),flush=True)
    (out/'validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    return final
for ext,args in [('mp3',[]),('m4a',['-c:a','aac']),('webm',['-c:a','libopus'])]:
    file=out/('short.'+ext)
    convert(['-i',str(source),*args,str(file)])
    run('format-'+ext,file)
silence=out/'silence.wav'
convert(['-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','8',str(silence)])
run('no-speech',silence,expect_success=False)
bad=out/'broken.wav';bad.write_bytes(b'not audio')
run('damaged',bad,'probe',expect_success=False)
# Speech samples at 20, 175 and 195 seconds straddle the default 180-second boundary.
boundary=out/'boundary-220s.wav'
convert(['-f','lavfi','-i','anullsrc=r=16000:cl=mono','-i',str(source),'-filter_complex','[1:a]asplit=3[a][b][c];[a]adelay=20000|20000[a1];[b]adelay=175000|175000[b1];[c]adelay=195000|195000[c1];[0:a][a1][b1][c1]amix=inputs=4:duration=first:normalize=0','-t','220','-ar','16000','-ac','1',str(boundary)])
final=run('boundary-offset',boundary)
if final.get('result'):
    s=final['result']['segments']
    check={'case':'boundary-time-check','passed':any(x['start']>190 for x in s) and any(170<x['start']<185 for x in s),'note':'220秒合成边界夹具，不能替代完整真实课堂录音验收。'}
    results.append(check)
    (out/'validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print('真实语音技术检查结束；完整课堂结果另见 docs/live-validation.md，不以本夹具替代。',flush=True)
