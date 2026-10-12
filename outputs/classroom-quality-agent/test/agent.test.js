import test from 'node:test';
import assert from 'node:assert/strict';
import { materialIndex,newAgentJob,runTeachingAgent,commitAgentDrafts,publicAgentJob } from '../src/agent.js';
import { emptyWorkspace,createResource,currentVersion,applyWorkspaceCommand } from '../src/workspace.js';
import { AppError,clone } from '../src/store.js';
import { sampleActivities } from '../src/samples.js';
import { createHash } from 'node:crypto';

const config={batchPages:3,maxAgentCalls:100,maxPlanSteps:60,maxRepairs:2,maxInputChars:115000};
const page=title=>({section:'讲解',title,bullets:['原理','练习步骤'],notes:['教师讲解']});
const step=(extra={})=>({id:'lesson',title:'原理与实操',tool:'ppt.create',resourceId:'current',targetIds:[],instructions:'讲解后安排练习',topics:['排序'],sourceIds:[],minutes:45,pages:6,...extra});
const plan=steps=>({action:'plan',goal:'可实操的教学',reply:'计划',steps});
const passed={action:'review',passed:true,reply:'检查通过',issues:[],repairSteps:[]};
function createFor(input){return {action:'create',type:'ppt',name:'教学课件',reply:'本批已完成',content:{slides:Array.from({length:input.task.pageCount},(_,i)=>page('新页 '+(input.task.pageStart+i)))}};}
function addFor(input){return {action:'update',reply:'本批已完成',operations:Array.from({length:input.task.pageCount},(_,i)=>({action:'add',slide:page('新页 '+(input.task.pageStart+i))}))};}

test('自动修正返回相同补丁时重新检查，不重复写入或声称已修正',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件');let reviews=0,repairs=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);
    if(input.phase==='review'){
      if(reviews++){assert.equal(input.unchangedRepairs.length,1);assert.match(input.unchangedRepairs[0].text,/不据此声称已修正/);return passed;}
      const r=job.drafts[0],p=currentVersion(r).content.slides[0];
      return {action:'review',passed:false,reply:'检查要点',issues:['需核对原理说明'],repairSteps:[step({tool:'ppt.update',resourceId:r.id,targetIds:[p.id],pages:1,minutes:0,instructions:'核对原理说明'})]};
    }
    if(!job.repairRound)return createFor(input);
    repairs++;const p=input.resource.content.slides[0];return {action:'update',reply:'该说明已存在',operations:[{action:'update',slideId:p.id,patch:{bullets:p.bullets}}]};
  }});
  assert.equal(repairs,1);assert.equal(reviews,2);assert.equal(job.review.passed,true);
  assert.equal(job.drafts[0].versions.length,1);
});

test('相同修正补丁不能绕过仍未通过的独立检查，轮次耗尽时保留草稿',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件');let reviews=0;
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxRepairs:1},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);
    if(input.phase==='review'){
      reviews++;const r=job.drafts[0],p=currentVersion(r).content.slides[0];return {action:'review',passed:false,reply:'尚未满足目标',issues:['缺少必要说明'],repairSteps:[step({tool:'ppt.update',resourceId:r.id,targetIds:[p.id],pages:1,minutes:0})]};
    }
    if(!job.repairRound)return createFor(input);
    const p=input.resource.content.slides[0];return {action:'update',reply:'未修改',operations:[{action:'update',slideId:p.id,patch:{title:p.title}}]};
  }}),/自动修正轮次/);
  assert.equal(reviews,2);assert.equal(job.review.passed,false);assert.equal(job.drafts[0].versions.length,1);
});

test('反复格式失败保持逻辑批次和草稿，诊断可供恢复任务定位',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件');let calls=0;
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxRepairs:1},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:3})]);
    calls++;assert.equal(input.task.pageCount,3);
    throw Object.assign(new AppError('结构无效',502),{code:'MODEL_FORMAT',details:{reason:'invalid-json',responseCharacters:30,finishReason:'stop'}});
  }}),/暂未完成/);
  assert.equal(calls,2);assert.equal(job.tasks.length,1);assert.equal(job.drafts.length,0);assert.equal(job.lastModelFailure.reason,'invalid-json');
});

test('代码实现步骤必须产出真实代码，普通例子不算实现；缺代码反馈后修正',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件，提供示例代码');let executions=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1,focus:'implementation',needsCode:true})]);
    if(input.phase==='review')return passed;
    if(!executions++)return createFor(input);
    assert.match(input.feedback,/code.source/);
    return {action:'create',type:'ppt',name:'实现',reply:'提供代码',content:{slides:[{...page('实现'),code:{language:'cpp',source:'int square(int x) { return x * x; }'}}]}};
  }});
  assert.equal(executions,2);commitAgentDrafts(state,job);assert.ok(currentVersion(state.resources[0]).content.slides.some(s=>s.code));
});

