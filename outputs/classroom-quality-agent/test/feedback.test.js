import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,AppError} from '../src/store.js';
import {ModelSettings} from '../src/modelSettings.js';
import {FeedbackService} from '../src/feedbackService.js';
import {FeedbackAgent} from '../src/feedbackAgent.js';
import {defaultTemplate,validateTemplate,validateRecord,statistics,mergeRecords,mapProviderForm,normalizeProviderEntry,providerForm} from '../src/feedbackDomain.js';

const tiny=()=>({title:'可变模板',description:'匿名反馈',questions:[
  {id:'difficulty',type:'single',label:'难度',required:true,options:[{id:'ok',label:'适中'},{id:'hard',label:'偏难'}]},
  {id:'needs',type:'multiple',label:'希望加强',options:[{id:'code',label:'代码'},{id:'theory',label:'原理'}]},
  {id:'rating',type:'rating',label:'评分',max:5},{id:'comment',type:'text',label:'建议'}
]});
test('只含空白的问卷凭据不能被标记为已配置',()=>{
  const service=new FeedbackService({store:null});
  for(const accessToken of ['', '   ', '\t\n']){
    const visible=service.publicConfig({revision:0,accessToken,identity:null});
    assert.equal(visible.configured,false);assert.equal(visible.accessToken,undefined);
  }
});
const formFor=payload=>({token:'form-test',url:'https://example.test/f/form-test',fields:payload.fields.map((f,i)=>({['field_'+(i+1)]:{...f,type:({RadioButton:'single_choice',CheckBox:'multiple_choice',RatingField:'rating',TextArea:'multi_line_text',DropDown:'drop_down'})[f.type]}}))});
test('金数据真实GET选项以name显示、value作编码，不能按创建请求的value/api_code解释',()=>{
  const template=validateTemplate(tiny()),types={single:'single_choice',multiple:'multiple_choice',rating:'rating',text:'paragraph_text'};
  const form={token:'real-response-fixture',url:'https://example.test/f/fixture',fields:template.questions.map((q,i)=>({['field_'+(i+1)]:{label:q.label,type:types[q.type],...(q.options?{choices:q.options.map((o,j)=>({name:o.label,value:'remote-'+i+'-'+j,hidden:false}))}:{})}}))};
  const mapping=mapProviderForm(template,form),record=normalizeProviderEntry({serial_number:1,field_1:'remote-0-1',field_2:['remote-1-0'],field_3:4,field_4:'完整函数示范'},mapping,form);
  assert.equal(record.answers.difficulty,'hard');assert.deepEqual(record.answers.needs,['code']);assert.equal(record.answers.rating,4);
  const displayed=normalizeProviderEntry({serial_number:2,field_1:'偏难',field_2:['代码'],field_3:'4',field_4:'完整函数示范'},mapping,form);
  const validated=validateRecord(displayed,template);assert.deepEqual(validated.errors,[]);assert.equal(validated.answers.difficulty,'hard');assert.deepEqual(validated.answers.needs,['code']);assert.equal(validated.answers.rating,4);
  assert.equal(statistics([validated],template).questions[2].mean,4);
  form.fields[0].field_1.choices[0].name='被改过的问题';assert.throws(()=>mapProviderForm(template,form),/无法对应/);
});
async function setup(fn,options={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'feedback-test-')),store=new Store(dir);
  const service=new FeedbackService({store,modelSettings:new ModelSettings(dir,{LLM_API_KEY:'feedback-test-fixture'}),modelCall:options.modelCall||(async()=>({action:'reply',reply:'你好！'})),clientFactory:options.clientFactory,providerIntervalMs:0});
  try{await fn(service,dir);}finally{for(const run of service.runs.values())run.controller.abort();await Promise.all([...service.runs.values()].map(r=>r.promise));await rm(dir,{recursive:true,force:true});}
}
async function newClass(service){
  const versions=await service.templates(),saved=await service.saveTemplate({revision:versions.revision,template:tiny()});
  return service.create({title:'平衡树',date:'2026-10-20',templateId:saved.versions.at(-1).id});
}
async function waitRun(service,key){const run=service.runs.get(key)||[...service.runs.values()].find(r=>r.owner===key.slice(6));if(run)await run.promise;}
test('模板删除和排序保留题目标识，统计逐题分母、多选去重、空评分与非法值正确',async()=>{
  const t=validateTemplate(tiny());
  const records=[
    validateRecord({id:'one',answers:{difficulty:'hard',needs:['code','code','theory'],rating:5}},t),
    validateRecord({id:'two',answers:{difficulty:'ok',needs:['code'],rating:0}},t),
    validateRecord({id:'three',answers:{difficulty:'unknown',rating:null}},t)
  ];
  const stats=statistics(records,t);
  assert.equal(stats.questions[0].n,2);assert.equal(stats.questions[0].options[0].percent,50);
  assert.equal(stats.questions[1].options[0].count,2);assert.equal(stats.questions[1].options[1].percent,50);
  assert.equal(stats.questions[2].mean,5);assert.equal(stats.invalid,2);
  const reordered=validateTemplate({...t,questions:[t.questions[2],t.questions[0]]});
  assert.deepEqual(statistics(records,reordered).questions.map(q=>q.id),['rating','difficulty']);
  assert.throws(()=>validateTemplate({...t,questions:[]}));
  assert.throws(()=>validateTemplate({...t,questions:[t.questions[0],t.questions[0]]}));
  assert.equal((await defaultTemplate()).questions.length,9);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const candidate=()=>({summary:'整体总结：应增加可操作的代码示范。',findings:[{text:'课堂目标是讲清楚平衡树。',kind:'observation',evidenceIds:['course']}],suggestions:[{text:'在原理之后展示完整函数及调用。',evidenceIds:['course']}]});
async function withRecords(service,count=1){
  let c=await newClass(service),p=await service.previewImport(c.id,{data:{records:Array.from({length:count},(_,i)=>({id:'record-'+i,answers:{difficulty:'hard',comment:'示范完整函数。'.repeat(count>1?140:1)}}))}});
  return service.commitImport(c.id,c.revision,p.id,false);
}
test('分析期间普通问候可独立完成，第二个写任务被拒绝，教师报告和建议不被后台覆盖',async()=>{
  const entered=deferred(),release=deferred();
  await setup(async service=>{
    let c=await withRecords(service);c=await service.update(c.id,c.revision,x=>{x.reports=[{id:'old-report',version:1,text:'原报告',history:[],stale:false}];x.currentReportId='old-report';return x;});
    const agent=new FeedbackAgent(service),analysis=await agent.start(c.id,{revision:c.revision,request:'复盘'});await entered.promise;
    c=await service.read(c.id);const greeting=await agent.start(c.id,{revision:c.revision,request:'你好'});await waitRun(service,'agent-'+greeting.id);
    c=await service.read(c.id);assert.ok(c.messages.some(m=>m.text==='你好！'));assert.equal(c.writerJobId,analysis.id);
    const second=await agent.start(c.id,{revision:c.revision,request:'再分析'});await waitRun(service,'agent-'+second.id);
    assert.equal((await service.store.read('feedback-job-'+second.id,null)).status,'failed');
    c=await service.read(c.id);c=await service.command(c.id,{revision:c.revision,action:'report',reportId:'old-report',baseVersion:1,text:'教师正在使用的报告'});
    c=await service.command(c.id,{revision:c.revision,action:'suggestions',suggestions:[{id:'teacher',text:'教师自己的建议',evidenceIds:[]}]});
    release.resolve();await waitRun(service,'agent-'+analysis.id);c=await service.read(c.id);
    assert.equal(c.reports.length,2);assert.equal(c.currentReportId,'old-report');assert.equal(c.reports[0].text,'教师正在使用的报告');assert.equal(c.suggestions[0].text,'教师自己的建议');assert.equal(c.writerJobId,null);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.request==='你好'?{action:'reply',reply:'你好！'}:input.toolResults.length?{action:'reply',reply:'已另存候选。'}:{action:'tool',tool:'analysis.generate'};
    entered.resolve();await release.promise;return candidate();
  }});
});
test('长资料暂停后复用已完成分段，恢复使用原非密钥配置',async()=>{
  const entered=deferred();let paused=false,firstCalls=0;
  await setup(async service=>{
    await service.modelSettings.save({revision:0,maxInputChars:8000});const c=await withRecords(service,12),agent=new FeedbackAgent(service);
    const j=await agent.start(c.id,{revision:c.revision,request:'复盘'});await entered.promise;
    const stopped=await agent.control(c.id,j.id,'pause');assert.equal(stopped.status,'paused');
    const saved=await service.store.read('feedback-job-'+j.id,null);assert.equal(saved.partials.length,1);assert.ok(saved.analysisRanges.length>1);
    const config=await service.modelSettings.read();await service.modelSettings.save({revision:config.revision,maxTokens:9000,prompts:{feedbackSummary:'新任务才使用这份提示词。'}});
    const resumed=await Promise.allSettled([agent.control(c.id,j.id,'resume'),agent.control(c.id,j.id,'resume')]);assert.equal(resumed.filter(r=>r.status==='fulfilled').length,1);await waitRun(service,'agent-'+j.id);
    assert.equal(firstCalls,1);assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'completed');assert.equal((await service.read(c.id)).reports.length,1);
  },{modelCall:async(system,input,config)=>{
    assert.equal(config.maxTokens,8000);
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'已保存。'}:{action:'tool',tool:'analysis.generate'};
    if(input.mode==='part'&&input.part===1)firstCalls++;
    if(input.mode==='part'&&input.part===2&&!paused){paused=true;entered.resolve();await new Promise((resolve,reject)=>{config.signal.addEventListener('abort',()=>reject(new AppError('暂停',499)),{once:true});});}
    return candidate();
  }});
});
test('输出达到额度时缩小分析批次，不提交半份报告',async()=>{
  let lengths=0;
  await setup(async service=>{
    const c=await withRecords(service,4),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'复盘'});await waitRun(service,'agent-'+j.id);
    const job=await service.store.read('feedback-job-'+j.id,null);assert.equal(job.status,'completed');assert.ok(lengths>0);assert.ok(job.analysisRanges.length>1);assert.equal((await service.read(c.id)).reports.length,1);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'已保存。'}:{action:'tool',tool:'analysis.generate'};
    if(input.mode==='part'&&input.items.length>3){lengths++;throw Object.assign(new AppError('输出过长',502),{code:'MODEL_LENGTH'});}return candidate();
  }});
});
test('独立建议生成遇到教师并发修订时明确失败，建议历史可恢复并拒绝旧草稿覆盖',async()=>{
  const entered=deferred(),release=deferred();
  await setup(async service=>{
    let c=await withRecords(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'只给建议'});await entered.promise;
    c=await service.read(c.id);c=await service.command(c.id,{revision:c.revision,action:'suggestions',suggestions:[{id:'teacher',text:'教师建议',evidenceIds:[]}]});
    release.resolve();await waitRun(service,'agent-'+j.id);assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'failed');
    c=await service.read(c.id);assert.equal(c.suggestions[0].text,'教师建议');assert.equal(c.reports.length,0);
    await assert.rejects(service.command(c.id,{revision:c.revision,action:'suggestions',baseSuggestionVersion:0,suggestions:[]}),e=>e.statusCode===409);
    c=await service.command(c.id,{revision:c.revision,action:'restoreSuggestions',version:0});assert.deepEqual(c.suggestions,[]);assert.equal(c.suggestionHistory.at(-1).items[0].text,'教师建议');
  },{modelCall:async()=>{entered.resolve();await release.promise;return {action:'tool',tool:'suggestions.write',args:{suggestions:candidate().suggestions}};}});
});
test('截止时刻精度与时区明确，晚到及缺时间记录独立统计',()=>{
  const t=validateTemplate(tiny()),deadline='2026-10-20T12:00:00+08:00';
  const record=time=>validateRecord({id:'r-'+String(time).replace(/[^a-z0-9]/gi,'-').slice(0,60),submittedAt:time,answers:{difficulty:'ok'}},t,deadline);
  assert.equal(record('2026-10-20T03:59:59.999Z').late,false);
  assert.equal(record('2026-10-20T04:00:00Z').late,true);
  assert.equal(record('2026-10-20T12:00:00').unknownTime,true);
  assert.equal(record('2026-10-20T11:59+08:00').unknownTime,true);
  const s=statistics([record('2026-10-20T03:59:59Z'),record('2026-10-20T04:00:00Z'),record(null)],t);assert.equal(s.eligible,1);assert.equal(s.late,1);assert.equal(s.unknownTime,1);
});
test('导入预览版本冲突、部分有效选择、文件与文本上限均保留原数据',async()=>setup(async service=>{
  let c=await newClass(service),p=await service.previewImport(c.id,{data:{records:[{id:'good',answers:{difficulty:'ok'}},{id:'bad',answers:{difficulty:'bad'}}]}});
  assert.equal(p.errors.length,1);await assert.rejects(service.commitImport(c.id,c.revision,p.id,false));c=await service.commitImport(c.id,c.revision,p.id,true);assert.equal(c.records.length,1);
  await assert.rejects(service.commitImport(c.id,c.revision,p.id,true),e=>e.statusCode===409);
  const before=process.env.FEEDBACK_MAX_IMPORT_BYTES;process.env.FEEDBACK_MAX_IMPORT_BYTES='100';
  try{await assert.rejects(service.previewImport(c.id,{data:{records:[{answers:{comment:'超限'.repeat(100)}}]}}),e=>e.statusCode===413);}finally{if(before===undefined)delete process.env.FEEDBACK_MAX_IMPORT_BYTES;else process.env.FEEDBACK_MAX_IMPORT_BYTES=before;}
  p=await service.previewImport(c.id,{data:{records:[{id:'long',answers:{difficulty:'ok',comment:'x'.repeat(4001)}}]}});assert.equal(p.valid,0);assert.equal((await service.read(c.id)).records.length,1);
}));
test('旧答案更新不能倒退覆盖新记录，样例重载及重命名后仍不重复',async()=>setup(async service=>{
  const t=validateTemplate(tiny()),make=(answer,time)=>validateRecord({id:'one',updatedAt:time,answers:{difficulty:answer}},t);
  const merged=mergeRecords([make('ok','2026-10-20T04:00:00Z')],[make('hard','2026-10-20T03:00:00Z')]);assert.equal(merged.updated,0);assert.equal(merged.records[0].answers.difficulty,'ok');
  const a=await service.sampleClasses();let c=await service.read(a[0].id);await service.command(c.id,{revision:c.revision,action:'update',title:'重命名示例'});
  const b=await service.sampleClasses();assert.deepEqual(b.map(x=>x.id).sort(),a.map(x=>x.id).sort());assert.equal((await service.list()).length,a.length);
}));
test('相同课堂资料跨问答复用不可变快照，重启暂停所有并发任务且不恢复旧写锁',async()=>setup(async(service,dir)=>{
  let c=await withRecords(service),agent=new FeedbackAgent(service),j1=await agent.start(c.id,{revision:c.revision,request:'你好'});await waitRun(service,'agent-'+j1.id);
  c=await service.read(c.id);const j2=await agent.start(c.id,{revision:c.revision,request:'再问好'});await waitRun(service,'agent-'+j2.id);
  const a=await service.store.read('feedback-input-'+j1.id,null),b=await service.store.read('feedback-input-'+j2.id,null);assert.equal(a.materialId,b.materialId);assert.equal(a.records,undefined);
  for(const j of [j1,j2])await service.store.update('feedback-job-'+j.id,undefined,j,x=>({...x,status:'running'}));
  await service.update(c.id,undefined,x=>({...x,writerJobId:j1.id}));await service.recover();
  for(const j of [j1,j2])assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'paused');assert.equal((await service.read(c.id)).writerJobId,null);
}));
test('课程结束在缺配置时保留待发布，模板后续修改不替换发布快照',async()=>setup(async service=>{
  let c=await newClass(service);
  c=await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);
  const saved=await service.read(c.id);assert.equal(saved.ended,true);assert.equal(saved.publish.status,'pending');
  const templates=await service.templates();await service.saveTemplate({revision:templates.revision,template:{...tiny(),questions:[tiny().questions[3]]}});
  assert.equal((await service.read(c.id)).publish.template.questions.length,4);
}));
test('已创建表单映射失败后修复不重复创建，重复结束与重启恢复均不重发',async()=>{
  let creates=0,good=false,form;
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});
    let c=await newClass(service);await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);
    c=await service.read(c.id);assert.equal(c.publish.status,'mapping');assert.equal(creates,1);assert.equal(c.publish.token,'form-test');
    await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);assert.equal(creates,1);
    good=true;await service.repairMapping(c.id);c=await service.read(c.id);assert.equal(c.publish.status,'published');assert.equal(creates,1);
    await service.recover();assert.equal(creates,1);
  },{clientFactory:()=>({getMe:async()=>({id:1}),createForm:async payload=>{creates++;form=formFor(payload);return {...form,fields:[]};},getForm:async()=>form})});
});
test('创建响应丢失进入待核实，不能重试创建；删除后迟到结果不重建课堂',async()=>{
  let calls=0,release,entered;const start=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});let c=await newClass(service);
    await service.end(c.id,c.revision);await start;
    c=await service.read(c.id);await service.command(c.id,{revision:c.revision,action:'delete'});
    release();await waitRun(service,'publish-'+c.id);
    await assert.rejects(service.read(c.id),e=>e.statusCode===404);assert.equal(calls,1);
  },{clientFactory:()=>({getMe:async()=>({id:1}),createForm:async()=>{calls++;entered();await wait;throw new Error('response lost');}})});
});
test('导入去重、排除状态保持、重复同步式合并不作废报告，错误预览不覆盖已有反馈',async()=>setup(async service=>{
  let c=await newClass(service),data={records:[{id:'online-1',source:'online',answers:{difficulty:'hard',rating:4}}]};
  let preview=await service.previewImport(c.id,{data});
  c=await service.commitImport(c.id,c.revision,preview.id,false);assert.equal(c.records.length,1);
  c=await service.command(c.id,{revision:c.revision,action:'exclude',recordId:'online-1',excluded:true,reason:'测试'});
  preview=await service.previewImport(c.id,{data});c=await service.commitImport(c.id,c.revision,preview.id,false);
  assert.equal(c.records[0].excluded,true);assert.equal(c.records[0].reason,'测试');assert.equal(c.records.length,1);
  const bad=await service.previewImport(c.id,{data:{records:[{id:'bad',answers:{difficulty:'missing'}}]}});
  assert.equal(bad.valid,0);await assert.rejects(service.commitImport(c.id,c.revision,bad.id,false));assert.equal((await service.read(c.id)).records.length,1);
  await assert.rejects(service.previewImport(c.id,{data:{classId:'another',records:data.records}}));
}));
test('同步获取早期回答更新且无变化不增加业务版本；模板远端变化不覆盖统计',async()=>{
  let value='hard',form,changed=false;
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});
    let c=await newClass(service);await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);
    service.launchSync(c.id);await waitRun(service,'sync-'+c.id);c=await service.read(c.id);assert.equal(c.records[0].answers.difficulty,'hard');
    const version=c.dataVersion;
    service.launchSync(c.id);await waitRun(service,'sync-'+c.id);assert.equal((await service.read(c.id)).dataVersion,version);
    value='ok';service.launchSync(c.id);await waitRun(service,'sync-'+c.id);assert.equal((await service.read(c.id)).records[0].answers.difficulty,'ok');
    changed=true;service.launchSync(c.id);await waitRun(service,'sync-'+c.id);c=await service.read(c.id);assert.equal(c.sync.status,'failed');assert.equal(c.records[0].answers.difficulty,'ok');
  },{clientFactory:()=>({getMe:async()=>({id:1}),createForm:async payload=>(form=formFor(payload)),getForm:async()=>changed?{...form,fields:[]}:form,listEntries:async()=>({data:[{serial_number:1,field_1:value,created_at:'2026-10-20T03:00:00Z'}],next:null})})});
});
test('普通问候直接回答，无报告与课件修改；任务检查点不存密钥，清空后旧回复不写回',async()=>{
  let entered,release;const start=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  await setup(async(service,dir)=>{
    let c=await newClass(service);const agent=new FeedbackAgent(service),job=await agent.start(c.id,{revision:c.revision,request:'你好'});await start;
    c=await service.read(c.id);await service.command(c.id,{revision:c.revision,action:'clearConversation'});release();await waitRun(service,'agent-'+c.id);
    c=await service.read(c.id);assert.deepEqual(c.messages,[]);assert.equal(c.reports.length,0);
    const stored=await readFile(path.join(dir,'feedback-job-'+job.id+'.json'),'utf8');assert.ok(!stored.includes('feedback-test-fixture'));assert.equal(JSON.parse(stored).status,'completed');
  },{modelCall:async(system,input)=>{assert.equal(input.phase,'feedback-decide');entered();await waiting;return {action:'reply',reply:'你好！'};}});
});
test('自主分析仅问卷即可生成整体报告，保存历史证据，建议交接不依赖目标PPT',async()=>{
  await setup(async service=>{
    let c=await newClass(service);let p=await service.previewImport(c.id,{data:{records:[{id:'one',answers:{difficulty:'hard',comment:'代码没跟上'}}]}});
    c=await service.commitImport(c.id,c.revision,p.id,false);
    const agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'分析课堂'});
    await waitRun(service,'agent-'+c.id);c=await service.read(c.id);
    assert.equal(c.reports.length,1);assert.match(c.reports[0].text,/整体总结/);assert.equal(c.suggestions.length,1);
    const h=await service.handoff(c.id,{revision:c.revision,ids:c.suggestions.map(s=>s.id)});assert.match(h.url,/feedback=/);assert.equal(h.target,null);
    assert.equal((await service.handoff(c.id,{revision:c.revision,ids:c.suggestions.map(s=>s.id)})).id,h.id);
    c=await service.command(c.id,{revision:c.revision,action:'exclude',recordId:'one',excluded:true,reason:'暂不采用'});
    assert.equal(c.reports[0].stale,true);
    const input=await service.readInput(j.id);assert.equal(input.records[0].excluded,false);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'整体复盘和建议已经保存。'}:{action:'plan',reply:'结合现有资料分析',steps:[{title:'分析问卷并形成整体报告',tool:'analysis.generate'}]};
    return {summary:'整体总结：学生反馈代码讲解需要更充分。',findings:[{text:'一份反馈认为偏难',kind:'observation',evidenceIds:['feedback:one']}],suggestions:[{text:'下一课用完整函数示范关键操作，增加调用说明。',evidenceIds:['feedback:one']}]};
  }});
});
test('设置截止后重算已导入反馈，样例不能发布或混入正式课堂',async()=>setup(async service=>{
  let c=await withRecords(service);assert.equal(statistics(c.records,c.template).eligible,1);
  c=await service.command(c.id,{revision:c.revision,action:'update',deadline:'2026-10-21T00:00:00+08:00'});assert.equal(statistics(c.records,c.template).unknownTime,1);
  c=await service.command(c.id,{revision:c.revision,action:'update',deadline:null});assert.equal(statistics(c.records,c.template).eligible,1);
  const preview=await service.previewImport(c.id,{data:{records:[{id:'sample-record',source:'sample',answers:{difficulty:'ok'}}]}});assert.equal(preview.valid,0);
  const samples=await service.sampleClasses(),sample=await service.read(samples[0].id);await assert.rejects(service.end(sample.id,sample.revision),/样例课堂/);
}));
test('活动课堂创建响应丢失后仅能核实，不因重试或重启重复创建',async()=>{
  let creates=0;
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});let c=await newClass(service);await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);
    c=await service.read(c.id);assert.equal(c.publish.status,'uncertain');await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);await service.recover();assert.equal(creates,1);
  },{clientFactory:()=>({getMe:async()=>({id:1}),createForm:async()=>{creates++;throw new Error('response lost');}})});
});
test('独立建议不创建报告或修改PPT，课件变更与交接目标状态可核对',async()=>setup(async service=>{
  const workspace={revision:0,resources:[{id:'ppt-one',name:'平衡树课件',type:'ppt',currentVersionId:'v-one',versions:[{id:'v-one',content:{slides:[{id:'page-one',title:'定义',bullets:['保持高度平衡']}]}}]}]};
  await service.store.update('workspace',undefined,{revision:0},()=>workspace);
  let c=await newClass(service);c=await service.command(c.id,{revision:c.revision,action:'linkPpt',resourceId:'ppt-one'});
  const agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'只给建议'});await waitRun(service,'agent-'+j.id);c=await service.read(c.id);
  assert.equal(c.reports.length,0);assert.equal(c.suggestions.length,1);assert.equal((await service.store.read('workspace',null)).revision,1);
  const h=await service.handoff(c.id,{revision:c.revision,ids:c.suggestions.map(s=>s.id)});assert.equal((await service.getHandoff(h.id)).targetStatus,'current');
  await service.update(c.id,undefined,x=>{x.reports=[{id:'report',text:'旧结论',version:1,stale:false}];x.currentReportId='report';return x;});
  await service.store.update('workspace',undefined,null,x=>{x.resources[0].currentVersionId='v-two';return x;});
  c=await service.refreshReferences(c.id);assert.equal(c.ppt.needsRefresh,true);assert.equal(c.reports[0].stale,true);assert.equal((await service.getHandoff(h.id)).targetStatus,'changed');
  const revised=await service.handoff(c.id,{revision:c.revision,ids:c.suggestions.map(s=>s.id)});assert.notEqual(revised.id,h.id);
},{modelCall:async(system,input)=>input.toolResults.length?{action:'reply',reply:'建议已保存，课件未修改。'}:{action:'tool',tool:'suggestions.write',args:{suggestions:[{text:'在定义之后演示旋转函数的完整代码与调用。',evidenceIds:['page:page-one']}]}}}));
test('旧转写缺少音频快照时不能误关联当前其他课堂的录音',async()=>setup(async service=>{
  await service.store.update('classroom',undefined,{revision:0},()=>({revision:0,course:{title:'新课'},audio:{id:'new-audio',file:'new.wav'},transcriptVersions:[{id:'old-transcript',audioId:'old-audio',segments:[]}],reports:[]}));
  let c=await newClass(service);c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:'old-transcript'});
  const snapshot=await service.store.read('feedback-source-'+c.source.id,null);assert.equal(snapshot.audio,null);assert.equal(snapshot.audioId,'old-audio');
}));
test('智能体可在同一任务内继续修订自己保存的建议，不误报教师并发冲突',async()=>setup(async service=>{
  const c=await withRecords(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'完善建议'});await waitRun(service,'agent-'+j.id);
  const job=await service.store.read('feedback-job-'+j.id,null),saved=await service.read(c.id);assert.equal(job.status,'completed');assert.equal(saved.suggestionVersion,2);assert.equal(saved.suggestions[0].text,'第二次完善：完整函数及调用');assert.equal(saved.reports.length,0);
},{modelCall:async(system,input)=>{
  if(input.toolResults.filter(r=>r.tool==='suggestions.write').length===2)return {action:'reply',reply:'建议已完成并保存。'};
  const second=input.toolResults.length>0;return {action:'tool',tool:'suggestions.write',args:{suggestions:[{text:second?'第二次完善：完整函数及调用':'首次建议：完整函数',evidenceIds:['course']}]}};
}}));
test('长资料中间总结无法成组合并时压缩冗余，保留全部分段后再形成整体报告',async()=>{
  let compactCalls=0;
  await setup(async service=>{
    await service.modelSettings.save({revision:0,maxInputChars:8000});const c=await withRecords(service,12),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'复盘'});await waitRun(service,'agent-'+j.id);
    const job=await service.store.read('feedback-job-'+j.id,null);assert.equal(job.status,'completed',job.error);assert.ok(compactCalls>0);assert.equal(job.partials.length,job.analysisRanges.length);assert.equal((await service.read(c.id)).reports.length,1);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'已保存。'}:{action:'tool',tool:'analysis.generate'};
    if(input.mode==='part')return {...candidate(),summary:'这是需要合并但不应逐段重复的大量中间表述。'.repeat(140)};
    if(input.mode==='compact')compactCalls++;return candidate();
  }});
});
test('事实引用缺失时自动修正明确指出条目和可用证据，不能无依据提交',async()=>{
  let attempts=0;
  await setup(async service=>{const c=await withRecords(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'复盘'});await waitRun(service,'agent-'+j.id);assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'completed');assert.equal(attempts,2);},
  {modelCall:async(system,input)=>{if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'已保存。'}:{action:'tool',tool:'analysis.generate'};attempts++;if(attempts===1)return {...candidate(),findings:[{text:'资料范围说明',kind:'observation',evidenceIds:[]}]};assert.match(input.feedback,/第 1 条事实/);assert.match(input.feedback,/本批证据标识示例/);return candidate();}});
});
test('汇总中断后复用已完成组，不重复调用模型或丢失分段成果',async()=>{
  let firstGroupCalls=0,failed=false;
  await setup(async service=>{
    await service.modelSettings.save({revision:0,maxInputChars:8000});const c=await withRecords(service,24),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'完整复盘'});await waitRun(service,'agent-'+j.id);
    const checkpoint=await service.store.read('feedback-job-'+j.id,null);assert.equal(checkpoint.status,'failed');assert.equal(checkpoint.aggregateState.next.length,1);
    await agent.control(c.id,j.id,'resume');await waitRun(service,'agent-'+j.id);assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'completed');assert.equal(firstGroupCalls,1);assert.equal((await service.read(c.id)).reports.length,1);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'整体复盘已保存。'}:{action:'tool',tool:'analysis.generate'};
    if(input.mode==='part')return {...candidate(),summary:'part-'+input.part+' '+'中间发现'.repeat(300)};
    if(input.mode==='merge'){
      const first=input.partials.some(p=>p.summary.startsWith('part-1 '));if(first)firstGroupCalls++;
      if(!first&&input.partials.some(p=>p.summary.startsWith('part-'))&&!failed){failed=true;throw new AppError('模拟第二组服务暂时不可用',503);}
    }
    return candidate();
  }});
});
test('汇总使用短证据标识节省输入，提交时恢复真实引用并拒绝未知标识',async()=>{
  let repaired=false;
  await setup(async service=>{
    await service.modelSettings.save({revision:0,maxInputChars:8000});const c=await withRecords(service,12),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'整体复盘'});await waitRun(service,'agent-'+j.id);
    const job=await service.store.read('feedback-job-'+j.id,null),saved=await service.read(c.id);assert.equal(job.status,'completed',job.error);assert.equal(repaired,true);assert.deepEqual(saved.reports[0].findings[0].evidenceIds,['feedback:record-0']);
  },{modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'已保存。'}:{action:'tool',tool:'analysis.generate'};
    if(input.mode==='part')return {...candidate(),findings:[{text:'反馈提到代码讲解需求。',kind:'observation',evidenceIds:['feedback:record-0']}]};
    assert.ok(!JSON.stringify(input.partials).includes('feedback:record-0'));const ref=input.partials[0].findings[0][2][0];assert.match(ref,/^F\d+$/);
    if(!repaired){repaired=true;return {...candidate(),findings:[{text:'需校验引用',kind:'observation',evidenceIds:['F99999']}]};}
    return {...candidate(),findings:[{text:'反馈提到代码讲解需求。',kind:'observation',evidenceIds:[ref]}]};
  }});
});
test('过长工具结果在下一轮决策中保留明确索引，原报告与检查点完整保留',async()=>setup(async service=>{
  await service.modelSettings.save({revision:0,maxInputChars:8000});let c=await newClass(service);c=await service.update(c.id,c.revision,x=>{x.reports=[{id:'large',version:1,text:'完整报告'.repeat(7000),findings:[],history:[]}];x.currentReportId='large';return x;});
  const agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'查看报告'});await waitRun(service,'agent-'+j.id);const job=await service.store.read('feedback-job-'+j.id,null);assert.equal(job.status,'completed');assert.equal(job.toolResults[0].data.text.length,28000);assert.equal((await service.read(c.id)).reports[0].text.length,28000);
},{modelCall:async(system,input)=>{assert.ok(system.length+JSON.stringify(input).length<=8000);if(!input.toolResults.length)return {action:'tool',tool:'report.read'};assert.equal(input.toolResults[0].data.contextOmitted,true);assert.equal(input.toolResults[0].data.totalCharacters,28000);return {action:'reply',reply:'报告较长，当前保留索引，可提高输入额度后查看全文。'};}}));
test('决策历史超过输入窗口时明确标记省略，已保存聊天不被删除',async()=>setup(async service=>{
  await service.modelSettings.save({revision:0,maxInputChars:8000});let c=await newClass(service);c=await service.update(c.id,c.revision,x=>{x.messages=Array.from({length:12},()=>({role:'user',text:'历史交互'.repeat(700)}));return x;});const agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'你好'});await waitRun(service,'agent-'+j.id);assert.equal((await service.store.read('feedback-job-'+j.id,null)).status,'completed');assert.equal((await service.read(c.id)).messages.length,14);
},{modelCall:async(system,input)=>{assert.ok(system.length+JSON.stringify(input).length<=8000);assert.ok(input.omittedConversationMessages>0);return {action:'reply',reply:'你好！'};}}));
test('后台回复只改变课堂修订号时仍可保存报告与建议，真实同字段冲突继续拒绝',async()=>setup(async service=>{
  let c=await newClass(service);c=await service.update(c.id,c.revision,x=>{x.reports=[{id:'report',version:1,text:'原报告',history:[],stale:false}];x.currentReportId='report';return x;});const revision=c.revision;
  await service.update(c.id,undefined,x=>{x.messages.push({role:'assistant',text:'后台任务已完成'});return x;});
  c=await service.command(c.id,{revision,action:'report',reportId:'report',baseVersion:1,text:'教师修订'});assert.equal(c.reports[0].text,'教师修订');
  c=await service.command(c.id,{revision,action:'suggestions',baseSuggestionVersion:0,suggestions:[{id:'own',text:'教师建议',evidenceIds:[]}]});assert.equal(c.suggestions[0].text,'教师建议');
  await assert.rejects(service.command(c.id,{revision,action:'report',reportId:'report',baseVersion:1,text:'过期修订'}),e=>e.statusCode===409);
  await assert.rejects(service.command(c.id,{revision,action:'suggestions',baseSuggestionVersion:0,suggestions:[]}),e=>e.statusCode===409);
}));
test('同一任务连续修订报告时读取刚保存的候选，并选中最终版本',async()=>setup(async service=>{
  const c=await withRecords(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'连续完善报告'});await waitRun(service,'agent-'+j.id);
  const job=await service.store.read('feedback-job-'+j.id,null),saved=await service.read(c.id);assert.equal(job.status,'completed',job.error);assert.equal(saved.reports.length,2);assert.match(saved.reports.find(r=>r.id===saved.currentReportId).text,/第二版整体总结/);
},{modelCall:async(system,input)=>{
  const writes=input.toolResults.filter(r=>r.tool==='report.write');
  if(writes.length===2)return {action:'reply',reply:'最终版本已保存。'};
  if(writes.length===1&&!input.toolResults.some(r=>r.tool==='report.read'))return {action:'tool',tool:'report.read'};
  if(writes.length===1){assert.match(input.toolResults.find(r=>r.tool==='report.read').data.text,/第一版整体总结/);return {action:'tool',tool:'report.write',args:{...candidate(),summary:'第二版整体总结'}};}
  return {action:'tool',tool:'report.write',args:{...candidate(),summary:'第一版整体总结'}};
}}));
test('智能体继续修订自己的候选时仍保护教师在该候选上的新编辑',async()=>{
  const entered=deferred(),release=deferred();
  await setup(async service=>{
    const c=await withRecords(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'连续完善报告'});await entered.promise;
    let saved=await service.read(c.id),first=saved.reports.find(r=>r.id===saved.currentReportId);saved=await service.command(c.id,{revision:saved.revision,action:'report',reportId:first.id,baseVersion:first.version,text:'教师的重要修订'});
    release.resolve();await waitRun(service,'agent-'+j.id);saved=await service.read(c.id);assert.equal(saved.currentReportId,first.id);assert.equal(saved.reports.find(r=>r.id===first.id).text,'教师的重要修订');assert.equal(saved.reports.length,2);
  },{modelCall:async(system,input)=>{
    const writes=input.toolResults.filter(r=>r.tool==='report.write');if(writes.length===2)return {action:'reply',reply:'新候选已另存。'};
    if(writes.length===1){entered.resolve();await release.promise;}
    return {action:'tool',tool:'report.write',args:{...candidate(),summary:writes.length?'第二版候选':'第一版候选'}};
  }});
});
test('并发载入本地示例仍只创建一组课堂和模板版本',async()=>setup(async service=>{
  const groups=await Promise.all(Array.from({length:4},()=>service.sampleClasses()));const classes=await service.list();
  assert.equal(classes.length,groups[0].length);assert.ok(groups.every(group=>group.every(c=>groups[0].some(x=>x.id===c.id))));
  const templates=await service.templates();assert.equal(templates.versions.length,1);
}));
test('已完成或已取消任务不会被迟到的暂停请求改回可续跑状态',async()=>setup(async service=>{
  const c=await newClass(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'你好'});await waitRun(service,'agent-'+j.id);
  assert.equal((await agent.control(c.id,j.id,'pause')).status,'completed');assert.equal((await agent.control(c.id,j.id,'cancel')).status,'completed');
  await assert.rejects(agent.control(c.id,j.id,'resume'),e=>e.statusCode===409);
  await service.store.update('feedback-job-'+j.id,undefined,null,x=>{x.status='cancelled';return x;});assert.equal((await agent.control(c.id,j.id,'pause')).status,'cancelled');
}));
test('直接写入和计划内候选的引用错误先反馈修正，合法后才执行写入',async()=>{
  for(const action of ['tool','plan']){
    let attempts=0;
    await setup(async service=>{
      const c=await newClass(service),agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'完善报告'});await waitRun(service,'agent-'+j.id);
      const job=await service.store.read('feedback-job-'+j.id,null),saved=await service.read(c.id);assert.equal(job.status,'completed',job.error);assert.equal(attempts,2);assert.equal(saved.reports.length,1);assert.deepEqual(saved.reports[0].findings[0].evidenceIds,['course']);assert.equal(job.observations.filter(o=>o.startsWith('输出校验未通过')).length,1);
    },{modelCall:async(system,input)=>{
      if(input.toolResults.length)return {action:'reply',reply:'修订已保存。'};
      attempts++;if(attempts===2){assert.match(input.feedback,/缺少引用/);assert.match(input.feedback,/course/);}
      const args=candidate();if(attempts===1)args.findings[0].evidenceIds=[];
      return action==='tool'?{action,tool:'report.write',args}:{action,steps:[{title:'保存报告',tool:'report.write',args}]};
    }});
  }
});
test('模型遗漏建议数组不能被当成清空建议，原成果保留',async()=>setup(async service=>{
  let c=await newClass(service);c=await service.command(c.id,{revision:c.revision,action:'suggestions',suggestions:[{id:'keep',text:'保留的重要建议',evidenceIds:['course']}]});
  const agent=new FeedbackAgent(service),j=await agent.start(c.id,{revision:c.revision,request:'完善建议'});await waitRun(service,'agent-'+j.id);
  const job=await service.store.read('feedback-job-'+j.id,null),saved=await service.read(c.id);assert.equal(job.status,'failed');assert.equal(saved.suggestionVersion,1);assert.equal(saved.suggestions[0].text,'保留的重要建议');
},{modelCall:async()=>({action:'tool',tool:'suggestions.write',args:{}})}));
test('重复保存相同模板、报告和建议不追加历史，不撤销报告确认',async()=>setup(async service=>{
  let c=await newClass(service);c=await service.update(c.id,c.revision,x=>{x.reports=[{id:'noop-report',version:1,text:'教师已确认的报告',confirmed:true,history:[]}];x.currentReportId='noop-report';return x;});
  c=await service.command(c.id,{revision:c.revision,action:'suggestions',suggestions:[{id:'keep',text:'保留建议',evidenceIds:['course']}]});
  let templates=await service.templates();const count=templates.versions.length,revision=c.revision;
  for(let i=0;i<20;i++){
    templates=await service.saveTemplate({revision:templates.revision,template:templates.versions.at(-1)});
    c=await service.command(c.id,{revision:c.revision,action:'report',reportId:'noop-report',baseVersion:1,text:'教师已确认的报告'});
    c=await service.command(c.id,{revision:c.revision,action:'suggestions',baseSuggestionVersion:1,suggestions:c.suggestions});
  }
  assert.equal(templates.versions.length,count);assert.equal(c.revision,revision);assert.equal(c.reports[0].history.length,0);assert.equal(c.reports[0].version,1);assert.equal(c.reports[0].confirmed,true);assert.equal(c.suggestionHistory.length,1);
  c=await service.command(c.id,{revision:c.revision,action:'report',reportId:'noop-report',baseVersion:1,text:'确实修改了的报告'});assert.equal(c.reports[0].history.length,1);assert.equal(c.reports[0].confirmed,false);
}));
test('重复关联来源或排除状态不创建新快照与业务版本，实际变更仍标记报告过期',async()=>setup(async service=>{
  let c=await withRecords(service);
  const t={id:'source-one',audioId:'audio-one',segments:[]};
  await service.store.update('classroom',undefined,{revision:0},()=>({course:{title:'课程'},transcriptVersions:[t],reports:[]}));
  c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:t.id});
  await service.store.update('workspace',undefined,{revision:0},()=>({resources:[{id:'ppt-one',type:'ppt',name:'PPT',currentVersionId:'v-one',versions:[{id:'v-one',content:{slides:[]}}]}]}));
  c=await service.command(c.id,{revision:c.revision,action:'linkPpt',resourceId:'ppt-one'});
  const revision=c.revision,sourceVersion=c.sourceVersion,dataVersion=c.dataVersion;
  for(let i=0;i<20;i++){c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:t.id});c=await service.command(c.id,{revision:c.revision,action:'linkPpt',resourceId:'ppt-one'});c=await service.command(c.id,{revision:c.revision,action:'exclude',recordId:'record-0',excluded:false,reason:''});}
  assert.equal(c.revision,revision);assert.equal(c.sourceVersion,sourceVersion);assert.equal(c.dataVersion,dataVersion);assert.equal((await readdir(service.store.root)).filter(f=>f.startsWith('feedback-source-')).length,1);
  c=await service.command(c.id,{revision:c.revision,action:'exclude',recordId:'record-0',excluded:true});assert.equal(c.dataVersion,dataVersion+1);
}));
test('相同导入预览复用文件，过期预览被回收，截止时间变化后必须重新预览',async()=>setup(async service=>{
  let c=await newClass(service);const data={records:[{id:'one',answers:{difficulty:'ok'}}]},ids=[];
  for(let i=0;i<20;i++)ids.push((await service.previewImport(c.id,{data})).id);
  assert.equal(new Set(ids).size,1);assert.equal((await readdir(service.store.root)).filter(f=>f.startsWith('feedback-import-')).length,1);
  c=await service.command(c.id,{revision:c.revision,action:'update',deadline:'2027-01-01T00:00:00Z'});
  await assert.rejects(service.commitImport(c.id,c.revision,ids[0],false),e=>e.statusCode===409);
  await service.store.update('feedback-import-deadbeef',undefined,{revision:0},()=>({classId:c.id,createdAt:'2000-01-01T00:00:00Z'}));service.previewCleanupAt=0;
  const p=await service.previewImport(c.id,{data});assert.equal(await service.store.read('feedback-import-deadbeef',null),null);c=await service.commitImport(c.id,c.revision,p.id,false);assert.equal(c.records.length,1);assert.equal(c.records[0].unknownTime,true);
}));
test('持续分批导入达到课堂总量上限后原子拒绝，已有记录不被覆盖',async()=>setup(async service=>{
  let c=await newClass(service);const previous=process.env.FEEDBACK_MAX_RECORDS;process.env.FEEDBACK_MAX_RECORDS='3';
  try{
    for(let i=0;i<3;i++){const p=await service.previewImport(c.id,{data:{records:[{id:'record-'+i,answers:{difficulty:'ok'}}]}});c=await service.commitImport(c.id,c.revision,p.id,false);}
    const p=await service.previewImport(c.id,{data:{records:[{id:'overflow',answers:{difficulty:'hard'}}]}}),before=JSON.stringify(c.records);await assert.rejects(service.commitImport(c.id,c.revision,p.id,false),e=>e.statusCode===413);assert.equal(JSON.stringify((await service.read(c.id)).records),before);
    const update=await service.previewImport(c.id,{data:{records:[{id:'record-0',answers:{difficulty:'hard'}}]}});c=await service.commitImport(c.id,c.revision,update.id,false);assert.equal(c.records.length,3);assert.equal(c.records[0].answers.difficulty,'hard');
  }finally{if(previous===undefined)delete process.env.FEEDBACK_MAX_RECORDS;else process.env.FEEDBACK_MAX_RECORDS=previous;}
}));
test('同版本20个并发发送只接纳一个，不留下未关联的运行任务和输入快照',async()=>setup(async service=>{
  const c=await newClass(service),agent=new FeedbackAgent(service),results=await Promise.allSettled(Array.from({length:20},()=>agent.start(c.id,{revision:c.revision,request:'你好'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.statusCode===409));
  await Promise.all([...service.runs.values()].map(r=>r.promise));const files=await readdir(service.store.root);
  assert.equal(files.filter(f=>f.startsWith('feedback-job-')).length,1);assert.equal(files.filter(f=>f.startsWith('feedback-input-')).length,1);assert.equal((await service.read(c.id)).jobIds.length,1);
}));
test('排队的问卷请求取消后立即移出队列，不等其他慢请求结束',async()=>setup(async service=>{
  const entered=deferred(),release=deferred();let called=0;
  const first=service.connectionTask(()=>{entered.resolve();return release.promise;});await entered.promise;
  const controllers=Array.from({length:20},()=>new AbortController()),pending=controllers.map(c=>service.connectionTask(()=>{called++;},0,c.signal).then(()=>0,e=>e.statusCode));controllers.forEach(c=>c.abort());
  const length=service.connectionQueue.length,result=await Promise.race([Promise.all(pending),new Promise(r=>setTimeout(()=>r('not-cancelled'),50))]);release.resolve();await first;await Promise.all(pending);
  assert.notEqual(result,'not-cancelled');assert.deepEqual(result,Array(20).fill(499));assert.equal(length,0);assert.equal(called,0);
}));
test('绑定等待中课堂版本变化时不抢占远端表单归属，另一课堂仍可绑定',async()=>{
  const entered=deferred(),release=deferred();let delay=true,form;
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});let a=await newClass(service),b=await newClass(service);form=formFor(providerForm(a.template,a,null));
    for(const c of [a,b])await service.update(c.id,c.revision,x=>{x.ended=true;x.publish={status:'uncertain',template:x.template};return x;});a=await service.read(a.id);b=await service.read(b.id);
    const pending=service.bind(a.id,a.revision,form.token).then(value=>({value}),error=>({error}));await entered.promise;
    a=await service.command(a.id,{revision:a.revision,action:'update',description:'绑定期间的新说明'});delay=false;release.resolve();const result=await pending;assert.equal(result.error?.statusCode,409);
    const registry=await service.store.read('feedback-form-bindings',{claims:{}});assert.equal(Object.keys(registry.claims).length,0);
    b=await service.bind(b.id,b.revision,form.token);assert.equal(b.publish.token,form.token);assert.equal((await service.read(a.id)).publish.token,undefined);
  },{clientFactory:()=>({getMe:async()=>({id:'same-account'}),getForm:async()=>{if(delay){entered.resolve();await release.promise;}return form;}})});
});
test('不存在的日期和24点时间不能被自动归一化后计入有效反馈',async()=>setup(async service=>{
  let c=await newClass(service);
  for(const deadline of ['2026-02-30T00:00:00Z','2026-01-01T24:00:00Z'])await assert.rejects(service.command(c.id,{revision:c.revision,action:'update',deadline}),e=>e.statusCode===422);
  const t=validateTemplate(tiny()),deadline='2026-04-01T00:00:00Z';
  for(const submittedAt of ['2026-02-30T12:00:00Z','2026-01-01T24:00:00Z','2026-02-29T00:00:00Z']){const r=validateRecord({id:'invalid-time',submittedAt,answers:{difficulty:'ok'}},t,deadline);assert.equal(r.unknownTime,true,submittedAt);assert.equal(statistics([r],t).eligible,0);}
  assert.equal(validateRecord({submittedAt:'2024-02-29T23:59:59+08:00',answers:{difficulty:'ok'}},t,deadline).unknownTime,false);
}));
test('任务文件准备后课堂写入失败时回收任务及输入，原课堂不出现半条消息',async()=>setup(async service=>{
  const c=await newClass(service),originalUpdate=service.store.update.bind(service.store),classKey='feedback-class-'+c.id;
  service.store.update=(key,revision,fallback,change,options)=>originalUpdate(key,revision,fallback,async value=>{const next=await change(value);if(key===classKey&&next.jobIds?.length)throw Object.assign(new Error('模拟 ENOSPC'),{code:'ENOSPC'});return next;},options);
  const agent=new FeedbackAgent(service);await assert.rejects(agent.start(c.id,{revision:c.revision,request:'你好'}),e=>e.code==='ENOSPC');
  const files=await readdir(service.store.root);assert.equal(files.filter(f=>f.startsWith('feedback-job-')||f.startsWith('feedback-input-')).length,0);assert.equal((await service.read(c.id)).messages.length,0);assert.equal(service.runs.size,0);
}));
test('分页同步中途失败不提交前半批，重试完整获取后去重并保留本地反馈',async()=>{
  let form,fail=true;
  await setup(async service=>{
    await service.saveConfig({revision:0,accessToken:'provider-test-fixture'});let c=await withRecords(service),before=JSON.stringify(c.records),version=c.dataVersion;
    await service.end(c.id,c.revision);await waitRun(service,'publish-'+c.id);c=await service.read(c.id);
    service.launchSync(c.id);await waitRun(service,'sync-'+c.id);c=await service.read(c.id);assert.equal(c.sync.status,'failed');assert.equal(JSON.stringify(c.records),before);assert.equal(c.dataVersion,version);
    fail=false;service.launchSync(c.id);await waitRun(service,'sync-'+c.id);c=await service.read(c.id);assert.equal(c.sync.status,'complete');assert.equal(c.records.length,3);assert.equal(c.dataVersion,version+1);assert.ok(c.records.some(r=>r.id==='record-0'));
    service.launchSync(c.id);await waitRun(service,'sync-'+c.id);c=await service.read(c.id);assert.equal(c.records.length,3);assert.equal(c.dataVersion,version+1);
  },{clientFactory:()=>({getMe:async()=>({id:'sync-account'}),createForm:async payload=>(form=formFor(payload)),getForm:async()=>form,listEntries:async(token,{next})=>{if(next&&fail)throw Object.assign(new Error('模拟后续页失败'),{status:503});return {data:[{serial_number:next?2:1,field_1:'hard'}],next:next?null:'second-page'};}})});
});
test('导入以answers为准，旧rawAnswers不能在调整截止时间后悄悄恢复旧答案',async()=>setup(async service=>{
  let c=await newClass(service);const p=await service.previewImport(c.id,{data:{records:[{id:'corrected',answers:{difficulty:'ok'},rawAnswers:{difficulty:'hard'}}]}});c=await service.commitImport(c.id,c.revision,p.id,false);assert.equal(c.records[0].answers.difficulty,'ok');
  c=await service.command(c.id,{revision:c.revision,action:'update',deadline:'2027-01-01T00:00:00Z'});assert.equal(c.records[0].answers.difficulty,'ok');assert.equal(c.records[0].rawAnswers.difficulty,'ok');
}));
