// Real provider, isolated storage. Never sends requests to the teacher's server.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createApi,json} from '../src/api.js';
import {ModelSettings} from '../src/modelSettings.js';
import {emptyWorkspace,createResource,currentVersion} from '../src/workspace.js';
import {DEFAULT_PROMPTS} from '../src/prompts.js';
const root=new URL('..',import.meta.url).pathname;
process.loadEnvFile(path.join(root,'.env'));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'classroom-conversation-live-'));
// Synthetic requirements, text and history only. Teacher teaching data is not read.
const state=emptyWorkspace();state.requirements={topic:'平衡树',audience:'本科',duration:300,instructions:'讲清原理与实现，少量练习'};
state.materials=[{id:'synthetic-material',title:'测试资料',status:'parsed',type:'文本',content:'平衡树通过维护结构控制高度。讨论查找、插入、删除以及局部旋转。'}];
state.messages=[{id:'synthetic-old',role:'user',text:'新建300分钟完整课件',status:'failed',error:'这是构造的历史失败消息'}];
await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(state),{mode:0o600});
const configured=await new ModelSettings(path.join(root,'data')).read();
// Use configured connection credentials, with default application prompts instead
// of any teacher-authored prompt text, and keep all test storage temporary.
const config={apiKey:configured.apiKey,baseUrl:configured.baseUrl,model:configured.model,maxTokens:configured.maxTokens,temperature:configured.temperature,timeoutMs:configured.timeoutMs,maxInputChars:configured.maxInputChars,batchPages:configured.batchPages,maxAgentCalls:configured.maxAgentCalls,maxPlanSteps:configured.maxPlanSteps,maxRepairs:configured.maxRepairs,prompts:{...DEFAULT_PROMPTS}};
const api=createApi(root,{dataDir:dir,modelSettings:{read:async()=>config}});
const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},e.statusCode||500);}});
const results=[];
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const get=async url=>(await fetch(base+url)).json();
  async function send(request,resourceId){
    const before=await get('/api/workspace'),resource=before.resources.find(r=>r.id===resourceId),started=await fetch(base+'/api/workspace/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:before.revision,request,resourceId,baseVersionId:resource?.currentVersionId})});
    assert.equal(started.status,202);const first=await started.json();let job;
    const deadline=Date.now()+240000;
    do{job=await get('/api/workspace/agent/'+first.job.id);if(['completed','failed','paused'].includes(job.stage))break;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
    assert.equal(job.stage,'completed',job.error);const after=await get('/api/workspace'),reply=after.messages.findLast(m=>m.role==='assistant'&&m.jobId===job.id)?.text;
    results.push({request,mode:job.mode,execution:job.execution,stage:job.stage,calls:job.calls,hasPlan:Boolean(job.plan),draftPages:job.draftPages,reply});
    console.log(JSON.stringify(results.at(-1)));
    return {before,after,job};
  }
  for(const request of ['你好','平衡树是什么？','帮我改一下']){
    const {before,after,job}=await send(request);assert.equal(job.mode,'conversation');assert.equal(job.plan,null);assert.equal(job.draftPages,0);assert.deepEqual(after.resources,before.resources);
    if(request==='你好')assert.equal(job.calls,1);
  }
  const temporary=await get('/api/workspace');
  const resource=createResource(temporary,'ppt','对话功能验证课件',{slides:[{title:'平衡树的目的',bullets:['维护结构，控制查找路径长度'],notes:['教师备注必须保留']},{title:'第二页标题',bullets:['旋转用于调整局部树结构'],notes:[]}]});
  temporary.selectedId=resource.id;await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(temporary),{mode:0o600});
  const explanation=await send('解释第二页内容，不要修改课件',resource.id);assert.equal(explanation.job.mode,'conversation');assert.deepEqual(explanation.after.resources,explanation.before.resources);
  const changed=await send('第2页标题改为关键操作，其他内容保留',resource.id);assert.equal(changed.job.mode,'task');assert.equal(changed.job.execution,'direct');assert.equal(changed.job.plan,null);
  const edited=changed.after.resources.find(r=>r.id===resource.id);assert.equal(currentVersion(edited).content.slides[1].title,'关键操作');assert.deepEqual(currentVersion(edited).content.slides[0],currentVersion(resource).content.slides[0]);assert.equal(edited.versions.length,resource.versions.length+1);
  await fs.mkdir(path.join(root,'artifacts/conversation'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/conversation/live-result.json'),JSON.stringify({recordedAt:new Date().toISOString(),teacherTeachingDataUsed:false,syntheticInputs:true,isolatedStorage:true,results},null,2));
}finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