test('只修正预期输出可保留已有源码，不要求改写扩展范围内的正确代码页；输出优先的小批次也能合并',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件，提供示例代码');let repairs=0;
  const source='int square(int x) { return x * x; }\n';
  await runTeachingAgent(job,{config:{...config,batchPages:1},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1,needsCode:true,focus:'implementation'})]);
    if(input.phase==='review'){
      assert.match(system,/同一页和同一个代码块可以包含多个完整函数/);
      if(job.repairRound)return passed;
      const r=job.drafts[0],output=currentVersion(r).content.slides.find(s=>s.code?.kind==='output');
      return {action:'review',passed:false,reply:'只改输出',issues:['示例输出标注有误'],repairSteps:[step({tool:'ppt.update',resourceId:r.id,targetIds:[output.id],pages:1,minutes:0,focus:'demonstration',needsCode:true,instructions:'修正预期输出，将输出由 8 改为 9，保留程序'})]};
    }
    if(!job.repairRound)return {action:'create',type:'ppt',name:'实现',reply:'生成代码',content:{slides:[{title:'实现',bullets:[],notes:[],code:{language:'cpp',source,expectedOutput:'8'}}]}};
    repairs++;const output=input.resource.content.slides.find(s=>s.code?.kind==='output');
    assert.deepEqual(input.task.requiredTargetIds,[output.id]);assert.equal(input.task.targetIds.length,2);assert.equal(input.codeContext[0].source,source);
    assert.match(system,/已有源码可以保留/);
    return {action:'update',reply:'只修正输出文本',operations:[{action:'update',slideId:output.id,patch:{code:{source:'9'}}}]};
  }});
  assert.equal(repairs,1);const slides=currentVersion(job.drafts[0]).content.slides;
  assert.equal(slides.find(s=>s.code?.kind==='output').code.source,'9');assert.equal(slides.find(s=>s.code&&s.code.kind!=='output').code.source,source);assert.equal(job.review.passed,true);
});

test('输出文本不能冒充源码，不能借用无关程序满足代码要求，失败候选不保存',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','输出与无关程序',{slides:[{title:'输出',bullets:[],notes:[],code:{language:'text',kind:'output',blockId:'output-only',source:'8'}},{title:'无关程序',bullets:[],notes:[],code:{language:'cpp',blockId:'unrelated',source:'int other() { return 1; }'}}]});
  const old=clone(currentVersion(r)),output=old.content.slides[0],job=newAgentJob(state,'修正课件',r.id);job.repairRound=1;
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxRepairs:0},call:async(system,input)=>input.phase==='decide'?plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[output.id],pages:1,needsCode:true,focus:'demonstration',instructions:'修正预期输出'})]):{action:'update',reply:'改输出',operations:[{action:'update',slideId:output.id,patch:{code:{source:'9'}}}]} }),/没有程序源码/);
  assert.deepEqual(currentVersion(r),old);assert.equal(job.drafts.length,0);
});

test('旧检查点的输出修正恢复后只更新输出，保留源码，不重复新建课件',async()=>{
  const state=emptyWorkspace(),source='int main() { return 0; }\n',r=createResource(state,'ppt','旧草稿',{slides:[{title:'程序',bullets:[],notes:[],code:{language:'cpp',source,expectedOutput:'8'}}]}),slides=currentVersion(r).content.slides,output=slides.find(s=>s.code?.kind==='output');
  const job=newAgentJob(state,'修正课件',r.id);job.repairRound=2;job.plan=plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[output.id],pages:1})]);
  job.tasks=[{...step({tool:'ppt.update',resourceId:r.id,targetIds:[output.id,slides[0].id],pages:2,needsCode:true,focus:'demonstration',instructions:'将输出块中的输出由 8 改为 9'}),taskId:'legacy-repair',part:1,parts:1,pageStart:1,pageCount:2,attempts:0,feedback:'上次执行未提交：本步骤要求真实示例代码，但没有返回code.source。'}];
  let executions=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{if(input.phase==='review')return passed;executions++;assert.deepEqual(input.task.requiredTargetIds,[output.id]);assert.equal(input.feedback,'');return {action:'update',reply:'仅更新输出',operations:[{action:'update',slideId:output.id,patch:{code:{source:'9'}}}]};}});
  assert.equal(executions,1);assert.equal(job.drafts.length,1);assert.equal(currentVersion(job.drafts[0]).content.slides.find(s=>s.code?.kind==='output').code.source,'9');assert.equal(currentVersion(job.drafts[0]).content.slides[0].code.source,source);assert.equal(currentVersion(r).content.slides.at(-1).code.source,'8');
});

