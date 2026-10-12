import test from 'node:test';
import assert from 'node:assert/strict';
import { newAgentJob, runTeachingAgent, commitAgentDrafts, publicAgentJob } from '../src/agent.js';
import { readConversationTool } from '../src/conversation.js';
import { emptyWorkspace, createResource, currentVersion } from '../src/workspace.js';

const config = { batchPages:3, maxAgentCalls:12, maxRepairs:0, maxInputChars:115000 };
const passed = {action:'review',passed:true,reply:'目标页面已修改，其它页面保留',issues:[],repairSteps:[]};
function workspace() {
  const state=emptyWorkspace();state.requirements.duration=300;
  const resource=createResource(state,'ppt','原课件',{slides:[{title:'第一页面',bullets:['原理'],notes:['教师备注']},{title:'第二页面',bullets:['操作'],notes:[]}]});
  state.selectedId=resource.id;return {state,resource};
}

test('问候、解释与含无效页码的问题可以直接回答，300分钟背景与失败任务不触发执行',async()=>{
  for(const request of ['你好','平衡树是什么？','第999页是什么意思？']) {
    const {state,resource}=workspace();state.messages.push({role:'user',text:'新建300分钟完整课件',status:'failed',jobId:'old-task'});
    const before=structuredClone(state),job=newAgentJob(state,request,resource.id);let claims=0;
    const result=await runTeachingAgent(job,{config,claimTask:async()=>claims++,call:async(system,input)=>{
      assert.equal(input.phase,'decide');assert.match(system,/不要求先制定计划/);assert.equal(input.materials[0],undefined);
      return {action:'reply',reply:'你好，可以一起讨论课程。',content:{slides:[{title:'不应保存'}]}};
    }});
    assert.deepEqual(result,{action:'reply',reply:'你好，可以一起讨论课程。'});assert.equal(job.calls,1);assert.equal(job.plan,null);assert.equal(claims,0);assert.deepEqual(job.drafts,[]);assert.deepEqual(state,before);
  }
});

test('读页面后解释，读工具结果进入下一轮；未修改资源且历史中包含教师上一轮消息',async()=>{
  const {state,resource}=workspace(),slide=currentVersion(resource).content.slides[1];state.messages.push({role:'user',text:'先聊一下第二页',status:'complete'});
  const job=newAgentJob(state,'这页为何如此安排？',resource.id,slide.id);let calls=0;
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>{
    assert.equal(input.phase,'decide');assert.equal(input.recentConversation[0].text,'先聊一下第二页');
    if(!calls++)return {action:'tool',tool:'resource.read',args:{resourceId:resource.id,pageIds:[slide.id]}};
    assert.deepEqual(input.toolResults[0].data.content.slides,[slide]);return {action:'reply',reply:'这页用于演示操作。'};
  }});
  assert.equal(result.action,'reply');assert.equal(job.calls,2);assert.equal(job.plan,null);assert.equal(resource.versions.length,1);assert.equal(publicAgentJob(job).toolResults,undefined);
});

test('明确的小修改直接执行并检查，不制定全课计划、不要求凑满300分钟',async()=>{
  const {state,resource}=workspace(),before=structuredClone(currentVersion(resource)),target=before.content.slides[1],job=newAgentJob(state,'第2页标题改为关键操作',resource.id);let phase=[];
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>{
    phase.push(input.phase);
    if(input.phase==='review')return passed;
    if(!input.toolResults.length)return {action:'tool',tool:'resource.read',args:{resourceId:resource.id,pageIds:[target.id]}};
    return {action:'update',reply:'修改第二页标题',operations:[{action:'update',slideId:target.id,patch:{title:'关键操作'}}]};
  }});
  assert.deepEqual(phase,['decide','decide','review']);assert.equal(job.execution,'direct');assert.equal(publicAgentJob(job).plan,null);assert.equal(result.action,'agent-commit');assert.equal(resource.versions.length,1);
  commitAgentDrafts(state,job);assert.equal(resource.versions.length,2);assert.deepEqual(currentVersion(resource).content.slides[0],before.content.slides[0]);assert.equal(currentVersion(resource).content.slides[1].title,'关键操作');
});

