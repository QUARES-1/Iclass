// Isolated, offline repetition probe. Run with --expose-gc for retained-heap
// measurements; it never reads teacher data or calls a real provider/model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {ModelSettings} from '../src/modelSettings.js';
import {FeedbackService} from '../src/feedbackService.js';
import {FeedbackAgent} from '../src/feedbackAgent.js';
import {emptyWorkspace} from '../src/workspace.js';
import {loadSampleWorkspace} from '../src/sampleWorkspace.js';
import {diskUsage} from '../src/storageQuota.js';

const cycles=Number(process.env.REPETITION_CYCLES||200);
assert.ok(Number.isSafeInteger(cycles)&&cycles>=1&&cycles<=2000,'REPETITION_CYCLES must be 1..2000');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'classroom-repetition-')),store=new Store(dir);
const service=new FeedbackService({store,modelSettings:new ModelSettings(dir,{LLM_API_KEY:'offline-repetition-fixture'}),modelCall:async()=>({action:'reply',reply:'你好。'}),providerIntervalMs:0});
const measurements=[],checks={};
async function measure(phase){
  if(global.gc)global.gc();await new Promise(r=>setImmediate(r));if(global.gc)global.gc();
  const {files,bytes}=await diskUsage(dir);
  const memory=process.memoryUsage();measurements.push({phase,heapUsed:memory.heapUsed,rss:memory.rss,files,bytes,queues:store.queues.size,runs:service.runs.size});
  console.log(JSON.stringify(measurements.at(-1)));
}
try{
  let w=emptyWorkspace();loadSampleWorkspace(w);const original=JSON.stringify(w);for(let i=0;i<cycles;i++)loadSampleWorkspace(w);checks.workspaceSamples=JSON.stringify(w)===original;
  const samples=await service.sampleClasses(),sampleIds=samples.map(c=>c.id).sort();
  for(let i=0;i<20;i++)await service.sampleClasses();await measure('warmup');
  for(let i=0;i<cycles;i++)await service.sampleClasses();
  const concurrent=await Promise.all(Array.from({length:20},()=>service.sampleClasses()));checks.feedbackSamples=(await service.list()).length===samples.length&&concurrent.every(group=>JSON.stringify(group.map(c=>c.id).sort())===JSON.stringify(sampleIds));await measure('sample-repeat');
  let templates=await service.templates(),c=await service.create({title:'离线重复操作压力课堂'});
  const previewData={classId:c.id,records:[{id:'same-record',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4}}]};
  const preview=await service.previewImport(c.id,{data:previewData});c=await service.commitImport(c.id,c.revision,preview.id,false);
  c=await service.update(c.id,c.revision,x=>{x.reports=[{id:'report-one',version:1,text:'整体复盘。'.repeat(800),history:[],confirmed:true,stale:false}];x.currentReportId='report-one';return x;});
  c=await service.command(c.id,{revision:c.revision,action:'suggestions',suggestions:[{id:'suggestion-one',text:'示范完整函数及调用。'.repeat(80),evidenceIds:['course']}]});
  const source={revision:0,course:{title:'合成课堂'},audio:null,currentTranscriptId:'transcript-one',reports:[],transcriptVersions:[{id:'transcript-one',audioId:'audio-one',segments:[{id:'segment-one',start:0,end:10,text:'完整讲解。'.repeat(500)}]}]};
  await store.update('classroom',undefined,{revision:0},()=>source);
  c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:'transcript-one'});const sourceCount=(await fs.readdir(dir)).filter(f=>f.startsWith('feedback-source-')).length;
  const reportText=c.reports[0].text,suggestions=c.suggestions;
  for(let i=0;i<cycles;i++)templates=await service.saveTemplate({revision:templates.revision,template:templates.versions.at(-1)});
  checks.templateNoop=templates.versions.length===1;await measure('template-repeat');
  for(let i=0;i<cycles;i++)c=await service.command(c.id,{revision:c.revision,action:'report',reportId:'report-one',baseVersion:c.reports[0].version,text:reportText});
  checks.reportNoop=c.reports[0].version===1&&c.reports[0].history.length===0&&c.reports[0].confirmed;await measure('report-repeat');
  const suggestionVersion=c.suggestionVersion,suggestionHistory=c.suggestionHistory.length;
  for(let i=0;i<cycles;i++)c=await service.command(c.id,{revision:c.revision,action:'suggestions',baseSuggestionVersion:c.suggestionVersion,suggestions});
  checks.suggestionNoop=c.suggestionVersion===suggestionVersion&&c.suggestionHistory.length===suggestionHistory;await measure('suggestion-repeat');
  for(let i=0;i<cycles;i++)c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:'transcript-one'});
  checks.sourceNoop=(await fs.readdir(dir)).filter(f=>f.startsWith('feedback-source-')).length===sourceCount;await measure('source-repeat');
  const previewIds=new Set();for(let i=0;i<cycles;i++){const p=await service.previewImport(c.id,{data:previewData});previewIds.add(p.id);c=await service.commitImport(c.id,c.revision,p.id,false);}
  checks.importDedup=c.records.length===1;checks.previewReuse=previewIds.size===1;await measure('import-repeat');
  if(global.gc)checks.retainedHeapBounded=measurements.at(-1).heapUsed-measurements.find(m=>m.phase==='sample-repeat').heapUsed<8*1024*1024;
  const agent=new FeedbackAgent(service);for(let i=0;i<100;i++){const j=await agent.start(c.id,{revision:c.revision,request:'你好'});await service.runs.get('agent-'+j.id)?.promise;c=await service.read(c.id);}
  await measure('completed-jobs');checks.transientReleased=service.runs.size===0&&store.queues.size===0&&service.connectionQueue.length===0;
  const history={templates:templates.versions.length,reportRevisions:c.reports[0].history.length,suggestionRevisions:c.suggestionHistory.length,sourceSnapshots:(await fs.readdir(dir)).filter(f=>f.startsWith('feedback-source-')).length,previewFiles:(await fs.readdir(dir)).filter(f=>f.startsWith('feedback-import-')).length,messages:c.messages.length,jobs:c.jobIds.length};
  const result={cycles,offline:true,gcAvailable:Boolean(global.gc),checks,history,measurements,passed:Object.values(checks).every(Boolean)};
  const output=process.env.REPETITION_REPORT||'artifacts/repetition-result.json';await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({checks,history,report:output}));if(!result.passed)process.exitCode=1;
}finally{for(const run of service.runs.values())run.controller.abort();await Promise.all([...service.runs.values()].map(r=>r.promise));await fs.rm(dir,{recursive:true,force:true});}