test('格式错误给出转义反馈并保持完整代码修正批次，不按输出超限拆页',async()=>{
  const state=emptyWorkspace(),source='int main() { return 0; }\n',r=createResource(state,'ppt','拆批',{slides:[{title:'程序',bullets:[],notes:[],code:{language:'cpp',source,expectedOutput:'8'}}]}),slides=currentVersion(r).content.slides,output=slides.find(s=>s.code.kind==='output'),program=slides.find(s=>s.code.kind!=='output'),job=newAgentJob(state,'修正课件',r.id);job.repairRound=1;let executions=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[output.id,program.id],pages:2,needsCode:true,instructions:'修正两页的说明'})]);if(input.phase==='review')return passed;
    if(!executions++){const error=new Error('输出格式不完整');error.code='MODEL_FORMAT';throw error;}
    assert.equal(input.task.pageCount,2);assert.equal(input.task.requiredTargetIds.length,2);assert.deepEqual(input.task.requiredTargetIds,input.task.targetIds);assert.match(input.feedback,/正确转义/);
    return {action:'update',reply:'修正本批页面',operations:input.resource.content.slides.map(p=>({action:'update',slideId:p.id,patch:p.code.kind==='output'?{code:{source:'9'}}:{notes:['只修正源码页的说明']}}))};
  }});
  assert.equal(executions,2);assert.equal(job.tasks.length,1);assert.equal(job.review.passed,true);assert.equal(currentVersion(job.drafts[0]).content.slides.find(s=>s.code.kind!=='output').code.source,source);
});

test('修改代码讲解主页时可保留其自动分页的完整程序，不借用无关源码',async()=>{
  const state=emptyWorkspace(),source='int main() { return 0; }\n',r=createResource(state,'ppt','讲解与程序',{slides:[{title:'原理及程序',bullets:['数据表示'],notes:[],code:{language:'cpp',source,expectedOutput:'0'}}]}),head=currentVersion(r).content.slides[0],job=newAgentJob(state,'补充调用说明',r.id);
  assert.equal(head.code,undefined);
  await runTeachingAgent(job,{config,call:async(system,input)=>{if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[head.id],pages:1,needsCode:true,focus:'demonstration'})]);if(input.phase==='review')return passed;assert.equal(input.codeContext[0].source,source);assert.equal(input.codeContext[0].canReplaceBlock,false);return {action:'update',reply:'只改讲解',operations:[{action:'update',slideId:head.id,patch:{notes:['补充程序调用方法']}}]};}});
  assert.equal(job.review.passed,true);assert.equal(currentVersion(job.drafts[0]).content.slides.find(s=>s.code&&s.code.kind!=='output').code.source,source);
});

test('检查通过时允许省略空修正列表，仍不允许矛盾的通过结果',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>input.phase==='decide'?plan([step({pages:1})]):input.phase==='review'?{action:'review',passed:true,reply:'原理与代码一致',issues:[],suggestions:['可选排版改进']}:createFor(input)});
  assert.equal(result.action,'agent-commit');assert.equal(job.calls,3);assert.equal(job.review.passed,true);assert.equal(job.repairRound,0);
});

test('后续步骤可引用先前更新的同一资源，不误认为必须新建资源',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','原课件',{slides:[page('原理')]}),job=newAgentJob(state,'重构课件',r.id);
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({id:'concept',tool:'ppt.update',resourceId:r.id,pages:1,minutes:20,targetIds:[currentVersion(r).content.slides[0].id]}),step({id:'more',tool:'ppt.update',resourceId:'step:concept',pages:1,minutes:25})]);
    if(input.phase==='review')return {...passed,repairSteps:undefined};
    if(input.task.id==='concept')return {action:'update',reply:'原理改写',operations:[{action:'update',slideId:input.task.targetIds[0],patch:{title:'清晰原理'}}]};
    assert.equal(input.task.resourceId,r.id);return addFor(input);
  }});
  commitAgentDrafts(state,job);assert.equal(state.resources.length,1);assert.equal(currentVersion(r).content.slides.length,2);
});