test('直接操作仍检查页面范围，越界补丁没有草稿和版本副作用',async()=>{
  const {state,resource}=workspace(),slides=currentVersion(resource).content.slides,job=newAgentJob(state,'第2页修改标题',resource.id);
  await assert.rejects(runTeachingAgent(job,{config,call:async()=>({action:'update',reply:'误改第一页',operations:[{action:'update',slideId:slides[0].id,patch:{title:'不允许'}}]})}),/超出教师指定页面/);
  assert.equal(job.drafts.length,0);assert.equal(resource.versions.length,1);assert.equal(currentVersion(resource).content.slides[0].title,'第一页面');
});

test('澄清不创建计划，不接受缺失回复；重复读工具受模型调用额度限制',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'帮我改一下');
  const result=await runTeachingAgent(job,{config,call:async()=>({action:'clarify',reply:'要修改哪份资源的哪一部分？'})});assert.equal(result.action,'clarify');assert.equal(job.plan,null);
  await assert.rejects(runTeachingAgent(newAgentJob(state,'你好'),{config,call:async()=>({action:'reply'})}),/缺少有效回复/);
  const repeat=newAgentJob(state,'看看工作台');await assert.rejects(runTeachingAgent(repeat,{config:{...config,maxAgentCalls:2},call:async()=>({action:'tool',tool:'workspace.read',args:{}})}),/模型调用额度/);assert.equal(repeat.calls,2);assert.equal(repeat.drafts.length,0);
});

test('只读工具限制真实资源、页面、资料偏移和输入大小，不接受写入工具或任意文件路径',async()=>{
  const {state,resource}=workspace();state.materials=[{id:'material-1',status:'parsed',title:'资料',content:'甲乙丙丁戊己'}];const job=newAgentJob(state,'看看资料',resource.id);
  const data=await readConversationTool(job,{tool:'material.read',args:{materialId:'material-1',start:2,length:2}});assert.equal(data.data.text,'丙丁');assert.equal(data.data.nextStart,4);
  for(const call of [{tool:'resource.delete',args:{}},{tool:'resource.read',args:{resourceId:'../.env'}},{tool:'resource.read',args:{pageIds:['missing']}},{tool:'material.read',args:{materialId:'material-1',start:-1}},{tool:'material.read',args:{materialId:'material-1',length:0}},{tool:'resource.read',args:[]}])await assert.rejects(readConversationTool(job,call));
  await assert.rejects(readConversationTool(job,{tool:'resource.read',args:{}},{maxChars:5}),/超过本轮输入额度/);
  const latest=structuredClone(state);latest.requirements.topic='最新课程';const read=await readConversationTool(job,{tool:'workspace.read',args:{}},{readContext:async()=>latest});assert.equal(read.data.requirements.topic,'最新课程');
});

test('教师修订知识点与选中补充进入决定、读取、执行和检查上下文',async()=>{
  const state=emptyWorkspace();state.analysis={chapters:[],objectives:[],knowledgePoints:['教师修订：先讲不变量'],keyPoints:[],difficultPoints:[]};state.analysisSource='teacher';state.supplements=[{title:'教师选中补充',description:'用实际调用展示',source:'教师资料'}];
  const job=newAgentJob(state,'新建完整课件'),seen=[];
  await runTeachingAgent(job,{config,call:async(_,input)=>{
    seen.push(input.phase);assert.deepEqual(input.analysis,state.analysis);assert.deepEqual(input.supplements,state.supplements);
    if(input.phase==='review')return passed;
    if(input.phase==='execute')return {action:'create',type:'ppt',name:'新课件',reply:'完成',content:{slides:[{title:'不变量',bullets:['正文']}]}};
    if(!input.toolResults.length)return {action:'tool',tool:'workspace.read',args:{}};
    assert.deepEqual(input.toolResults[0].data.analysis,state.analysis);
    return {action:'plan',reply:'讲解不变量',steps:[{id:'create',title:'不变量',tool:'ppt.create',instructions:'生成一页',pages:1,minutes:45}]};
  }});assert.deepEqual(seen,['decide','decide','execute','review']);
});

