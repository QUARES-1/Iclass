import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {CourseService} from '../src/courses.js';
import {Store} from '../src/store.js';
import {createApi,json} from '../src/api.js';
import {ModelSettings} from '../src/modelSettings.js';
import {reserveDisk} from '../src/storageQuota.js';

async function fixture(fn,{modelCall=async()=>({action:'reply',reply:'你好！'})}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'course-workspace-'));
 const service=new CourseService(root),settings=new ModelSettings(root,{LLM_API_KEY:'course-test-fixture'});
 const api=createApi(new URL('..',import.meta.url).pathname,{dataDir:root,modelSettings:settings,modelCall});
 const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'不存在'},404);}catch(error){if(!res.headersSent)json(res,{error:error.message},error.statusCode||500);else res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const get=async url=>{const response=await fetch(base+url);const body=await response.json();assert.equal(response.status,200,body.error);return body;};
 const post=async(url,body)=>{const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 try{await fn({service,settings,root,base,get,post});}finally{for(let i=0;i<200&&api.isBusy();i++)await new Promise(resolve=>setTimeout(resolve,5));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
}
async function courseAndLessons(service){const courseId=randomUUID(),a=randomUUID(),b=randomUUID();await service.createCourse({id:courseId,title:'数据结构'});for(const [id,title]of [[a,'平衡树'],[b,'图的遍历']])await service.createLesson(courseId,{id,title,date:'2026-10-21'});return {courseId,a,b};}
const scoped=(url,id)=>url+(url.includes('?')?'&':'?')+'lesson='+id;
function uploadStream(name='teacher.md',size){const req=new PassThrough();req.headers=size===undefined?{}:{'content-length':String(size)};return {req,url:new URL('http://test/resources?name='+encodeURIComponent(name))};}
async function until(get,url,check){for(let i=0;i<150;i++){const value=await get(url);if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('任务未按预期结束');}

test('空项目先建课程和课次，重复创建及重启不追加记录',async()=>fixture(async({service,root})=>{
 assert.equal((await service.catalog()).courses.length,0);const courseId=randomUUID(),lessonId=randomUUID();
 for(let i=0;i<20;i++)await service.createCourse({id:courseId,title:'算法设计'});
 for(let i=0;i<20;i++)await service.createLesson(courseId,{id:lessonId,title:'分治',date:'2026-10-21'});
 const c=await new CourseService(root).catalog();assert.equal(c.courses.length,1);assert.equal(c.lessons.length,1);
 await assert.rejects(service.createLesson(courseId,{id:lessonId,title:'不同课次',date:'2026-10-21'}),/标识已使用/);
 await assert.rejects(service.createLesson(courseId,{title:'坏日期',date:'2026-02-30'}),/日期无效/);
}));

test('历史数据只登记历史课程，不迁移、不覆盖原文件，反复读取保持唯一',async()=>fixture(async({service,root})=>{
 const original=JSON.stringify({revision:5,requirements:{topic:'原资料'},resources:[],materials:[],messages:[]});await writeFile(path.join(root,'workspace.json'),original);
 for(let i=0;i<10;i++){const c=await service.catalog();assert.equal(c.courses.filter(c=>c.legacy).length,1);assert.equal(c.lessons.filter(l=>l.legacy).length,1);}
 assert.equal(await readFile(path.join(root,'workspace.json'),'utf8'),original);assert.equal((await readdir(root)).includes('lessons'),false);
}));

test('两节课的备课、音频说明、反馈和上下文分别持久化，设置和模板共用',async()=>fixture(async({service,get,post})=>{
 const {a,b}=await courseAndLessons(service);const wa=await get(scoped('/api/workspace',a)),wb=await get(scoped('/api/workspace',b));assert.equal(wa.requirements.topic,'平衡树');assert.equal(wb.requirements.topic,'图的遍历');
 const saved=await post(scoped('/api/workspace',a),{revision:wa.revision,action:'settings',requirements:{...wa.requirements,topic:'甲班Treap'}});assert.equal(saved.status,200);
 assert.equal((await get(scoped('/api/workspace',b))).requirements.topic,'图的遍历');
 const ca=await get(scoped('/api/classroom',a));assert.equal((await post(scoped('/api/classroom',a),{revision:ca.revision,action:'course',course:{title:'仅甲班录音',description:'甲班课堂'}})).status,200);
 assert.equal((await get(scoped('/api/classroom',b))).course.title,'图的遍历');
 const fa=await get(scoped('/api/feedback/bootstrap',a)),fb=await get(scoped('/api/feedback/bootstrap',b));assert.deepEqual(fa.sessions.map(c=>c.id),[a]);assert.deepEqual(fb.sessions.map(c=>c.id),[b]);assert.equal(fa.templates.versions[0].id,fb.templates.versions[0].id);
 assert.equal((await post(scoped('/api/feedback/sessions',a),{title:'不能另建课堂'})).status,409);
 const cfg=await get('/api/model-settings');assert.equal((await post('/api/model-settings',{revision:cfg.revision,model:'shared-course-model'})).status,200);assert.equal((await get(scoped('/api/model-settings',b))).model,'shared-course-model');
}));

test('错误课次标识和跨课程资源引用不能回退或串入其他课程',async()=>fixture(async({service,get,post})=>{
 const {courseId,a,b}=await courseAndLessons(service),other=randomUUID();await service.createCourse({id:other,title:'另一门课程'});
 await service.addLink(courseId,{title:'平衡树讲义',url:'https://example.test/treap',description:'重点讲解split与merge'});const catalog=await service.catalog(),resource=catalog.resources[0];
 await assert.rejects(service.updateLesson(b,{revision:catalog.revision,action:'resources',resourceIds:[resource.id,resource.id],generatedIds:[]}),/不能重复/);
 const otherLesson=randomUUID();await service.createLesson(other,{id:otherLesson,title:'线性代数',date:'2026-10-21'});
 const latest=await service.catalog();await assert.rejects(service.updateLesson(otherLesson,{revision:latest.revision,action:'resources',resourceIds:[resource.id],generatedIds:[]}),/不属于/);
 assert.equal((await post('/api/workspace?lesson=..%2F..',{revision:0,action:'clear'})).status,404);
 for(const query of ['lesson=','lesson='+a+'&lesson='+b])assert.equal((await post('/api/workspace?'+query,{revision:0,action:'clear'})).status,404);
 const before=await get(scoped('/api/workspace',a));const bad=await post(scoped('/api/feedback/sessions/'+b,a),{revision:0,action:'clearConversation'});assert.equal(bad.status,404);assert.equal((await get(scoped('/api/workspace',a))).revision,before.revision);
}));

test('教师上传原文件与正文保留，重复并发上传去重，多个课次可复用同一资源',async()=>fixture(async({service,base,get,post,root})=>{
 const {courseId,a,b}=await courseAndLessons(service),endpoint=base+'/api/courses/'+courseId+'/resources?kind=file&name=teacher.md';
 const responses=await Promise.all([1,2,3].map(()=>fetch(endpoint,{method:'POST',body:'教师讲义：split 按键拆树，merge 合并有序的两棵树。'})));for(const r of responses)assert.equal(r.status,200,await r.text());
 let catalog=await service.catalog();assert.equal(catalog.resources.length,1);const r=catalog.resources[0];assert.equal(r.parseStatus,'已提取正文');
 for(const lessonId of [a,b]){catalog=await service.catalog();await service.updateLesson(lessonId,{revision:catalog.revision,action:'resources',resourceIds:[r.id],generatedIds:[]});}
 const original=await fetch(base+'/api/courses/'+courseId+'/resources/'+r.id+'/download');assert.match(await original.text(),/教师讲义/);
 const wa=await get(scoped('/api/workspace',a));const first=await post('/api/lessons/'+a+'/prepare',{revision:wa.revision,resourceId:r.id});assert.equal(first.status,200);assert.equal(first.body.materials.length,1);
 const duplicate=await post('/api/lessons/'+a+'/prepare',{revision:first.body.revision,resourceId:r.id});assert.equal(duplicate.status,200);assert.equal(duplicate.body.revision,first.body.revision);assert.equal(duplicate.body.materials.length,1);
 assert.equal((await get(scoped('/api/workspace',b))).materials.length,0);assert.equal((await readdir(path.join(root,'course-files'))).filter(f=>!f.endsWith('.tmp')).length,1);
}));

test('文件限制、空文件、失败解析和取消上传不能覆盖已有资源',async()=>fixture(async({service,base})=>{
 const {courseId}=await courseAndLessons(service),endpoint=base+'/api/courses/'+courseId+'/resources?kind=file&name=';
 assert.equal((await fetch(endpoint+'empty.txt',{method:'POST',body:''})).status,400);
 assert.equal((await fetch(endpoint+'program.exe',{method:'POST',body:'binary'})).status,415);
 const bad=await fetch(endpoint+'broken.docx',{method:'POST',body:'not a zip'});assert.equal(bad.status,200);
 let catalog=await service.catalog();assert.equal(catalog.resources.length,1);assert.match(catalog.resources[0].parseStatus,/提取失败/);
 const large=await fetch(endpoint+'large.pdf',{method:'POST',body:Buffer.alloc(50*1024**2+1)});assert.equal(large.status,413);catalog=await service.catalog();assert.equal(catalog.resources.length,1);
}));

test('课次选择的外部资料进入真实分析输入和引用，更新资料使报告过期且历史依据保留',async()=>{
 let analyzed=false;
 await fixture(async({service,get,post,root})=>{
  const {courseId,a}=await courseAndLessons(service);await service.addLink(courseId,{title:'教师演示网页',url:'https://example.test/trees',description:'演示分裂和合并，先检查空树，再演示根结点的优先级选择。'});
  const catalog=await service.catalog(),resource=catalog.resources[0];await service.updateLesson(a,{revision:catalog.revision,action:'resources',resourceIds:[resource.id],generatedIds:[]});
  await get(scoped('/api/feedback/bootstrap',a));const c=await get(scoped('/api/feedback/sessions/'+a,a));
  const started=await post(scoped('/api/feedback/sessions/'+a+'/chat',a),{revision:c.revision,request:'请结合本课次教学资料复盘'});assert.equal(started.status,202,started.body.error);
  await until(get,scoped('/api/feedback/sessions/'+a+'/job?id='+started.body.id,a),j=>['completed','failed'].includes(j.status));
  const finished=await get(scoped('/api/feedback/sessions/'+a,a));assert.equal(finished.reports.length,1);assert.ok(analyzed);assert.equal(finished.reports[0].stale,false);
  const evidence=await get(scoped('/api/feedback/sessions/'+a+'/evidence?reportId='+finished.reports[0].id,a));assert.match(evidence.teachingResources[0].content,/先检查空树/);
  const current=await service.catalog();await service.updateResource(courseId,resource.id,{revision:current.revision,title:'教师演示网页',description:'新的课堂说明'});
  assert.equal((await get(scoped('/api/feedback/sessions/'+a,a))).reports[0].stale,true);
  assert.match((await get(scoped('/api/feedback/sessions/'+a+'/evidence?reportId='+finished.reports[0].id,a))).teachingResources[0].content,/先检查空树/);
 },{modelCall:async(_system,input)=>{
  if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'报告已保存。'}:{action:'tool',tool:'analysis.generate',args:{}};
  if(input.phase==='feedback-analyze'){const resource=input.items.find(i=>i.evidenceId.startsWith('resource:'));assert.ok(resource);assert.match(resource.content,/先检查空树/);analyzed=true;return {summary:'本课次使用教师提供的树演示资料。当前没有课堂转写或学生反馈，不能推断学生实际表现。',findings:[{text:'演示材料包含空树检查与优先级选择。',kind:'observation',evidenceIds:[resource.evidenceId]}],suggestions:[{text:'下一次演示先让学生预测空树情况下的返回值，再运行完整函数。',evidenceIds:[resource.evidenceId]}]};}
  throw new Error('unexpected phase');
 }});
});

test('课次自动关联自己的转写，另一课次不能读取该转写',async()=>fixture(async({service,get,post})=>{
 const {a,b}=await courseAndLessons(service);await get(scoped('/api/classroom',a));const store=new Store(service.lessonRoot((await service.lesson(a)).lesson));
 await store.update('classroom',undefined,{},c=>{c.transcriptVersions=[{id:'transcript-a',audioId:null,source:'asr',segments:[{id:'segment-a',start:0,end:5,text:'这一堂课讲平衡树'}]}];c.currentTranscriptId='transcript-a';return c;});
 await get(scoped('/api/feedback/bootstrap',a));const ca=await get(scoped('/api/feedback/sessions/'+a,a));assert.equal(ca.source.transcriptId,'transcript-a');
 await get(scoped('/api/feedback/bootstrap',b));const cb=await get(scoped('/api/feedback/sessions/'+b,b));assert.equal(cb.source,null);
 assert.equal((await post(scoped('/api/feedback/sessions/'+b,b),{revision:cb.revision,action:'linkAudio',transcriptId:'transcript-a'})).status,422);
}));

test('归档课程和课次保留原数据、拒绝写入，恢复后可以继续编辑',async()=>fixture(async({service,get,post})=>{
 const {courseId,a}=await courseAndLessons(service);const before=await get(scoped('/api/workspace',a));let catalog=await service.catalog();await service.updateLesson(a,{revision:catalog.revision,action:'archive'});
 assert.equal((await post(scoped('/api/workspace',a),{revision:before.revision,action:'clear'})).status,409);assert.equal((await get(scoped('/api/workspace',a))).requirements.topic,before.requirements.topic);
 catalog=await service.catalog();await service.updateLesson(a,{revision:catalog.revision,action:'restore'});catalog=await service.catalog();await service.updateCourse(courseId,{revision:catalog.revision,action:'archive'});
 assert.equal((await post(scoped('/api/classroom',a),{revision:0,action:'clear'})).status,409);catalog=await service.catalog();await service.updateCourse(courseId,{revision:catalog.revision,action:'restore'});
 const latest=await get(scoped('/api/workspace',a));assert.equal((await post(scoped('/api/workspace',a),{revision:latest.revision,action:'clear'})).status,200);
}));

test('课次共用整个数据目录的空间额度，不会各自获得一份额外额度',async()=>fixture(async({service,root,get})=>{
 const {a,b}=await courseAndLessons(service);await get(scoped('/api/workspace',a));await get(scoped('/api/workspace',b));
 const previous=process.env.DATA_MAX_BYTES;process.env.DATA_MAX_BYTES='200000';
 try{const release=await reserveDisk(service.lessonRoot((await service.lesson(a)).lesson),150000);await assert.rejects(reserveDisk(service.lessonRoot((await service.lesson(b)).lesson),150000),/空间额度不足/);release(0);}finally{if(previous===undefined)delete process.env.DATA_MAX_BYTES;else process.env.DATA_MAX_BYTES=previous;}
}));

test('资料删除须先解除课次引用，之后释放原文件，不删除已加入备课的内容',async()=>fixture(async({service,base,get,post,root})=>{
 const {courseId,a}=await courseAndLessons(service);assert.equal((await fetch(base+'/api/courses/'+courseId+'/resources?kind=file&name=remove.txt',{method:'POST',body:'教师外部资料'})).status,200);
 let catalog=await service.catalog();const resource=catalog.resources[0];await service.updateLesson(a,{revision:catalog.revision,action:'resources',resourceIds:[resource.id],generatedIds:[]});
 const w=await get(scoped('/api/workspace',a));assert.equal((await post('/api/lessons/'+a+'/prepare',{revision:w.revision,resourceId:resource.id})).status,200);
 catalog=await service.catalog();await assert.rejects(service.removeResource(courseId,resource.id,{revision:catalog.revision}),/仍有课次使用/);
 await service.updateLesson(a,{revision:catalog.revision,action:'resources',resourceIds:[],generatedIds:[]});catalog=await service.catalog();await service.removeResource(courseId,resource.id,{revision:catalog.revision});
 assert.equal((await service.catalog()).resources.length,0);assert.equal((await get(scoped('/api/workspace',a))).materials.length,1);assert.equal((await readdir(path.join(root,'course-files'))).length,0);
}));

test('下一课建议可跨课次只读交接，反复打开不复制资料或创建模型任务',async()=>fixture(async({service,get,post})=>{
 const {courseId,a,b}=await courseAndLessons(service);await get(scoped('/api/feedback/bootstrap',a));let c=await get(scoped('/api/feedback/sessions/'+a,a));
 const suggestionId=randomUUID();assert.equal((await post(scoped('/api/feedback/sessions/'+a,a),{revision:c.revision,action:'suggestions',baseSuggestionVersion:0,suggestions:[{id:suggestionId,text:'下一堂课增加空树情况下的完整函数调用示范。',evidenceIds:[]}]})).status,200);
 c=await get(scoped('/api/feedback/sessions/'+a,a));const h=await post(scoped('/api/feedback/sessions/'+a+'/handoff',a),{revision:c.revision,ids:[suggestionId]});assert.equal(h.status,200);
 for(let i=0;i<10;i++){const transferred=await get('/api/lessons/'+a+'/handoff?id='+h.body.id+'&target='+b);assert.equal(transferred.target,null);assert.equal(transferred.targetLessonId,b);assert.equal(transferred.stale,false);assert.match(transferred.request,/空树/);}
 assert.equal((await get(scoped('/api/workspace',b))).messages.length,0);assert.equal((await get(scoped('/api/workspace',b))).resources.length,0);
 const other=randomUUID(),otherLesson=randomUUID();await service.createCourse({id:other,title:'不同课程'});await service.createLesson(other,{id:otherLesson,title:'不应混入',date:'2026-10-21'});await assert.rejects(service.transferredHandoff(a,h.body.id,otherLesson),/同一课程/);
}));

test('资源说明增大后仍可查看历史报告，并明确提示减少选择后再分析',async()=>fixture(async({service,get,root})=>{
 const {courseId,a}=await courseAndLessons(service);await service.addLink(courseId,{title:'讲义',url:'https://example.test/large',description:'原说明'});let catalog=await service.catalog(),resource=catalog.resources[0];await service.updateLesson(a,{revision:catalog.revision,action:'resources',resourceIds:[resource.id],generatedIds:[]});
 await get(scoped('/api/feedback/bootstrap',a));await service.store.update('course-content-'+resource.id,undefined,{revision:0},()=>({content:'教'.repeat(500001)}));
 catalog=await service.catalog();await service.updateResource(courseId,resource.id,{revision:catalog.revision,title:'讲义',description:'扩展了正文'});
 const current=await get(scoped('/api/feedback/sessions/'+a,a));assert.match(current.resourceError,/超过50万/);assert.equal(current.teachingResources.length,0);assert.equal(current.title,'平衡树');
}));

test('正在运行智能体时拒绝归档所属课程，暂停或完成后才允许归档',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 await fixture(async({service,get,post})=>{
  const {courseId,a}=await courseAndLessons(service),w=await get(scoped('/api/workspace',a));
  try{const task=await post(scoped('/api/workspace/agent',a),{revision:w.revision,request:'你好'});assert.equal(task.status,202);await started;
   const catalog=await service.catalog();assert.equal((await post('/api/courses/'+courseId,{revision:catalog.revision,action:'archive'})).status,409);release();await until(get,scoped('/api/workspace/agent/'+task.body.job.id,a),j=>j.stage==='completed');
  }finally{release();}
 },{modelCall:async()=>{entered();await gate;return {action:'reply',reply:'你好！'};}});
});

test('课程信息按自身版本保护，资料上传不制造冲突，刷新列表不能掩盖并发修改',async()=>fixture(async({service})=>{
 const {courseId}=await courseAndLessons(service);let c=await service.catalog(),stale=c.revision;
 await service.addLink(courseId,{title:'额外链接',url:'https://example.test/extra'});
 c=await service.updateCourse(courseId,{revision:stale,metadataRevision:0,action:'update',title:'教师甲的课程名',description:'甲的说明'});assert.equal(c.courses[0].metadataRevision,1);
 await assert.rejects(service.updateCourse(courseId,{revision:c.revision,metadataRevision:0,action:'update',title:'陈旧标题',description:'陈旧说明'}),/其他页面更新/);
 assert.equal((await service.catalog()).courses[0].title,'教师甲的课程名');
}));

test('课次信息与资源选择分开检查版本，任何一方刷新都不能覆盖另一标签的编辑',async()=>fixture(async({service})=>{
 const {courseId,a}=await courseAndLessons(service);await service.addLink(courseId,{title:'资源',url:'https://example.test/lesson'});let c=await service.catalog(),r=c.resources[0];
 c=await service.updateLesson(a,{revision:c.revision,resourceRevision:0,action:'resources',resourceIds:[r.id],generatedIds:[]});
 c=await service.updateLesson(a,{revision:c.revision-1,metadataRevision:0,action:'update',title:'甲的课次标题',date:'2026-10-21',description:'甲的修改'});
 assert.equal(c.lessons.find(l=>l.id===a).resourceRevision,1);assert.equal(c.lessons.find(l=>l.id===a).metadataRevision,1);
 await assert.rejects(service.updateLesson(a,{revision:c.revision,metadataRevision:0,action:'update',title:'旧标题',date:'2026-10-21',description:''}),/其他页面更新/);
 c=await service.updateLesson(a,{revision:c.revision,resourceRevision:1,action:'resources',resourceIds:[],generatedIds:[]});
 await assert.rejects(service.updateLesson(a,{revision:c.revision,resourceRevision:1,action:'resources',resourceIds:[r.id],generatedIds:[]}),/其他页面更新/);
 assert.deepEqual((await service.lesson(a)).lesson.resourceIds,[]);
}));

test('资源说明的并发保护不被目录刷新绕过，相同内容重复保存不增加版本',async()=>fixture(async({service})=>{
 const {courseId}=await courseAndLessons(service);await service.addLink(courseId,{title:'讲义',url:'https://example.test/notes'});let c=await service.catalog(),r=c.resources[0];
 c=await service.updateResource(courseId,r.id,{revision:c.revision,metadataRevision:0,title:'讲义',description:'远端已经更新的说明'});
 await assert.rejects(service.updateResource(courseId,r.id,{revision:c.revision,metadataRevision:0,title:'讲义',description:'本地过期说明'}),/其他页面更新/);
 const unchanged=await service.updateResource(courseId,r.id,{revision:c.revision,metadataRevision:1,title:'讲义',description:'远端已经更新的说明'});assert.equal(unchanged.revision,c.revision);assert.equal(unchanged.resources[0].metadataRevision,1);
}));

test('同时发起六次上传仍最多处理三份，拒绝和取消后释放槽位与临时文件',async()=>fixture(async({service,root})=>{
 const {courseId}=await courseAndLessons(service),streams=Array.from({length:6},(_,i)=>uploadStream('parallel-'+i+'.txt',100));
 const outcomes=streams.map(({req,url})=>service.upload(courseId,req,url).then(()=>200,e=>e.statusCode||500));
 try{await new Promise(r=>setTimeout(r,80));assert.equal(service.pendingUploads.size,3);}
 finally{for(const {req}of streams)req.end('教师讲义');await Promise.all(outcomes);}
 assert.deepEqual((await Promise.all(outcomes)).sort(),[200,200,200,429,429,429]);assert.equal(service.pendingUploads.size,0);
 assert.equal((await readdir(path.join(root,'course-files'))).some(n=>n.endsWith('.tmp')),false);
}));

test('真实中断和未知长度超限上传不会留下原文件、正文或占用额度',async()=>fixture(async({service,root})=>{
 const {courseId}=await courseAndLessons(service),cancel=uploadStream('cancel.md');
 const task=service.upload(courseId,cancel.req,cancel.url);const rejected=assert.rejects(task,/教师取消/);
 while(!service.pendingUploads.size)await new Promise(r=>setTimeout(r,2));cancel.req.write('未完成的内容');cancel.req.destroy(new Error('教师取消'));await rejected;
 assert.equal(service.pendingUploads.size,0);assert.deepEqual(await readdir(path.join(root,'course-files')),[]);
 const large=uploadStream('large.pdf'),result=assert.rejects(service.upload(courseId,large.req,large.url),/最多50 MiB/);
 for(let i=0;i<51;i++){if(!large.req.write(Buffer.alloc(1024**2)))await new Promise(r=>large.req.once('drain',r));}large.req.end();await result;
 assert.equal((await service.catalog()).resources.length,0);assert.deepEqual(await readdir(path.join(root,'course-files')),[]);
 const release=await reserveDisk(root,1024);release(0);
}));

test('创建上传目录失败也会释放空间预留，修复目录后能继续上传',async()=>fixture(async({service,root})=>{
 const {courseId}=await courseAndLessons(service);await writeFile(path.join(root,'course-files'),'not a directory');
 const previous=process.env.DATA_MAX_BYTES;process.env.DATA_MAX_BYTES='1000000';
 try{const broken=uploadStream('retry.md',600000);broken.req.end('讲义');await assert.rejects(service.upload(courseId,broken.req,broken.url));
  const release=await reserveDisk(root,600000);release(0);await rm(path.join(root,'course-files'));const retry=uploadStream('retry.md',100);retry.req.end('讲义');await service.upload(courseId,retry.req,retry.url);
 }finally{if(previous===undefined)delete process.env.DATA_MAX_BYTES;else process.env.DATA_MAX_BYTES=previous;}
 assert.equal((await service.catalog()).resources.length,1);assert.equal(service.pendingUploads.size,0);
}));

test('资料库满时重传已有文件仍去重，新文件失败不残留正文或原文件',async()=>fixture(async({service,root})=>{
 const {courseId}=await courseAndLessons(service);const first=uploadStream('existing.md');first.req.end('教师已有讲义');await service.upload(courseId,first.req,first.url);
 await service.store.update('course-catalog',undefined,null,c=>{for(let i=1;i<200;i++)c.resources.push({id:String(i).padStart(64,'0'),courseId,title:'占位资料',kind:'link'});return c;});
 const before=await service.catalog(),files=await readdir(root);const duplicate=uploadStream('existing.md');duplicate.req.end('教师已有讲义');await service.upload(courseId,duplicate.req,duplicate.url);
 assert.equal((await service.catalog()).revision,before.revision);
 const extra=uploadStream('extra.md');extra.req.end('未录入的新讲义');await assert.rejects(service.upload(courseId,extra.req,extra.url),/数量上限/);
 assert.deepEqual((await readdir(root)).sort(),files.sort());assert.equal((await readdir(path.join(root,'course-files'))).length,1);
}));

test('等待写入时归档课次，旧页面不能用独立信息版本绕过归档保护',async()=>fixture(async({service})=>{
 const {a}=await courseAndLessons(service),catalog=await service.catalog(),change=service.change.bind(service);let entered,release;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 service.change=async(body,...args)=>{if(body.action==='update'){entered();await gate;}return change(body,...args);};
 const updating=service.updateLesson(a,{revision:catalog.revision,metadataRevision:0,action:'update',title:'不应写入',date:'2026-10-21',description:''});const rejected=assert.rejects(updating,/归档/);
 await started;await service.updateLesson(a,{revision:catalog.revision,action:'archive'});release();await rejected;assert.equal((await service.lesson(a)).lesson.title,'平衡树');
}));

test('同一原文件可被两个课程引用，删除其中一份不影响另一课程下载',async()=>fixture(async({service,base,root})=>{
 const {courseId}=await courseAndLessons(service),other=randomUUID();await service.createCourse({id:other,title:'另一个课程'});
 for(const cid of [courseId,other]){const stream=uploadStream('shared.md');stream.req.end('两个课程共用的原文件');await service.upload(cid,stream.req,stream.url);}
 let catalog=await service.catalog();const first=catalog.resources.find(r=>r.courseId===courseId),second=catalog.resources.find(r=>r.courseId===other);assert.notEqual(first.id,second.id);assert.equal(first.file,second.file);
 await service.removeResource(courseId,first.id,{revision:catalog.revision});const response=await fetch(base+'/api/courses/'+other+'/resources/'+second.id+'/download');assert.equal(response.status,200);assert.equal(await response.text(),'两个课程共用的原文件');
 catalog=await service.catalog();await service.removeResource(other,second.id,{revision:catalog.revision});assert.deepEqual(await readdir(path.join(root,'course-files')),[]);
}));

test('等待保存时整门课程归档也不能改写其课次，原信息和资源选择保留',async()=>fixture(async({service})=>{
 const {courseId,a}=await courseAndLessons(service),catalog=await service.catalog(),change=service.change.bind(service);let entered,release;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 service.change=async(body,...args)=>{if(body.action==='resources'){entered();await gate;}return change(body,...args);};
 const updating=service.updateLesson(a,{revision:catalog.revision,resourceRevision:0,action:'resources',resourceIds:[],generatedIds:[]});const rejected=assert.rejects(updating,/归档课程/);
 await started;await service.updateCourse(courseId,{revision:catalog.revision,action:'archive'});release();await rejected;assert.deepEqual((await service.lesson(a)).lesson.resourceIds,[]);
}));
