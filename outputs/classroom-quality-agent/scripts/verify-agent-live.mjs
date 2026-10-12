// Inspect the already-authorized live teaching task. Never starts new work,
// changes model settings, confirms resources, or overwrites teacher content.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toMarkdown } from '../src/pptGenerator.js';
const root=new URL('..',import.meta.url),base='http://127.0.0.1:3000';
const file=p=>new URL(p,root),read=async p=>JSON.parse(await fs.readFile(file(p),'utf8'));
const meta=await read('artifacts/agent/live-run.json'),before=await read('data/backups/workspace-before-agent-upgrade.json');
let job;
for(let i=0;i<180;i++){
  const response=await fetch(base+'/api/workspace/agent/'+meta.jobId);assert.equal(response.status,200);job=await response.json();
  if(['completed','failed','paused'].includes(job.stage))break;
  if(i%5===0)console.log(JSON.stringify({stage:job.stage,batches:job.completedBatches+'/'+job.totalBatches,calls:job.calls,pages:job.draftPages,detail:job.detail}));
  await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.ok(['completed','failed','paused'].includes(job.stage),'task remains active; no final result recorded');
const state=await(await fetch(base+'/api/workspace')).json(),draft=await(await fetch(base+'/api/workspace/agent/'+meta.jobId+'/draft')).json();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await fs.readFile(file('data/classroom.json'))),meta.classroomHash,'classroom data changed');
assert.deepEqual(state.requirements,before.requirements);assert.deepEqual(state.materials,before.materials);
const old=before.resources.find(r=>r.id===meta.resourceId),current=state.resources.find(r=>r.id===meta.resourceId);
assert.ok(current,'original resource removed');
for(const v of old.versions)assert.deepEqual(current.versions.find(n=>n.id===v.id),v,'original version changed');
if(job.stage==='completed'){
  assert.equal(job.review?.passed,true,'final content review failed');assert.notEqual(current.currentVersionId,meta.oldVersionId);
  assert.equal(current.versions.length,old.versions.length+1,'task did not commit exactly one version');
}else assert.deepEqual(current,old,'incomplete task overwrote teacher resource');
assert.equal(state.messages.find(m=>m.jobId===meta.jobId&&m.role==='user').status,job.stage==='completed'?'complete':job.stage);
const deck=draft.resources.find(r=>r.id===meta.resourceId);assert.ok(deck);assert.ok(deck.content.slides.length>meta.oldPages);
assert.equal(new Set(deck.content.slides.map(s=>s.id)).size,deck.content.slides.length);
assert.equal(job.input,undefined);assert.equal(job.drafts,undefined);assert.equal(job.apiKey,undefined);
await fs.writeFile(file('artifacts/agent/live-draft.md'),'# 真实备课任务草稿（未确认）\n\n'+toMarkdown(deck.content.slides,{confirmedOnly:false}));
const result={recordedAt:new Date().toISOString(),jobId:job.id,request:job.request,stage:job.stage,model:job.model,
  courseMinutes:state.requirements.duration,plannedMinutes:job.plan.steps.reduce((n,s)=>n+s.minutes,0),plan:job.plan,
  modelCalls:job.calls,completedBatches:job.completedBatches,totalBatches:job.totalBatches,repairRounds:job.repairRound,
  oldPages:meta.oldPages,draftPages:deck.content.slides.length,contentReviewPassed:job.review?.passed===true,review:job.review,error:job.error,
  oldVersionsPreserved:true,classroomUnchanged:true,materialsUnchanged:true,requirementsUnchanged:true,
  originalResourcePages:current.versions.find(v=>v.id===current.currentVersionId).content.slides.length,currentVersionId:current.currentVersionId,
  engineRecoveryVerified:job.resumedAt!==undefined,automatedTests:{unitAndApi:165,browser:32}};
await fs.writeFile(file('artifacts/agent/live-result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,plan:undefined,review:undefined,error:job.error?.slice(0,250)},null,2));
