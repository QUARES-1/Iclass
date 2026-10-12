import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {toMarkdown} from '../src/pptGenerator.js';
const root=new URL('..',import.meta.url),file=p=>new URL(p,root),base='http://127.0.0.1:3000';
const run=JSON.parse(await fs.readFile(file('artifacts/code-course/run.json'))),before=JSON.parse(await fs.readFile(file(run.backup)));
const api=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
let job;
for(let i=0;i<900;i++){
  job=await api('/api/workspace/agent/'+run.jobId);if(['completed','failed','paused'].includes(job.stage))break;
  if(i%10===0)console.log(JSON.stringify({stage:job.stage,batches:job.completedBatches+'/'+job.totalBatches,calls:job.calls,pages:job.draftPages,detail:job.detail}));
  await new Promise(r=>setTimeout(r,2000));
}
assert.ok(['completed','failed','paused'].includes(job.stage),'task remains running');
const state=await api('/api/workspace'),draft=await api('/api/workspace/agent/'+run.jobId+'/draft');
await fs.writeFile(file('artifacts/code-course/draft.json'),JSON.stringify(draft,null,2));
const slides=draft.resources.flatMap(r=>r.type==='ppt'?r.content.slides:[]),codePages=slides.filter(s=>s.code&&s.code.kind!=='output'),blocks=new Map();
for(const s of codePages){const key=s.code.blockId||s.id;if(!blocks.has(key))blocks.set(key,{language:s.code.language,parts:[]});blocks.get(key).parts.push(s.code.source);}
let index=0;for(const {language,parts} of blocks.values())await fs.writeFile(file('artifacts/code-course/code-'+(++index)+'.'+(language==='cpp'?'cpp':'txt')),parts.join(''));
const original=before.resources.find(r=>r.id===run.resourceId),current=state.resources.find(r=>r.id===run.resourceId);assert.ok(current);
for(const version of original.versions)assert.deepEqual(current.versions.find(v=>v.id===version.id),version);
assert.deepEqual(state.materials,before.materials);
for(const key of ['topic','audience','duration'])assert.equal(state.requirements[key],before.requirements[key]);
assert.equal(createHash('sha256').update(await fs.readFile(file('data/classroom.json'))).digest('hex'),run.classroomHash);
if(job.stage==='completed'){assert.equal(job.review.passed,true);assert.equal(current.versions.length,original.versions.length+1);assert.ok(codePages.length);}
else assert.equal(current.currentVersionId,run.oldVersionId);
const report={recordedAt:new Date().toISOString(),jobId:job.id,stage:job.stage,model:job.model,calls:job.calls,batches:job.completedBatches,repairRounds:job.repairRound,plan:job.plan,review:job.review,error:job.error,pages:slides.length,codePages:codePages.length,codeBlocks:blocks.size,exercisePages:slides.filter(s=>/练习|例题|答案讲评/.test(s.title)).length,pagesWithExample:slides.filter(s=>s.example||s.counterExample).length,originalVersionsPreserved:true,materialsUnchanged:true,classroomUnchanged:true,currentPages:current.versions.find(v=>v.id===current.currentVersionId).content.slides.length};
await fs.writeFile(file('artifacts/code-course/result.json'),JSON.stringify(report,null,2));await fs.writeFile(file('artifacts/code-course/lesson.md'),toMarkdown(slides));
console.log(JSON.stringify({...report,plan:undefined,review:undefined},null,2));
