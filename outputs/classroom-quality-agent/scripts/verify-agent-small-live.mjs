// Exercise the real model through the autonomous API in an isolated workspace.
// The teacher's live workspace, model settings, and classroom data stay intact.
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
const root=new URL('..',import.meta.url).pathname;
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const config={...await new ModelSettings(path.join(root,'data')).read(),batchPages:2,maxAgentCalls:40,maxPlanSteps:8,maxRepairs:3};
const hash=async name=>createHash('sha256').update(await fs.readFile(path.join(root,'data',name))).digest('hex');
const before={workspace:await hash('workspace.json'),classroom:await hash('classroom.json')};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-agent-live-'));
const api=createApi(root,{dataDir:dir,modelSettings:{read:async()=>config}});
const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},e.statusCode||500);}});
try{
  const state=emptyWorkspace();state.requirements={topic:'排序稳定性',audience:'本科一年级',duration:30,instructions:'明确区分比较与交换；用两个相同关键字且带原序号的元素说明稳定性。'};
  state.materials=[{id:'source-example',title:'验证用短教材',type:'文本',status:'parsed',content:`# 排序稳定性
稳定排序保持相同关键字元素的原相对顺序。比较只判断大小，交换才改变位置。
## 统一循环规则
本课采用未提前退出的标准升序冒泡：outer=0..n-2，inner=0..n-outer-2。仅当 key[inner]>key[inner+1] 时交换，下一趟比较范围缩小一位。
## 正例完整演算
输入 [(2,A),(1,B),(2,C)]。第1趟比较(2,A)/(1,B)，交换为[(1,B),(2,A),(2,C)]；比较(2,A)/(2,C)，相等不交换。第2趟只比较(1,B)/(2,A)，不交换，终态[(1,B),(2,A),(2,C)]，A仍在C之前。
## 最小反例
把交换条件错误改成>=，输入只有[(2,A),(2,C)]，n=2，因此只有1趟1次比较。2>=2成立，交换后终态[(2,C),(2,A)]，相等关键字原序颠倒，说明该变体不稳定。不要将这组输入换成复杂三元素反例。
## 练习及答案
输入[(3,X),(1,Y),(3,Z),(2,W)]，正确交换条件>。第1趟：3>1交换，3>3不交换，3>2交换，趟末[(1,Y),(3,X),(2,W),(3,Z)]。第2趟只比较前3项：1>3不交换；3>2交换，趟末[(1,Y),(2,W),(3,X),(3,Z)]。第3趟只比较前2项：1>2不成立，不交换。终态[(1,Y),(2,W),(3,X),(3,Z)]，X仍在Z前，稳定。
教师每个练习明确输入、循环边界、每步结果与答案，不混用不同冒泡变体。`}];
  await fs.writeFile(path.join(dir,'workspace.json'),JSON.stringify(state),{mode:0o600});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/workspace/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,request:'新建30分钟排序稳定性PPT，自主规划原理与实操两个教学阶段。讲清稳定性的定义与交换条件，用带原序号的相同关键字元素给出具体冒泡排序过程、反例和练习答案。反例使用教材的两个相同关键字最小输入，所有演算严格使用教材的n-1趟与缩短内循环边界，练习采用教材固定输入。只生成PPT，无需互动资源；不限制实际展示页数。'})});
  assert.equal(response.status,202);const {job:first}=await response.json();let job;
  for(let i=0;i<240;i++){
    job=await(await fetch(base+'/api/workspace/agent/'+first.id)).json();if(['completed','failed','paused'].includes(job.stage))break;
    if(i%10===0)console.log(JSON.stringify({stage:job.stage,batches:job.completedBatches+'/'+job.totalBatches,calls:job.calls}));await new Promise(r=>setTimeout(r,2000));
  }
  const result=await(await fetch(base+'/api/workspace')).json();
  const draft=await(await fetch(base+'/api/workspace/agent/'+first.id+'/draft')).json();
  await fs.writeFile(path.join(root,'artifacts/agent/small-live-draft.json'),JSON.stringify(draft,null,2));
  assert.equal(before.workspace,await hash('workspace.json'));assert.equal(before.classroom,await hash('classroom.json'));
  const report={recordedAt:new Date().toISOString(),stage:job.stage,model:job.model,plan:job.plan,calls:job.calls,repairRounds:job.repairRound,completedBatches:job.completedBatches,totalBatches:job.totalBatches,review:job.review,error:job.error,resources:result.resources.map(r=>({id:r.id,name:r.name,versionCount:r.versions.length,content:currentVersion(r).content})),teacherWorkspaceUnchanged:true,classroomUnchanged:true};
  await fs.mkdir(path.join(root,'artifacts/agent'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/agent/small-live-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,plan:undefined,review:undefined,resources:report.resources.map(r=>({name:r.name,pages:r.content.slides.length,versions:r.versionCount}))},null,2));
  assert.equal(job.stage,'completed');assert.equal(job.review.passed,true);assert.ok(job.plan.steps.length>=2);assert.ok(job.completedBatches>=2);assert.ok(job.calls>=4);assert.equal(result.resources.length,1);assert.equal(result.resources[0].versions.length,1);
  await fs.writeFile(path.join(root,'artifacts/agent/small-live-ppt.md'),toMarkdown(currentVersion(result.resources[0]).content.slides,{confirmedOnly:false}));
}finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
