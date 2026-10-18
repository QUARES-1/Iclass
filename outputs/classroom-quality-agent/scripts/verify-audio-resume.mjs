// Local verification only: public speech fixture, no model API or teacher data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {speechCommand} from '../src/speech.js';
import {pythonExecutable,pythonEnvironment} from '../src/python.js';
const root=process.cwd(),dir=path.join(root,'artifacts/sprint2-fixed');await fs.mkdir(dir,{recursive:true});
const file=path.join(dir,'resume-fixture.wav'),checkpointPath=path.join(dir,'asr-checkpoint.json');
const ffmpeg=execFileSync(pythonExecutable(root),['-c','import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],{encoding:'utf8',env:pythonEnvironment()}).trim();
execFileSync(ffmpeg,['-nostdin','-v','error','-y','-stream_loop','-1','-i',path.join(root,'artifacts/audio/asr-example-zh.wav'),'-t','32','-ac','1','-ar','16000',file]);await fs.rm(checkpointPath,{force:true});
process.env.ASR_CHUNK_SECONDS='10';const controller=new AbortController();let completed;
await assert.rejects(speechCommand(root,'transcribe',file,event=>{if(event.stage==='chunk-complete'&&event.completedParts===1){completed=event;controller.abort();}},{signal:controller.signal,checkpointPath}),error=>error.statusCode===499);
assert.equal(completed.completedParts,1);const saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));assert.equal(saved.chunks.length,1);assert.ok(saved.segments.length);
const events=[],result=await speechCommand(root,'transcribe',file,event=>events.push(event),{checkpointPath});
assert.equal(result.chunks.length,4);assert.deepEqual(result.segments.slice(0,saved.segments.length),saved.segments);assert.equal(events.find(e=>e.stage==='transcribing').chunkStart,10);
const report={duration:result.duration,completedBeforePause:saved.chunks.length,completedAfterResume:result.chunks.length,preservedSegmentIds:saved.segments.map(s=>s.id),firstResumedOffset:10,passed:true};await fs.writeFile(path.join(dir,'resume-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
