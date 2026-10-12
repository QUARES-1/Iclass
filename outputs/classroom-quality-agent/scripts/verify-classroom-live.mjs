// Full, downloaded public lecture only; no transcript or model fixture injection.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const base=process.env.LIVE_URL || 'http://127.0.0.1:3000';
const dir='artifacts/live';await fs.mkdir(dir,{recursive:true});
const phase=process.argv[2] || 'transcribe';
let state;
async function get(){state=await(await fetch(base+'/api/classroom')).json();return state;}
async function post(url,body,raw=false){const res=await fetch(base+url,{method:'POST',headers:raw?{}:{'Content-Type':'application/json'},body:raw?body:JSON.stringify(body)});state=await res.json();if(!res.ok)throw Error(state.error);return state;}
async function wait(job){
  let previous='',started=Date.now();
  while(true){await get();const j=state.jobs.find(x=>x.id===job.id);assert.ok(j);
    const key=[j.stage,j.chunkStart,j.completedParts].join(':');
    if(key!==previous){console.log(JSON.stringify({type:j.type,stage:j.stage,chunkStart:j.chunkStart,chunkEnd:j.chunkEnd,completedParts:j.completedParts,totalParts:j.totalParts,wallSeconds:Math.round((Date.now()-started)/1000)}));previous=key;}
    if(j.stage==='failed')throw Error(j.error);
    if(j.stage==='completed')return;
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
}
await get();
const source=JSON.parse(await fs.readFile('artifacts/audio/classroom-source.json','utf8'));
assert.equal(source.source,'https://archive.org/details/engineering6_computer_networking_course');
const expectedHash='1562249ae7200de27db035d369f2409e8b996b624755ace807d80b65cea5f8ad';
assert.equal(source.audioSha256,expectedHash);
assert.equal(createHash('sha256').update(await fs.readFile(source.audioPath)).digest('hex'),expectedHash);
if(phase==='transcribe'){
  const name=path.basename(source.audioPath);
  assert.ok(source.durationSeconds>=45*60 && source.durationSeconds<=100*60);
  assert.ok(!state.audio || state.audio.name===name,'Existing classroom audio is never replaced by this script.');
  if(!state.audio){
    await post('/api/classroom',{revision:state.revision,action:'course',course:{title:'计算机网络 · 公开课堂第一讲',description:'北京大学计算机网络课程，档案馆公开录像提取的完整音轨。用于独立音频复盘验收；未提供学生掌握或专注数据。来源：https://archive.org/details/engineering6_computer_networking_course'}});
    const bytes=await fs.readFile(source.audioPath);
    await post('/api/classroom/audio?'+new URLSearchParams({name,revision:state.revision,source:'upload'}),bytes,true);
  }
  let job=state.jobs.find(j=>j.type==='transcribe' && !['failed','completed'].includes(j.stage));
  if(!job && !state.currentTranscriptId){await post('/api/classroom/transcribe',{revision:state.revision});job=state.jobs.at(-1);}
  if(job)await wait(job);
  const current=state.transcriptVersions.find(t=>t.id===state.currentTranscriptId);
  const transcript=current?.original && current.source==='asr'?current:state.transcriptVersions.findLast(t=>t.original && t.source==='asr' && t.audioId===state.audio.id);
  assert.ok(transcript?.original);
  const chunks=transcript.processing.chunks;
  assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,state.audio.duration);
  for(let i=1;i<chunks.length;i++)assert.equal(chunks[i].start,chunks[i-1].end);
  assert.ok(chunks.every(c=>c.status==='complete'));
  for(const s of transcript.segments){assert.ok(s.start>=0 && s.end>s.start && s.end<=state.audio.duration+.3);assert.equal(s.timestampSource,'whisper-word-alignment+vad-offset+chunk-offset');}
  await fs.writeFile(`${dir}/classroom-transcription.json`,JSON.stringify({source,transcript,state},null,2));
  console.log(JSON.stringify({duration:state.audio.duration,segmentCount:transcript.segments.length,characters:transcript.segments.reduce((n,s)=>n+s.text.length,0),processing:transcript.processing}));
} else if(phase==='analyze'){
  const transcript=state.transcriptVersions.find(t=>t.id===state.currentTranscriptId);assert.ok(transcript);
  assert.equal(state.audio?.name,path.basename(source.audioPath));
  const audioResponse=await fetch(base+'/api/classroom/audio?id='+encodeURIComponent(state.audio.id));
  assert.equal(audioResponse.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await audioResponse.arrayBuffer())).digest('hex'),expectedHash);
  const original=state.transcriptVersions.find(t=>t.audioId===state.audio.id && t.original);
  assert.ok(original && original.source==='asr' && original.processing.chunks.every(c=>c.status==='complete'));
  if(transcript.id!==original.id){
    const corrections=JSON.parse(await fs.readFile(`${dir}/classroom-corrections.json`,'utf8'));
    assert.equal(corrections.originalId,original.id);
    assert.equal(corrections.correctedId,transcript.id);
    const edits=new Map(corrections.edits.map(e=>[e.id,e]));
    assert.deepEqual(transcript.segments,original.segments.map(s=>{
      const edit=edits.get(s.id);if(edit)assert.equal(edit.from,s.text);
      return edit?{...s,text:edit.to}:s;
    }));
  }
  // Record the exact public-lecture-only input for review before invoking the model.
  await fs.writeFile(`${dir}/classroom-analysis-input.json`,JSON.stringify({source,course:state.course,transcriptId:transcript.id,segments:transcript.segments},null,2));
  const analysisStarted=Date.now();
  await post('/api/classroom/analyze',{revision:state.revision});await wait(state.jobs.at(-1));
  const elapsedSeconds=(Date.now()-analysisStarted)/1000;
  const report=state.reports.find(r=>r.id===state.currentReportId);assert.ok(report && !report.stale);
  const ids=new Set(transcript.segments.map(s=>s.id));
  assert.equal(report.coverage.flatMap(p=>p.ids).length,ids.size);
  assert.ok(report.coverage.flatMap(p=>p.ids).every(id=>ids.has(id)));
  assert.ok(Object.values(report.sections).flat().every(i=>i.evidenceIds.length && i.evidenceIds.every(id=>ids.has(id))));
  assert.ok(report.sections.difficulties.every(i=>i.kind==='hypothesis'));
  const res=await fetch(base+'/api/classroom/report');assert.equal(res.status,200);
  await fs.writeFile(`${dir}/classroom-real-report.md`,await res.text());
  await fs.writeFile(`${dir}/classroom-analysis.json`,JSON.stringify({model:'configured-backend-real-model',elapsedSeconds,coverageComplete:true,evidenceIdsValid:true,report,state},null,2));
  console.log(JSON.stringify({elapsedSeconds,parts:report.coverage.length,sections:Object.fromEntries(Object.entries(report.sections).map(([k,v])=>[k,v.length])),evidenceIdsValid:true,coverageComplete:true}));
} else throw Error('Use transcribe or analyze');
