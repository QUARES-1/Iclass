import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/store.js';
import {StorageManager} from '../src/storageManager.js';
import {compactWorkspace} from '../src/agent.js';
import {emptyWorkspace} from '../src/workspace.js';
import {emptyClassroom} from '../src/classroom.js';

async function fixture(run){const dir=await mkdtemp(path.join(os.tmpdir(),'teaching-storage-'));try{await run(new Store(dir),dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('记录读取缓存隔离调用方修改，外部替换文件后立即失效',async()=>fixture(async(store)=>{
  await store.update('sample',0,{revision:0},c=>({...c,text:'原稿'}));let value=await store.read('sample');value.text='内存修改';assert.equal((await store.read('sample')).text,'原稿');
  await writeFile(store.file('sample'),JSON.stringify({revision:2,text:'外部更新'}));assert.equal((await store.read('sample')).text,'外部更新');
}));
test('读取缓存有条目和字节上限，较大记录不常驻缓存',async()=>fixture(async(store)=>{
  for(let i=0;i<40;i++){await writeFile(store.file('sample-'+i),JSON.stringify({revision:1,text:'x'.repeat(10000)}));await store.read('sample-'+i);}
  assert.ok(store.cache.size<=32);assert.ok(store.cacheBytes<=16*1024**2);
  await writeFile(store.file('large'),JSON.stringify({revision:1,text:'x'.repeat(3*1024**2)}));await store.read('large');assert.equal(store.cache.has('large'),false);
}));
test('相同目录的不同 Store 实例共享并发版本锁',async()=>fixture(async(store,dir)=>{
  const second=new Store(dir),results=await Promise.allSettled([store.update('sample',0,{revision:0},c=>({...c,text:'a'})),second.update('sample',0,{revision:0},c=>({...c,text:'b'}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected')[0].reason.statusCode,409);
}));
test('首次保存也有恢复副本，损坏后自动恢复并明确记录原因',async()=>fixture(async(store)=>{
  const first=await store.update('sample',0,{revision:0},c=>({...c,text:'唯一一次保存'}));await writeFile(store.file('sample'),'{broken');
  const recovered=await store.read('sample');assert.equal(recovered.text,first.text);assert.ok(recovered.revision>first.revision);assert.equal(store.recoveries.size,1);assert.equal(await readFile(path.join(store.root,'.recovery/sample.damaged'),'utf8'),'{broken');
}));
test('并发读取损坏记录只恢复一次，拒绝恢复前的旧修订号',async()=>fixture(async(store)=>{
  let value=await store.update('sample',0,{revision:0},c=>({...c,text:'上一稿'}));value=await store.update('sample',value.revision,value,c=>({...c,text:'最新稿'}));await writeFile(store.file('sample'),'null');
  const [a,b]=await Promise.all([store.read('sample'),store.read('sample')]);assert.equal(a.text,'上一稿');assert.equal(a.revision,b.revision);assert.ok(a.revision>value.revision);await assert.rejects(store.update('sample',value.revision,{},c=>c),{statusCode:409});
}));
test('主记录与恢复副本都损坏时明确失败，不替换为空记录',async()=>fixture(async(store)=>{
  await store.update('sample',0,{revision:0},c=>({...c,text:'内容'}));await writeFile(store.file('sample'),'broken');await writeFile(store.backup('sample'),'broken backup');
  await assert.rejects(store.read('sample',{}),{statusCode:503});assert.equal(await readFile(store.file('sample'),'utf8'),'broken');
}));
test('主动删除同时移除恢复副本，后续读取不会复活旧内容',async()=>fixture(async(store)=>{
  await store.update('sample',0,{revision:0},c=>({...c,text:'删除内容'}));await store.read('sample');await store.remove('sample');assert.equal(await store.read('sample',null),null);assert.ok(!(await readdir(path.join(store.root,'.recovery'))).includes('sample.json'));
}));
test('磁盘额度在写入前拒绝，失败保持原记录与恢复副本',async()=>fixture(async(store)=>{
  const previous=process.env.DATA_MAX_BYTES;process.env.DATA_MAX_BYTES='1200';
  try{const saved=await store.update('sample',0,{revision:0},c=>({...c,text:'x'.repeat(100)})),backup=await readFile(store.backup('sample'),'utf8');await assert.rejects(store.update('sample',saved.revision,saved,c=>({...c,text:'x'.repeat(1200)})),{statusCode:413});assert.equal((await store.read('sample')).text,saved.text);assert.equal(await readFile(store.backup('sample'),'utf8'),backup);}
  finally{if(previous===undefined)delete process.env.DATA_MAX_BYTES;else process.env.DATA_MAX_BYTES=previous;}
}));
test('降低额度后仍允许减少占用的保存及恢复副本收缩，避免无法清理的死锁',async()=>fixture(async(store)=>{
  const previous=process.env.DATA_MAX_BYTES;
  try{const saved=await store.update('sample',0,{revision:0},c=>({...c,text:'x'.repeat(2000)}));process.env.DATA_MAX_BYTES='1000';await store.update('sample',saved.revision,saved,c=>({...c,text:''}));await store.checkpoint('sample');assert.equal((await store.read('sample')).text,'');}
  finally{if(previous===undefined)delete process.env.DATA_MAX_BYTES;else process.env.DATA_MAX_BYTES=previous;}
}));
test('备课输入只复制当前版本及近期消息，不先复制全部历史',()=>{
  const state=emptyWorkspace();state.messages=Array.from({length:2000},(_,i)=>({id:String(i),status:'complete'}));state.messages[0].status='processing';
  const versions=Array.from({length:1000},(_,i)=>({id:String(i),content:{slides:[]}}));state.resources=[{id:'resource',currentVersionId:'999',versions}];const input=compactWorkspace(state);assert.equal(input.resources[0].versions.length,1);assert.equal(input.resources[0].versions[0].id,'999');assert.equal(input.messages.length,25);input.resources[0].versions[0].id='changed';assert.equal(versions.at(-1).id,'999');
});
async function history(store){
  const workspace=emptyWorkspace();workspace.resources=[{id:'resource',currentVersionId:'v29',versions:Array.from({length:30},(_,i)=>({id:'v'+i,parentId:i?'v'+(i-1):null,content:{slides:[]},summary:'版本'+i}))}];
  workspace.messages=Array.from({length:240},(_,i)=>({id:'m'+i,role:'assistant',text:'历史'+i,status:'complete'}));await store.update('workspace',0,emptyWorkspace(),()=>workspace);
  const classroom=emptyClassroom();classroom.reports=Array.from({length:30},(_,i)=>({id:'report'+i,transcriptId:'t1',sections:{},history:[]}));classroom.currentReportId='report29';await store.update('classroom',0,emptyClassroom(),()=>classroom);
  return {workspace,classroom};
}
test('历史归档可恢复，当前版本和后续修改保留，反复恢复不重复',async()=>fixture(async(store)=>{
  await history(store);const manager=new StorageManager(store),archive=await manager.archive(5);let w=await store.read('workspace');assert.equal(w.resources[0].versions.length,5);assert.equal(w.messages.length,200);assert.equal((await store.read('classroom')).reports.length,5);
  assert.equal((await manager.archive(5)).skipped,true);await store.update('workspace',w.revision,w,c=>{c.resources[0].versions.at(-1).summary='归档后的教师修改';return c;});
  await manager.restore(archive.id);w=await store.read('workspace');assert.equal(w.resources[0].versions.length,30);assert.equal(w.resources[0].versions.at(-1).summary,'归档后的教师修改');assert.equal(w.resources[0].currentVersionId,'v29');const revision=w.revision;await manager.restore(archive.id);assert.equal((await store.read('workspace')).revision,revision);
}));
test('暂停任务快照和课堂关联引用的旧版本不被归档移走',async()=>fixture(async(store)=>{
  await history(store);await store.update('teaching-input-pinned',0,{revision:0},()=>({revision:0,value:{resources:[{id:'resource',currentVersionId:'v1'}]}}));await store.update('agent-paused',0,{revision:0},()=>({revision:0,id:'paused',stage:'paused',inputRef:'teaching-input-pinned'}));
  await store.update('workspace',undefined,{},c=>{c.messages.push({id:'paused-message',jobId:'paused',status:'paused'});return c;});await store.update('feedback-class-aaaa',0,{revision:0},()=>({revision:0,id:'aaaa',ppt:{versionId:'v2'},reports:[],messages:[],jobIds:[]}));
  await new StorageManager(store).archive(2);const w=await store.read('workspace');for(const id of ['v1','v2','v28','v29'])assert.ok(w.resources[0].versions.some(v=>v.id===id),id);
}));
test('清理回收无引用任务和共享快照，同时保护当前及恢复副本的引用',async()=>fixture(async(store)=>{
  await store.update('teaching-input-shared',0,{revision:0},()=>({revision:0,value:{text:'共同资料'}}));
  for(const id of ['live','gone'])await store.update('agent-'+id,0,{revision:0},()=>({revision:0,id,stage:'completed',inputRef:'teaching-input-shared'}));
  await store.update('workspace',0,emptyWorkspace(),c=>{c.messages=[{id:'m',jobId:'live',status:'complete'}];return c;});const manager=new StorageManager(store);await manager.cleanup();assert.equal(await store.read('agent-gone',null),null);assert.ok(await store.read('teaching-input-shared',null));
  await store.update('workspace',undefined,{},c=>({...c,messages:[]}));await manager.cleanup();assert.ok(await store.read('agent-live',null),'上一份恢复副本仍引用它');await store.update('workspace',undefined,{},c=>({...c,savedCleanup:true}));await manager.cleanup();assert.equal(await store.read('agent-live',null),null);assert.equal(await store.read('teaching-input-shared',null),null);
}));
test('归档损坏时拒绝恢复，路径越界及非法保留数量被拒绝',async()=>fixture(async(store)=>{
  await history(store);const manager=new StorageManager(store),archive=await manager.archive(3),before=await store.read('workspace');await writeFile(path.join(store.root,'.archives',archive.id+'.json.gz'),'bad');await assert.rejects(manager.restore(archive.id),{statusCode:422});assert.deepEqual(await store.read('workspace'),before);await assert.rejects(manager.restore('../outside'),{statusCode:400});await assert.rejects(manager.archive(0),{statusCode:400});
}));
test('空间统计不返回模型凭据，删除归档不影响已补回的数据',async()=>fixture(async(store)=>{
  await history(store);await store.update('model-settings',0,{revision:0},()=>({revision:0,apiKey:'private-fixture-value'}));const manager=new StorageManager(store),archive=await manager.archive(3);assert.ok(!JSON.stringify(await manager.status()).includes('private-fixture-value'));await manager.restore(archive.id);await manager.deleteArchive(archive.id);assert.equal((await manager.status()).archives.length,0);assert.equal((await store.read('workspace')).resources[0].versions.length,30);
}));
test('主记录和恢复副本都损坏后，可从历史归档恢复业务记录',async()=>fixture(async(store)=>{
  await history(store);const manager=new StorageManager(store),archive=await manager.archive(3);await writeFile(store.file('workspace'),'broken');await writeFile(store.backup('workspace'),'broken backup');await manager.restore(archive.id);const w=await store.read('workspace');assert.equal(w.resources[0].versions.length,30);assert.ok(w.revision>Date.now()-10000);
}));
test('归档补回可恢复误删资源，已有资源的当前内容不被替换',async()=>fixture(async(store)=>{
  await history(store);const manager=new StorageManager(store),archive=await manager.archive(3);await store.update('workspace',undefined,{},c=>({...c,resources:[{id:'new-resource',currentVersionId:'new-version',versions:[{id:'new-version',content:{slides:[]}}]}],selectedId:'new-resource'}));await manager.restore(archive.id);const w=await store.read('workspace');assert.equal(w.resources.length,2);assert.equal(w.selectedId,'new-resource');assert.equal(w.resources.find(r=>r.id==='resource').versions.length,30);
}));
test('反馈报告修订和模板也可归档补回，保留现有结论和模板',async()=>fixture(async(store)=>{
  const reports=Array.from({length:10},(_,i)=>({id:'r'+i,text:'报告'+i,history:Array.from({length:10},(_,j)=>({version:j,text:'历史'+j}))}));
  await store.update('feedback-class-aaaa',0,{revision:0},()=>({revision:0,id:'aaaa',reports,currentReportId:'r9',messages:[],jobIds:[]}));await store.update('feedback-templates',0,{revision:0},()=>({revision:0,versions:Array.from({length:10},(_,i)=>({id:'template'+i}))}));
  const manager=new StorageManager(store),archive=await manager.archive(2);assert.equal((await store.read('feedback-class-aaaa')).reports.length,2);assert.equal((await store.read('feedback-templates')).versions.length,2);
  await manager.restore(archive.id);const c=await store.read('feedback-class-aaaa');assert.equal(c.reports.length,10);assert.equal(c.reports.at(-1).history.length,10);assert.equal(c.currentReportId,'r9');assert.equal((await store.read('feedback-templates')).versions.at(-1).id,'template9');
}));
test('清理录音保留当前及归档引用，回收无引用文件',async()=>fixture(async(store)=>{
  const {mkdir}=await import('node:fs/promises');await mkdir(path.join(store.root,'audio'));const live='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.wav',old='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.wav',gone='cccccccc-cccc-cccc-cccc-cccccccccccc.wav';
  for(const name of [live,old,gone])await writeFile(path.join(store.root,'audio',name),'audio');await store.update('classroom',0,emptyClassroom(),c=>({...c,audio:{file:live}}));await store.update('storage-archives',0,{revision:0},()=>({revision:0,items:[{id:'archive',audioFiles:[old]}]}));
  await new StorageManager(store).cleanup();assert.deepEqual((await readdir(path.join(store.root,'audio'))).sort(),[live,old].sort());
}));
test('清理压缩已删除课堂的残留内容，保留防止迟到回调复活的删除标记',async()=>fixture(async(store)=>{
  await store.update('feedback-class-aaaa',0,{revision:0},()=>({revision:0,id:'aaaa',deleted:true,records:[{text:'已删除的意见'}],reports:[],messages:[],jobIds:[]}));await new StorageManager(store).cleanup();const doc=await store.read('feedback-class-aaaa');assert.equal(doc.deleted,true);assert.equal(doc.records,undefined);assert.equal(JSON.parse(await readFile(store.backup('feedback-class-aaaa'),'utf8')).records,undefined);
}));
test('归档期间输入变化后补回的报告仍为历史结果，不能冒充最新报告',async()=>fixture(async(store)=>{
  await history(store);const manager=new StorageManager(store),archive=await manager.archive(2);await store.update('classroom',undefined,{},c=>({...c,courseVersion:10}));await manager.restore(archive.id);const state=await store.read('classroom');assert.equal(state.reports.find(r=>r.id==='report0').stale,true);assert.equal(state.currentReportId,'report29');
}));
test('归档旧转写后保留当前校正的真实原稿，父链缺口不破坏原稿查看',async()=>fixture(async(store)=>{
  const {originalTranscript}=await import('../public/ui.js'),{migrateClassroom}=await import('../src/classroom.js');const state=emptyClassroom();
  state.transcriptVersions=Array.from({length:10},(_,i)=>({id:'raw'+i,audioId:'audio'+i,source:'asr',original:true,segments:[{id:'s'+i,start:0,end:1,text:'原稿'+i}]}));
  for(let i=0;i<10;i++)state.transcriptVersions.push({id:'edit'+i,audioId:'audio9',source:'teacher',parentId:i?'edit'+(i-1):'raw9',segments:[{id:'s9',start:0,end:1,text:'校正'+i}]});state.currentTranscriptId='edit9';await store.update('classroom',0,emptyClassroom(),()=>state);
  await new StorageManager(store).archive(2);const current=migrateClassroom(await store.read('classroom'));assert.equal(current.transcriptVersions.length,3);assert.equal(originalTranscript(current,current.transcriptVersions.find(t=>t.id==='edit9')).id,'raw9');
}));