test('指定页可以关联小游戏，实际关联页仍受范围校验保护',async()=>{
  const {sampleActivities}=await import('../src/samples.js');
  for(const correct of [true,false]){
    const {state,resource}=workspace(),slides=currentVersion(resource).content.slides,game=createResource(state,'game','示例互动',sampleActivities[0]);
    const job=newAgentJob(state,'把小游戏放到当前PPT第2页',resource.id),call=async(_,input)=>input.phase==='review'?passed:{action:'attach',reply:'关联互动',pptId:resource.id,activityId:game.id,slideId:slides[correct?1:0].id};
    if(!correct){await assert.rejects(runTeachingAgent(job,{config,call}),/超出教师指定页面/);assert.equal(job.drafts.length,0);continue;}
    await runTeachingAgent(job,{config,call});commitAgentDrafts(state,job);
    assert.equal(currentVersion(resource).content.slides[1].attachment.resourceId,game.id);assert.equal(currentVersion(resource).content.slides[0].attachment,undefined);
  }
});

test('基于指定页新建独立小游戏不被误当成修改原PPT',async()=>{
  const {sampleActivities}=await import('../src/samples.js');const {state,resource}=workspace(),before=structuredClone(resource),job=newAgentJob(state,'根据第2页新建小游戏',resource.id);
  await runTeachingAgent(job,{config,call:async(_,input)=>input.phase==='review'?passed:{action:'create',type:'game',name:'新小游戏',content:sampleActivities[0],reply:'已新建'}});
  commitAgentDrafts(state,job);assert.deepEqual(resource,before);assert.equal(state.resources.length,2);assert.equal(state.resources[1].type,'game');
});

test('两处页码与连续页范围正确识别，分批只允许修改当前批次目标',async()=>{
  const {scopeFor}=await import('../src/agent.js');
  const state=emptyWorkspace(),r=createResource(state,'ppt','六页课件',{slides:Array.from({length:6},(_,i)=>({title:'原页'+i,bullets:[],notes:[]}))});state.selectedId=r.id;
  const slides=currentVersion(r).content.slides;
  for(const request of ['第2页和第3页','第2、3页','第2页到第3页','第2至3页'])assert.deepEqual(scopeFor(state,request,r.id),[slides[1].id,slides[2].id]);
  for(const request of ['第0页','第2至999999999页','第4至2页'])assert.throws(()=>scopeFor(state,request,r.id));
  const job=newAgentJob(state,'把第2页到第5页的标题改短',r.id),executed=[];
  await runTeachingAgent(job,{config,call:async(_,input)=>{
    if(input.phase==='review')return passed;
    if(input.phase==='decide')return {action:'plan',reply:'分批改标题',steps:[{id:'edit',title:'标题修改',tool:'ppt.update',resourceId:r.id,targetIds:slides.slice(1,5).map(s=>s.id),instructions:'只改标题',pages:4,minutes:0}]};
    executed.push(input.task.targetIds);return {action:'update',reply:'标题已缩短',operations:input.task.targetIds.map(slideId=>({action:'update',slideId,patch:{title:'简短标题'}}))};
  }});assert.deepEqual(executed.map(ids=>ids.length),[3,1]);commitAgentDrafts(state,job);assert.equal(currentVersion(r).content.slides[0].title,'原页0');assert.equal(currentVersion(r).content.slides[5].title,'原页5');assert.ok(currentVersion(r).content.slides.slice(1,5).every(s=>s.title==='简短标题'));
});

test('300分钟课程批量修改六页标题不触发重新安排全课课时',async()=>{
  const state=emptyWorkspace();state.requirements.duration=300;const r=createResource(state,'ppt','六页课件',{slides:Array.from({length:6},(_,i)=>({title:'旧标题'+i,bullets:['保留正文']}))});state.selectedId=r.id;
  const ids=currentVersion(r).content.slides.map(s=>s.id),job=newAgentJob(state,'把当前课件所有页的标题改得简洁',r.id);
  await runTeachingAgent(job,{config,call:async(_,input)=>{
    if(input.phase==='decide')return {action:'plan',courseMode:'partial',reply:'简化标题',steps:[{id:'edit',title:'简化标题',tool:'ppt.update',resourceId:r.id,targetIds:ids,instructions:'只改标题',pages:6,minutes:0}]};
    if(input.phase==='review'){assert.match(input.reviewScope,/不.*补足授课分钟数/);return passed;}
    return {action:'update',reply:'已改',operations:input.task.targetIds.map(slideId=>({action:'update',slideId,patch:{title:'简洁标题'}}))};
  }});assert.equal(job.plan.fullCourse,false);assert.equal(job.calls,4);commitAgentDrafts(state,job);assert.ok(currentVersion(r).content.slides.every(s=>s.title==='简洁标题'&&s.bullets[0]==='保留正文'));
});