test('步骤提前覆盖代码与原理时，后续空范围批次可省略，不为凑页数重复生成',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建提供示例代码的课件');let executions=0;
  await runTeachingAgent(job,{config:{...config,batchPages:1},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:2,needsCode:true})]);
    if(input.phase==='review')return passed;
    if(executions++){assert.ok(input.stepProgress.coveredPages.some(p=>p.hasCode));return {action:'advice',reply:'本步骤原理和实现均已覆盖，不追加重复内容'};}
    return {action:'create',type:'ppt',name:'实现',reply:'原理与完整代码已覆盖',content:{slides:[{...page('实现'),code:{language:'cpp',source:'int f() { return 1; }'}}]}};
  }});
  assert.equal(job.cursor,2);assert.ok(job.observations.some(o=>o.kind==='tool-skip'));assert.equal(job.review.passed,true);
  commitAgentDrafts(state,job);assert.equal(currentVersion(state.resources[0]).content.slides.length,2);
});

test('代码实际校验失败不留下创建ID或候选，反馈修正后才保存，不能绕过编译检查通过',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建提供示例代码的课件');let executions=0,checks=0;
  await runTeachingAgent(job,{config,codeCheck:async()=>++checks===1?{status:'failed',diagnostic:'duplicate main'}:{status:'passed',scope:'syntax-only'},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1,needsCode:true})]);
    if(input.phase==='review'){assert.equal(input.codeChecks[0].status,'passed');return passed;}
    if(executions++){assert.equal(Object.keys(job.created).length,0);assert.equal(job.drafts.length,0);assert.match(input.feedback,/duplicate main/);}
    return {action:'create',type:'ppt',name:'实现',reply:'实现',content:{slides:[{...page('代码'),code:{language:'cpp',source:'int main() { return '+executions+'; }'}}]}};
  }});
  assert.equal(executions,2);assert.equal(job.drafts.length,1);assert.equal(Object.keys(job.created).length,1);assert.equal(publicAgentJob(job).codeChecks,undefined);
});

test('资料索引完整保留正文和准确偏移，超长段落不丢失',()=>{
  const content='# 排序\n'+('正文'.repeat(6200))+'\n## 实操\n练习';
  const chunks=materialIndex([{id:'source',title:'教材',status:'parsed',content}]);
  assert.equal(chunks.map(c=>c.text).join(''),content);
  for(const c of chunks){assert.equal(c.text,content.slice(c.start,c.end));assert.ok(c.text.length<=5000);}
});

test('跨页程序的已有编译错误可分批修复，完整代码上下文只读，最终检查仍拒绝错误',async()=>{
  const state=emptyWorkspace(),source='// BAD_A\n'+Array.from({length:25},(_,i)=>'// line '+i+'\n').join('')+'// BAD_B\n';
  const r=createResource(state,'ppt','已有错误程序',{slides:[{section:'代码',title:'程序',bullets:[],notes:[],code:{language:'cpp',source}}]});
  const original=clone(currentVersion(r)),parts=original.content.slides.filter(s=>s.code),job=newAgentJob(state,'修正课件',r.id);job.repairRound=1;
  assert.equal(parts.length,2);let checked=0;
  await runTeachingAgent(job,{config,codeCheck:async code=>{checked++;return code.source.includes('BAD_')?{status:'failed',diagnostic:'remaining error'}:{status:'passed'};},call:async(system,input)=>{
    if(input.phase==='decide')return plan(parts.map((p,i)=>step({id:'fix'+i,tool:'ppt.update',resourceId:r.id,targetIds:[p.id],pages:1,minutes:i?25:20})));
    if(input.phase==='review'){assert.equal(input.codeChecks[0].status,'passed');return passed;}
    assert.equal(input.codeContext.length,1);assert.equal(input.codeContext[0].readOnly,true);assert.deepEqual(input.codeContext[0].pageIds,parts.map(p=>p.id));
    const p=input.resource.content.slides[0];
    return {action:'update',reply:'修正本段',operations:[{action:'update',slideId:p.id,patch:{code:{source:p.code.source.replace(/BAD_[AB]/g,'OK')}}}]};
  }});
  assert.ok(checked>=3);assert.ok(job.observations.some(o=>o.kind==='code-repair'));assert.deepEqual(currentVersion(r),original);
  commitAgentDrafts(state,job);assert.equal(currentVersion(r).content.slides.some(s=>s.code?.source.includes('BAD_')),false);
});

