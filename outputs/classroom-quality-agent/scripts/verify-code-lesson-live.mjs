// Real model, isolated data. Only generation; source is inspected before execution.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApi,json} from '../src/api.js';
import {ModelSettings} from '../src/modelSettings.js';
import {emptyWorkspace,currentVersion} from '../src/workspace.js';
import {toMarkdown} from '../src/pptGenerator.js';
import {requestJSON} from '../src/model.js';
const root=new URL('..',import.meta.url).pathname;
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const config={...await new ModelSettings(path.join(root,'data')).read(),batchPages:2,maxAgentCalls:40,maxPlanSteps:10,maxRepairs:2};
const hash=async name=>createHash('sha256').update(await fs.readFile(path.join(root,'data',name))).digest('hex');
const before={workspace:await hash('workspace.json'),classroom:await hash('classroom.json')};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'code-lesson-live-')),artifact=path.join(root,'artifacts/code-lesson');
await fs.mkdir(artifact,{recursive:true});
let modelCalls=0;
const api=createApi(root,{dataDir:dir,modelSettings:{read:async()=>config},modelCall:async(system,input,settings)=>{
  const result=await requestJSON(system,input,settings);
  await fs.writeFile(path.join(artifact,'model-'+Date.now()+'-'+(++modelCalls)+'-'+input.phase+'.json'),JSON.stringify(result,null,2));return result;
}});
const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},e.statusCode||500);}});
try{
  const previous=process.argv.includes('--resume')?JSON.parse(await fs.readFile(path.join(artifact,'checkpoint.json'),'utf8')):null;
  const state=previous?structuredClone(previous.input):emptyWorkspace();state.requirements={topic:'单调队列与滑动窗口最大值',audience:'本科二年级',duration:30,instructions:'主要讲原理、数据表示和C++17实现，少量验证输入即可，不要习题集、代码填空或反复手算。'};
  state.materials=[{id:'source',title:'验证教材',type:'文本',status:'parsed',content:'# 单调队列\n队列存下标，值从队首到队尾单调不增。处理下标i时，先从队首删除<=i-k的过期下标，再从队尾删除值<=a[i]的旧下标（新下标同值但更晚过期），最后入队i。当i>=k-1，输出队首对应的值。每个下标最多入队出队一次，时间O(n)，辅助空间O(k)。接口输入vector<int>和窗口大小k，k<=0或k>n时返回空vector。只需一个验证输入a=[2,1,4,3]，k=2，输出2 4 4。使用标准库vector/deque/iostream，提供函数和main调用即可，不使用bits/stdc++.h以支持macOS clang。'}];
  await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(state),{mode:0o600});
  if(previous){state.messages.push({id:previous.messageId,jobId:previous.id,role:'user',text:previous.request,status:'failed'});await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(state),{mode:0o600});await fs.writeFile(path.join(dir,'agent-'+previous.id+'.json'),JSON.stringify(previous),{mode:0o600});}
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const request='新建30分钟单调队列课程PPT。自主规划，以核心原理、数据表示、操作机制、复杂度和C++17示例代码为主。提供能直接编译运行的滑动窗口最大值函数和main调用，用教材唯一输入验证输出2 4 4。讲清过期与同值处理即可，不要例题集、独立练习答案、反复手算或额外变体。不限制课件页数，但避免重复。';
  const response=await fetch(base+'/api/workspace/agent'+(previous?'/'+previous.id+'/resume':''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(previous?{}:{revision:0,request})});assert.equal(response.status,202);const {job:first}=await response.json();let job;
  for(let i=0;i<300;i++){
    job=await(await fetch(base+'/api/workspace/agent/'+first.id)).json();if(['completed','failed','paused'].includes(job.stage))break;
    if(i%10===0)console.log(JSON.stringify({stage:job.stage,batches:job.completedBatches+'/'+job.totalBatches,calls:job.calls,pages:job.draftPages}));await new Promise(r=>setTimeout(r,2000));
  }
  const workspace=await(await fetch(base+'/api/workspace')).json(),draft=await(await fetch(base+'/api/workspace/agent/'+first.id+'/draft')).json();
  await fs.writeFile(path.join(artifact,'draft.json'),JSON.stringify(draft,null,2));
  await fs.copyFile(path.join(dir,'agent-'+first.id+'.json'),path.join(artifact,'checkpoint.json'));
  assert.equal(before.workspace,await hash('workspace.json'));assert.equal(before.classroom,await hash('classroom.json'));
  const slides=draft.resources.flatMap(r=>r.type==='ppt'?r.content.slides:[]),blocks=new Map();
  for(const s of slides.filter(s=>s.code&&s.code.kind!=='output')){const key=s.code.blockId||s.id;if(!blocks.has(key))blocks.set(key,[]);blocks.get(key).push(s.code.source);}
  let index=0;for(const parts of blocks.values())await fs.writeFile(path.join(artifact,'code-'+(++index)+'.cpp'),parts.join(''));
  const report={recordedAt:new Date().toISOString(),stage:job.stage,model:job.model,calls:job.calls,repairRounds:job.repairRound,plan:job.plan,review:job.review,error:job.error,pages:slides.length,codePages:slides.filter(s=>s.code?.kind!=='output'&&s.code).length,codeBlocks:blocks.size,exercisePages:slides.filter(s=>/练习|例题|答案讲评/.test(s.title)).length,committedResources:workspace.resources.length,teacherWorkspaceUnchanged:true,classroomUnchanged:true};
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(artifact,'lesson.md'),toMarkdown(slides));
  console.log(JSON.stringify({...report,plan:undefined,review:undefined},null,2));
  assert.equal(job.stage,'completed');assert.equal(job.review.passed,true);assert.ok(blocks.size);assert.equal(report.exercisePages,0);assert.equal(workspace.resources.length,1);
}finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