test('长历史自动缩略后问候成功，完整历史可补读，所有实际请求符合输入额度',async()=>{
  const state=emptyWorkspace();state.messages=Array.from({length:12},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',text:'模拟历史'.repeat(2500),status:'complete'}));const before=structuredClone(state);
  let fetches=0;const job=newAgentJob(state,'你好');
  await runTeachingAgent(job,{config:{...config,apiKey:'fixture',fetch:async(_,options)=>{fetches++;const messages=JSON.parse(options.body).messages;assert.ok(messages.reduce((n,m)=>n+m.content.length,0)<=config.maxInputChars);const input=JSON.parse(messages[1].content);assert.equal(input.request,'你好');assert.ok(input.contextOmissions.length);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"action":"reply","reply":"你好！"}'}}]})};}}});
  assert.equal(fetches,1);assert.equal(job.calls,1);assert.deepEqual(state,before);
  const read=await readConversationTool(job,{tool:'conversation.read',args:{messageId:'message-0',start:600,length:2000}});assert.equal(read.data.text,before.messages[0].text.slice(600,2600));assert.equal(read.data.totalCharacters,10000);
  state.analysis={knowledgePoints:['完整教师修订']};job.input=state;const context=await readConversationTool(job,{tool:'context.read',args:{}});assert.match(context.data.text,/完整教师修订/);
});

test('选中小游戏时也能关联PPT指定页，范围绑定实际PPT且拒绝错误页',async()=>{
  const {sampleActivities}=await import('../src/samples.js');for(const correct of [true,false]){
    const {state,resource:ppt}=workspace(),game=createResource(state,'game','小游戏',sampleActivities[0]);state.selectedId=game.id;const slides=currentVersion(ppt).content.slides,job=newAgentJob(state,'把小游戏放到PPT第2页',game.id);
    const call=async(_,input)=>input.phase==='review'?passed:{action:'attach',reply:'关联第二页',pptId:ppt.id,activityId:game.id,slideId:slides[correct?1:0].id};
    if(!correct){await assert.rejects(runTeachingAgent(job,{config,call}),/超出教师指定页面/);assert.equal(job.drafts.length,0);continue;}
    await runTeachingAgent(job,{config,call});commitAgentDrafts(state,job);assert.equal(job.scopeResourceId,ppt.id);assert.equal(currentVersion(ppt).content.slides[1].attachment.resourceId,game.id);
  }
});

test('六页直接标题补丁自动拆批，检查前无额外模型调用，最终原子保存一个版本',async()=>{
  const state=emptyWorkspace();state.requirements.duration=300;const r=createResource(state,'ppt','原课件',{slides:Array.from({length:6},(_,i)=>({title:'原页'+i,bullets:['保留正文'],notes:['保留备注']}))});state.selectedId=r.id;const original=structuredClone(currentVersion(r)),ids=original.content.slides.map(s=>s.id),job=newAgentJob(state,'把当前课件所有页的标题改为简洁标题',r.id),phases=[];
  await runTeachingAgent(job,{config,call:async(_,input)=>{phases.push(input.phase);if(input.phase==='review')return passed;assert.equal(input.phase,'decide');return {action:'update',reply:'批量修改标题',operations:ids.map(slideId=>({action:'update',slideId,patch:{title:'简洁标题'}}))};}});
  assert.deepEqual(phases,['decide','review']);assert.equal(job.execution,'direct');assert.equal(job.cursor,2);assert.deepEqual(job.tasks.map(t=>t.pageCount),[3,3]);assert.deepEqual(currentVersion(r),original);assert.equal(publicAgentJob(job).pendingCandidates,undefined);
  commitAgentDrafts(state,job);assert.equal(r.versions.length,2);assert.ok(currentVersion(r).content.slides.every(s=>s.title==='简洁标题'&&s.bullets[0]==='保留正文'&&s.notes[0]==='保留备注'));
});