test('同一步骤修正同一程序的相邻分段时合并提交，避免修改函数首尾的中间态失败',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','跨页代码',{slides:[{title:'程序',bullets:[],notes:[],code:{language:'cpp',source:Array.from({length:30},(_,i)=>'// old '+i+'\n').join('')}}]});
  const ids=currentVersion(r).content.slides.map(s=>s.id),job=newAgentJob(state,'修正课件',r.id);job.repairRound=1;let executions=0;
  await runTeachingAgent(job,{config:{...config,batchPages:1},codeCheck:async c=>c.source.includes('old')&&c.source.includes('new')?{status:'failed',diagnostic:'mixed fragments'}:{status:'passed'},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:ids,pages:2})]);
    if(input.phase==='review')return passed;
    executions++;assert.deepEqual(input.task.targetIds,ids);
    return {action:'update',reply:'一起修正函数首尾',operations:input.resource.content.slides.map(s=>({action:'update',slideId:s.id,patch:{code:{source:s.code.source.replaceAll('old','new')}}}))};
  }});assert.equal(executions,1);assert.equal(job.review.passed,true);
});

test('修正合并源码和输出分段后可整体替换，未覆盖全程序的范围拒绝替换',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','程序',{slides:[{title:'程序',bullets:[],notes:[],code:{language:'cpp',source:Array.from({length:30},()=> '// old\n').join(''),expectedOutput:'old'}}]});
  const ids=currentVersion(r).content.slides.map(s=>s.id),job=newAgentJob(state,'修正课件',r.id);job.repairRound=1;let executions=0;
  await runTeachingAgent(job,{config:{...config,batchPages:1},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:ids,pages:ids.length})]);
    if(input.phase==='review')return passed;
    executions++;assert.equal(input.codeContext[0].canReplaceBlock,true);assert.deepEqual(input.task.targetIds,ids);
    return {action:'update',reply:'整体修正',operations:[{action:'update',slideId:ids[0],patch:{code:{source:'int main() { return 0; }',expectedOutput:'new',replaceBlock:true}}}]};
  }});assert.equal(executions,1);assert.equal(currentVersion(job.drafts[0]).content.slides.length,2);assert.equal(currentVersion(r).content.slides.length,3);
});

test('独立运行证据阻止错误输出通过，修正标注后重新比对；证据不进入公开任务',async()=>{
  const state=emptyWorkspace(),source='int main() { return 0; }',r=createResource(state,'ppt','程序',{slides:[{title:'程序',bullets:[],notes:[],code:{language:'cpp',source,expectedOutput:'1'}}]});
  const slides=currentVersion(r).content.slides,job=newAgentJob(state,'修正课件',r.id);let reviews=0;
  job.auditEvidence=[{hash:createHash('sha256').update('cpp\n'+source).digest('hex'),input:'',actual:'2\n',exitCode:0,checker:'independent test'}];
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[slides[0].id],pages:1})]);
    if(input.phase==='review'){
      if(job.repairRound){assert.equal(input.codeRuns[0].status,'passed');return passed;}
      assert.equal(input.codeRuns[0].status,'failed');assert.equal(input.codeRuns[0].actual,'2\n');
      if(!reviews++)return passed;
      assert.match(input.feedback,/运行输出错误/);
      return {action:'review',passed:false,reply:'修正输出',issues:['预期输出错误'],repairSteps:[step({tool:'ppt.update',resourceId:r.id,targetIds:[slides[1].id],pages:1,minutes:0})]};
    }
    if(!job.repairRound)return {action:'update',reply:'补充说明',operations:[{action:'update',slideId:slides[0].id,patch:{notes:['核对输出']}}]};
    assert.equal(input.codeContext[0].canReplaceBlock,true);
    return {action:'update',reply:'按实际运行结果改正',operations:[{action:'update',slideId:slides[0].id,patch:{code:{source,expectedOutput:'2',replaceBlock:true}}}]};
  }});assert.equal(job.review.passed,true);assert.equal(publicAgentJob(job).auditEvidence,undefined);
});

test('自主计划分批执行，语义检查发现缺陷后调用修正工具，最终只提交一个版本',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','已有课件',{slides:[page('原页'),page('保留页')]});
  applyWorkspaceCommand(state,{action:'confirm',resourceId:r.id,baseVersionId:r.currentVersionId});
  const old=clone(currentVersion(r)),job=newAgentJob(state,'课件不限制页数，可实操',r.id);
  const phases=[];let reviews=0;
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>{
    phases.push(input.phase);
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id})]);
    if(input.phase==='review')return reviews++?passed:{action:'review',passed:false,reply:'缺少反例',issues:['新增页缺少反例'],repairSteps:[step({id:'repair',tool:'ppt.update',resourceId:r.id,targetIds:[job.drafts[0].versions[0].content.slides.at(-1).id],pages:1,minutes:0})]};
    if(job.repairRound)return {action:'update',reply:'补充反例',operations:[{action:'update',slideId:input.task.targetIds[0],patch:{counterExample:'相同值逆序的反例'}}]};
    return addFor(input);
  }});
  assert.equal(result.action,'agent-commit');assert.equal(job.repairRound,1);assert.equal(job.cursor,3);
  assert.deepEqual(currentVersion(r),old);commitAgentDrafts(state,job);
  assert.equal(r.versions.length,2);assert.equal(currentVersion(r).content.slides.length,8);
  assert.deepEqual(currentVersion(r).content.slides.slice(0,2),old.content.slides);
  assert.equal(currentVersion(r).content.slides.at(-1).counterExample,'相同值逆序的反例');
  assert.deepEqual(phases,['decide','execute','execute','review','execute','review']);
});

test('可选教学建议保留供教师查看，不触发反复修正或阻止提交',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);
    if(input.phase==='review'){
      assert.match(system,/先独立核算/);assert.match(input.pagination,/逻辑内容单元/);
      return {...passed,suggestions:['章节标签可以调整','增加另一个正确例子']};
    }
    return createFor(input);
  }});
  assert.equal(result.action,'agent-commit');assert.equal(job.repairRound,0);assert.equal(job.calls,3);
  assert.deepEqual(publicAgentJob(job).review.suggestions,['章节标签可以调整','增加另一个正确例子']);
  commitAgentDrafts(state,job);assert.equal(state.resources.length,1);
});

test('生成和修正读取相邻页正文以衔接演算，相邻页保持只读',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','算法',{slides:[page('输入'),page('第1趟'),page('第2趟')]});
  const old=clone(currentVersion(r)),job=newAgentJob(state,'补充算法演算',r.id);let reviews=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',pages:1,minutes:0})]);
    if(input.phase==='review')return reviews++?passed:{action:'review',passed:false,reply:'第1趟计算有误',issues:['第1趟计算有误'],repairSteps:[step({tool:'ppt.update',pages:1,minutes:0,targetIds:[old.content.slides[1].id]})]};
    assert.match(system,/contextPages是只读/);
    if(!job.repairRound){assert.deepEqual(input.contextPages.map(s=>s.title),['第1趟','第2趟']);return addFor(input);}
    assert.deepEqual(input.contextPages.map(s=>s.title),['输入','第2趟']);
    assert.equal(input.resource.content.slides[0].id,old.content.slides[1].id);
    return {action:'update',reply:'修正第1趟',operations:[{action:'update',slideId:input.task.targetIds[0],patch:{example:'正确的第1趟'}}]};
  }});
  commitAgentDrafts(state,job);assert.deepEqual(currentVersion(r).content.slides[0],old.content.slides[0]);assert.deepEqual(currentVersion(r).content.slides[2],old.content.slides[2]);
});

test('检查不能把已经排除的计算疑点当作缺陷触发修正',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');let reviews=0;
  const result=await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);
    if(input.phase==='review'){
      if(!reviews++)return {action:'review',passed:false,reply:'疑点',issues:['经核算每步均正确，未发现计算错误。'],repairSteps:[step({tool:'ppt.update',pages:1,minutes:0})]};
      assert.match(input.feedback,/已排除/);return passed;
    }
    return createFor(input);
  }});
  assert.equal(result.action,'agent-commit');assert.equal(job.repairRound,0);assert.equal(reviews,2);assert.equal(job.review.passed,true);
});

test('输出超限自动将三页拆为一页和两页，连续新增保持顺序',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');let failed=false;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step()]);if(input.phase==='review')return passed;
    if(!failed){failed=true;throw Object.assign(new AppError('输出超限',502),{code:'MODEL_LENGTH'});}
    return input.task.tool==='ppt.create'?createFor(input):addFor(input);
  }});
  assert.deepEqual(job.tasks.map(t=>t.pageCount),[1,2,3]);assert.equal(job.cursor,3);
  assert.ok(job.observations.some(o=>o.kind==='tool-repair'));
  commitAgentDrafts(state,job);assert.deepEqual(currentVersion(state.resources[0]).content.slides.map(p=>p.title),['新页 1','新页 2','新页 3','新页 4','新页 5','新页 6']);
});

test('计划课时不符合教师当前要求时重新规划，不能把300分钟当45分钟',async()=>{
  const state=emptyWorkspace();state.requirements.duration=300;const job=newAgentJob(state,'生成完整课件');let attempts=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide'){attempts++;if(attempts>1)assert.match(input.feedback,/300/);return plan([step({minutes:attempts===1?45:300,pages:1})]);}
    return input.phase==='review'?passed:createFor(input);
  }});assert.equal(attempts,2);assert.equal(job.plan.steps[0].minutes,300);
});

test('页面范围越界反馈修正，教师备注和其他页确认保留',async()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','课件',{slides:[page('原页'),page('另一页')]});
  applyWorkspaceCommand(state,{action:'confirm',resourceId:r.id,baseVersionId:r.currentVersionId});
  const old=clone(currentVersion(r)),ids=old.content.slides.map(p=>p.id),job=newAgentJob(state,'第1页增加案例',r.id);let attempts=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({tool:'ppt.update',resourceId:r.id,targetIds:[ids[0]],pages:1})]);
    if(input.phase==='review')return passed;
    if(attempts++)assert.match(input.feedback,/范围/);
    return {action:'update',reply:'更新案例',operations:[{action:'update',slideId:attempts===1?ids[1]:ids[0],patch:{example:'[3,1,2]',notes:['新增讲解']}}]};
  }});commitAgentDrafts(state,job);
  assert.deepEqual(currentVersion(r).content.slides[1],old.content.slides[1]);assert.deepEqual(currentVersion(r).content.slides[0].notes,['教师讲解','新增讲解']);
});

test('暂停后保留已完成批次，恢复不重复；最终检测冲突拒绝覆盖教师编辑',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件'),controller=new AbortController();let batches=0;
  const call=async(system,input)=>input.phase==='decide'?plan([step()]):input.phase==='review'?passed:(batches++,input.task.tool==='ppt.create'?createFor(input):addFor(input));
  await assert.rejects(runTeachingAgent(job,{config,call,signal:controller.signal,checkpoint:async j=>{if(j.cursor===1)controller.abort();}}),/暂停/);
  assert.equal(job.cursor,1);assert.equal(batches,1);
  await runTeachingAgent(job,{config,call});assert.equal(batches,2);
  state.requirements.instructions='教师刚改的新要求';const before=clone(state);
  assert.throws(()=>commitAgentDrafts(state,job),/未覆盖/);assert.deepEqual(state,before);
});

test('检查不能矛盾通过，修正耗尽或检查失败不提交部分成果',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件');let reviews=0;
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxRepairs:0},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);if(input.phase==='execute')return createFor(input);
    reviews++;return {action:'review',passed:reviews===1,reply:'缺练习',issues:['缺练习'],repairSteps:[step({tool:'ppt.update',pages:1,minutes:0})]};
  }}),/修正轮次/);assert.equal(reviews,2);assert.equal(job.cursor,1);assert.equal(state.resources.length,0);
});

test('新建互动、关联固定版本、继续修改互动，最终提交保留被引用的旧互动版本',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建课件和小游戏');let activityId,fixedId;
  const steps=[step({id:'ppt',pages:1}),step({id:'game',tool:'activity.create',minutes:0}),step({id:'attach',tool:'resource.attach',resourceId:'step:ppt',minutes:0}),step({id:'edit-game',tool:'activity.update',resourceId:'step:game',minutes:0})];
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan(steps);if(input.phase==='review')return passed;
    if(input.task.id==='ppt')return createFor(input);
    if(input.task.id==='game')return {action:'create',type:'game',name:'互动',reply:'创建互动',content:sampleActivities[0]};
    if(input.task.id==='attach'){
      const ppt=job.drafts.find(r=>r.type==='ppt'),game=job.drafts.find(r=>r.type==='game');activityId=game.id;fixedId=game.currentVersionId;
      return {action:'attach',reply:'关联',pptId:ppt.id,slideId:currentVersion(ppt).content.slides[0].id,activityId};
    }
    return {action:'update',reply:'更新互动',content:{...sampleActivities[0],description:'更完整的提示'}};
  },runtimeCheck:async()=>({passed:true})});
  commitAgentDrafts(state,job);
  const ppt=state.resources.find(r=>r.type==='ppt'),game=state.resources.find(r=>r.type==='game');
  assert.equal(currentVersion(ppt).content.slides[0].attachment.versionId,fixedId);
  assert.ok(game.versions.some(v=>v.id===fixedId));assert.notEqual(game.currentVersionId,fixedId);
  assert.equal(currentVersion(game).content.description,'更完整的提示');
});

test('运行额度有限，公开任务进度不暴露资料正文与草稿',async()=>{
  const state=emptyWorkspace();state.materials=[{id:'m',status:'parsed',title:'私有教材',content:'只有后端读取的正文'}];const job=newAgentJob(state,'新建课件');
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxAgentCalls:1},call:async()=>plan([step()])}),/调用额度/);
  const visible=publicAgentJob(job);assert.equal(visible.input,undefined);assert.equal(visible.drafts,undefined);assert.ok(!JSON.stringify(visible).includes('只有后端读取的正文'));
});

test('多段检查的局部修正ID可重复，合并后唯一；检查输出超限也自动拆批',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');let oversized=false,parts=0;
  await runTeachingAgent(job,{config:{...config,maxInputChars:13000},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:9})]);
    if(input.phase==='execute'){
      if(job.repairRound)return {action:'update',reply:'修正',operations:[{action:'update',slideId:input.task.targetIds[0],patch:{example:'正确练习'}}]};
      const candidate=input.task.tool==='ppt.create'?createFor(input):addFor(input);
      for(const s of candidate.content?.slides || candidate.operations.map(o=>o.slide))s.notes=['正文讲解'.repeat(500)];return candidate;
    }
    if(job.repairRound)return passed;
    if(!oversized){oversized=true;throw Object.assign(new AppError('检查输出超限',502),{code:'MODEL_LENGTH'});}
    parts++;const first=input.content[0];return {action:'review',passed:false,reply:'修正练习',issues:['练习不够具体'],repairSteps:[step({id:'local-repair',tool:'ppt.update',resourceId:first.resourceId,targetIds:[first.content.id],pages:1,minutes:0})]};
  }});
  const ids=job.tasks.filter(t=>t.id.startsWith('repair-')).map(t=>t.id);assert.ok(parts>1);assert.equal(new Set(ids).size,ids.length);assert.equal(job.review.passed,true);assert.ok(job.observations.some(o=>o.text==='检查输出过长，已缩小检查批次继续。'));
});

test('计划输出页数小于修正目标数时覆盖所有目标，纠正智能体自身备注不会保留错误',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');let reviews=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:3})]);
    if(input.phase==='review')return reviews++?passed:{action:'review',passed:false,reply:'改备注',issues:['演算备注错误'],repairSteps:[step({tool:'ppt.update',pages:1,minutes:0,targetIds:input.content.map(e=>e.content.id)})]};
    if(job.repairRound)return {action:'update',reply:'已纠正',operations:input.task.targetIds.map(slideId=>({action:'update',slideId,patch:{notes:['正确演算']}}))};
    const candidate=createFor(input);for(const s of candidate.content.slides)s.notes=['错误演算'];return candidate;
  }});
  assert.equal(job.tasks[1].pageCount,3);assert.equal(job.drafts[0].versions[0].content.slides.length,3);assert.ok(job.drafts[0].versions[0].content.slides.every(s=>JSON.stringify(s.notes)==='["正确演算"]'));
});

test('修正不能只新增正确页留下错误，允许删除本任务自己的重复页',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');let reviewed=0,fixes=0;
  await runTeachingAgent(job,{config,call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:2})]);
    if(input.phase==='review')return reviewed++?passed:{action:'review',passed:false,reply:'改错清重',issues:['原页错误与重复页'],repairSteps:[step({id:'fix',tool:'ppt.update',targetIds:[input.content[0].content.id],pages:1,minutes:0}),step({id:'dedup',tool:'ppt.update',targetIds:[input.content[1].content.id],pages:1,minutes:0})]};
    if(!job.repairRound)return createFor(input);
    if(input.task.title==='原理与实操' && input.task.id.endsWith('-1')){
      if(!fixes++)return {action:'update',reply:'新增正确页',operations:[{action:'add',slide:page('补充正确页')}]};
      assert.match(input.feedback,/保留原错误/);return {action:'update',reply:'修正原页',operations:[{action:'update',slideId:input.task.targetIds[0],patch:{example:'已修正'}}]};
    }
    return {action:'update',reply:'移除重复页',operations:[{action:'delete',slideId:input.task.targetIds[0]}]};
  }});assert.equal(job.drafts[0].versions[0].content.slides.length,1);assert.equal(job.drafts[0].versions[0].content.slides[0].example,'已修正');
});

test('检查结果与修正执行预算分开，修正预算不足仍记录真实检查结论',async()=>{
  const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');
  await assert.rejects(runTeachingAgent(job,{config:{...config,maxAgentCalls:4,maxRepairs:0},call:async(system,input)=>{
    if(input.phase==='decide')return plan([step({pages:1})]);if(input.phase==='execute')return createFor(input);
    return {action:'review',passed:false,reply:'仍需修正',issues:['缺少练习'],repairSteps:[step({tool:'ppt.update',pages:9,minutes:0})]};
  }}),/自动修正轮次/);assert.equal(job.calls,3);assert.equal(job.review.passed,false);assert.deepEqual(job.review.issues,['缺少练习']);assert.equal(state.resources.length,0);
});
