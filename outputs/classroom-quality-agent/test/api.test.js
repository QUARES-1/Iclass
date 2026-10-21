import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp,rm,writeFile,readFile,readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApi,json } from '../src/api.js';
import { Store } from '../src/store.js';
const root=new URL('..',import.meta.url).pathname;
test('备课进度与共享资料分开保存，连续聊天复用同一份只读资料',async()=>{
  await withApi({modelCall:async()=>({action:'reply',reply:'你好！'})},async({base,post,dataDir})=>{
    let revision=0;const refs=[];
    for(let i=0;i<5;i++){
      const started=await post('/api/workspace/agent',{revision,request:'你好'});assert.equal(started.status,202);await untilJob(base,started.body.job.id,'completed');
      const record=JSON.parse(await readFile(path.join(dataDir,'agent-'+started.body.job.id+'.json'),'utf8'));assert.equal(record.input,undefined);assert.ok(record.inputRef);refs.push(record.inputRef);revision=(await(await fetch(base+'/api/workspace')).json()).revision;
    }
    assert.equal(new Set(refs).size,1);assert.equal((await readdir(dataDir)).filter(f=>f.startsWith('teaching-input-')).length,1);
  });
});
test('数据管理入口显示空间，拒绝跨源请求及任务执行期间清理',async()=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await withApi({modelCall:async()=>{entered();await gate;return {action:'reply',reply:'你好！'};}},async({base,post})=>{
    try{
      const status=await(await fetch(base+'/api/storage')).json();assert.ok(status.maxBytes>0);assert.equal(status.archives.length,0);
      const external=await fetch(base+'/api/storage/cleanup',{method:'POST',headers:{Origin:'https://example.org','Content-Type':'application/json'},body:'{}'});assert.equal(external.status,403);
      const started=await post('/api/workspace/agent',{revision:0,request:'你好'});await ready;assert.equal((await post('/api/storage/cleanup',{})).status,409);release();await untilJob(base,started.body.job.id,'completed');
      let cleaned;for(let i=0;i<100;i++){cleaned=await post('/api/storage/cleanup',{});if(cleaned.status!==409)break;await new Promise(r=>setTimeout(r,5));}assert.equal(cleaned.status,200);
    }finally{release();}
  });
});
test('课堂修订号未变化时只返回轻量轮询结果，变化后返回完整内容',async()=>{
  await withApi({},async({base,post})=>{
    assert.deepEqual(await(await fetch(base+'/api/classroom?since=0')).json(),{unchanged:true,revision:0});const saved=await post('/api/classroom',{revision:0,action:'course',course:{title:'新课程',description:''}});assert.equal(saved.status,200);
    const changed=await(await fetch(base+'/api/classroom?since=0')).json();assert.equal(changed.course.title,'新课程');assert.equal(changed.unchanged,undefined);
  });
});
test('Sprint 1 初次保存任务失败，不留下永久处理中的消息，之后可重新发送',async()=>{
  await withApi({modelCall:async()=>({action:'reply',reply:'你好！'})},async({base,post})=>{
    const original=Store.prototype.update;let fail=true;
    Store.prototype.update=function(key,...args){if(key.startsWith('agent-')&&fail){fail=false;return Promise.reject(new Error('fixture storage failure'));}return original.call(this,key,...args);};
    try{
      assert.equal((await post('/api/workspace/agent',{revision:0,request:'你好'})).status,500);
      const state=await(await fetch(base+'/api/workspace')).json();assert.equal(state.messages.length,0);assert.equal(state.revision,0);
      const started=await post('/api/workspace/agent',{revision:state.revision,request:'你好'});assert.equal(started.status,202);await untilJob(base,started.body.job.id,'completed');
    }finally{Store.prototype.update=original;}
  });
});
test('前两个 Sprint 的写入接口拒绝非对象 JSON，不产生任务或版本',async()=>{
  await withApi({},async({base,post})=>{
    for(const endpoint of ['/api/workspace','/api/workspace/agent','/api/workspace/chat','/api/classroom','/api/classroom/transcribe','/api/classroom/analyze','/api/classroom/chat'])for(const body of [null,[],true,42,'hello'])assert.equal((await post(endpoint,body)).status,400,endpoint+': '+JSON.stringify(body));
    assert.equal((await(await fetch(base+'/api/workspace')).json()).revision,0);assert.equal((await(await fetch(base+'/api/classroom')).json()).revision,0);
  });
});
test('缺失或非法修订号不能绕过前两个 Sprint 的并发保护',async()=>{
  await withApi({},async({base,post})=>{
    for(const endpoint of ['/api/workspace','/api/workspace/chat','/api/classroom','/api/classroom/transcribe','/api/classroom/analyze'])for(const revision of [undefined,null,-1,0.5,'0'])assert.equal((await post(endpoint,{revision,action:'clear',request:'你好'})).status,400,endpoint+': '+revision);
    assert.equal((await(await fetch(base+'/api/workspace')).json()).revision,0);assert.equal((await(await fetch(base+'/api/classroom')).json()).revision,0);
  });
});
test('任务文件已准备但工作空间写入失败，会移除孤立任务且不调用模型',async()=>{
  let calls=0;await withApi({modelCall:async()=>{calls++;return {action:'reply',reply:'你好'};}},async({base,post,dataDir})=>{
    await fetch(base+'/api/workspace');const original=Store.prototype.update;
    Store.prototype.update=function(key,revision,fallback,change,options){return original.call(this,key,revision,fallback,key==='workspace'?async current=>{await change(current);throw new Error('fixture workspace failure');}:change,options);};
    try{assert.equal((await post('/api/workspace/agent',{revision:0,request:'你好'})).status,500);assert.deepEqual((await readdir(dataDir)).filter(f=>f.startsWith('agent-')),[]);assert.equal(calls,0);assert.equal((await(await fetch(base+'/api/workspace')).json()).messages.length,0);}
    finally{Store.prototype.update=original;}
  });
});
test('成果已提交但最终任务状态持续保存失败，仍显示完成且禁止重复提交',async()=>{
  await withApi({modelCall:async()=>({action:'reply',reply:'只回复一次'})},async({base,post})=>{
    const original=Store.prototype.update;
    Store.prototype.update=function(key,revision,fallback,...args){if(key.startsWith('agent-')&&fallback.stage==='completed')return Promise.reject(new Error('fixture final progress failure'));return original.call(this,key,revision,fallback,...args);};
    try{
      const start=await post('/api/workspace/agent',{revision:0,request:'你好'});assert.equal(start.status,202);await untilJob(base,start.body.job.id,'completed');
      const state=await(await fetch(base+'/api/workspace')).json();assert.equal(state.messages[0].status,'complete');assert.equal(state.messages.filter(m=>m.role==='assistant').length,1);
      assert.equal((await post('/api/workspace/agent/'+start.body.job.id+'/resume',{})).status,409);
    }finally{Store.prototype.update=original;}
  });
});
test('暂停任务继续时保存失败，保留暂停状态，不阻塞新消息',async()=>{
  const {newAgentJob}=await import('../src/agent.js'),{emptyWorkspace}=await import('../src/workspace.js');
  await withApi({},async({base,post,dataDir})=>{
    const state=emptyWorkspace(),job=newAgentJob(state,'你好');job.stage='paused';job.messageId='paused-message';state.messages=[{id:job.messageId,jobId:job.id,role:'user',text:'你好',status:'paused',mode:'conversation'}];
    await writeFile(path.join(dataDir,'workspace.json'),JSON.stringify(state));await writeFile(path.join(dataDir,'agent-'+job.id+'.json'),JSON.stringify(job));await fetch(base+'/api/workspace');
    const original=Store.prototype.update;
    Store.prototype.update=function(key,...args){if(key.startsWith('agent-'))return Promise.reject(new Error('fixture resume failure'));return original.call(this,key,...args);};
    try{assert.equal((await post('/api/workspace/agent/'+job.id+'/resume',{})).status,500);assert.equal((await(await fetch(base+'/api/workspace')).json()).messages[0].status,'paused');assert.equal((await(await fetch(base+'/api/workspace/agent/'+job.id)).json()).stage,'paused');}
    finally{Store.prototype.update=original;}
  });
});
test('旧版本误将问候规划为课件但尚未执行，教师手动继续时重新理解消息；不自动恢复',async()=>{
  const {newAgentJob}=await import('../src/agent.js'),{emptyWorkspace}=await import('../src/workspace.js');let calls=0;
  await withApi({modelCall:async(system,input)=>{calls++;assert.equal(input.phase,'decide');assert.equal(input.request,'你好');return {action:'reply',reply:'你好！'};}},async({base,post,dataDir})=>{
    const state=emptyWorkspace(),job=newAgentJob(state,'你好');delete job.mode;job.stage='paused';job.calls=2;job.messageId='legacy-greeting';job.plan=agentPlan;job.tasks=[{id:'legacy-plan'}];
    state.messages=[{id:job.messageId,jobId:job.id,role:'user',text:'你好',status:'paused'}];await writeFile(path.join(dataDir,'workspace.json'),JSON.stringify(state));await writeFile(path.join(dataDir,'agent-'+job.id+'.json'),JSON.stringify(job));
    await fetch(base+'/api/workspace');assert.equal(calls,0);assert.equal((await(await fetch(base+'/api/workspace/agent/'+job.id)).json()).stage,'paused');
    const resumed=await post('/api/workspace/agent/'+job.id+'/resume',{});assert.equal(resumed.status,202);const result=await untilJob(base,job.id,'completed');assert.equal(result.mode,'conversation');assert.equal(result.plan,null);assert.equal(result.calls,3);assert.equal(result.draftPages,0);assert.equal(result.totalBatches,0);
    const after=await(await fetch(base+'/api/workspace')).json();assert.equal(after.resources.length,0);assert.equal(after.messages.at(-1).text,'你好！');
  });
});
test('问候通过异步入口直接回复并持久化，不修改课件、创建计划或伪装保存版本',async()=>{
  const seen=[];await withApi({modelCall:async(system,input)=>{seen.push(input);return {action:'reply',reply:'你好！有什么想一起讨论的？'};}},async({base,post})=>{
    const loaded=await post('/api/workspace/sample',{revision:0}),before=loaded.body;
    const started=await post('/api/workspace/agent',{revision:before.revision,request:'你好',resourceId:before.selectedId,baseVersionId:before.resources.find(r=>r.id===before.selectedId).currentVersionId});
    assert.equal(started.status,202);const job=await untilJob(base,started.body.job.id,'completed'),after=await(await fetch(base+'/api/workspace')).json();
    assert.equal(job.mode,'conversation');assert.equal(job.detail,'已回复');assert.equal(job.plan,null);assert.equal(job.calls,1);assert.equal(job.totalBatches,0);assert.equal(job.draftPages,0);
    assert.deepEqual(after.resources,before.resources);assert.deepEqual(after.materials,before.materials);assert.equal(after.selectedId,before.selectedId);assert.equal(after.messages.at(-1).text,'你好！有什么想一起讨论的？');assert.equal(after.messages.at(-1).versionId,null);assert.equal(after.messages.at(-1).summary,'');
    assert.equal(seen[0].phase,'decide');assert.ok(!seen[0].recentConversation.some(m=>m.text==='你好'));
  });
});

test('对话读取期间教师可以编辑资源，普通回复仍成功且不覆盖教师修改',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
  await withApi({modelCall:async()=>{enter();await waiting;return {action:'reply',reply:'你好！'};}},async({base,post})=>{
    try{
      const sample=await post('/api/workspace/sample',{revision:0}),r=sample.body.resources.find(r=>r.type==='ppt');
      const started=await post('/api/workspace/agent',{revision:sample.body.revision,request:'你好',resourceId:r.id,baseVersionId:r.currentVersionId});await entered;
      const current=await(await fetch(base+'/api/workspace')).json();const edit=await post('/api/workspace',{revision:current.revision,action:'editSlide',resourceId:r.id,baseVersionId:r.currentVersionId,slideId:r.versions.find(v=>v.id===r.currentVersionId).content.slides[0].id,patch:{title:'教师的新标题'}});assert.equal(edit.status,200);
      release();await untilJob(base,started.body.job.id,'completed');const after=await(await fetch(base+'/api/workspace')).json(),edited=after.resources.find(x=>x.id===r.id);assert.equal(edited.versions.find(v=>v.id===edited.currentVersionId).content.slides[0].title,'教师的新标题');
    }finally{release();}
  });
});

test('课件生成期间可聊天并读取真实进度，新写入由锁保护，旧任务继续正常完成',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
  await withApi({modelCall:async(system,input)=>{
    if(input.request==='你好')return {action:'reply',reply:'你好！'};
    if(input.request==='现在到哪里了？'){
      if(!input.toolResults.length)return {action:'tool',tool:'task.status',args:{}};
      const task=input.toolResults[0].data.find(t=>t.request==='新建完整课件');assert.equal(task.stage,'generating');assert.equal(task.completedBatches,0);
      return {action:'reply',reply:'正在生成第一批，尚未保存正式成果。'};
    }
    if(input.request==='新建第二份')return input.feedback?{action:'clarify',reply:'先等当前课件完成，还是由你暂停后再操作？'}:agentPlan;
    if(input.phase==='decide')return {...agentPlan,steps:[{...agentPlan.steps[0],pages:1}]};
    if(input.phase==='review')return agentPassed;
    enter();await waiting;return {action:'create',type:'ppt',name:'后台课件',reply:'已生成',content:{slides:agentSlides(input)}};
  }},async({base,post})=>{
    try{
      const start=await post('/api/workspace/agent',{revision:0,request:'新建完整课件'});await entered;
      const requests=[...Array(10).fill('你好'),'现在到哪里了？','新建第二份'];
      for(const request of requests){
        const state=await(await fetch(base+'/api/workspace')).json(),started=await post('/api/workspace/agent',{revision:state.revision,request});assert.equal(started.status,202);
        const job=await untilJob(base,started.body.job.id,'completed');assert.equal(job.mode,'conversation');assert.equal(job.draftPages,0);
      }
      let state=await(await fetch(base+'/api/workspace')).json();assert.equal(state.resources.length,0);assert.equal(state.messages.find(m=>m.jobId===start.body.job.id).status,'processing');assert.equal(state.messages.at(-1).text,'先等当前课件完成，还是由你暂停后再操作？');
      release();await untilJob(base,start.body.job.id,'completed');state=await(await fetch(base+'/api/workspace')).json();assert.equal(state.resources.length,1);assert.equal(state.resources[0].versions.length,1);assert.equal(state.messages.filter(m=>m.role==='assistant').length,requests.length+1);
    }finally{release();}
  });
});
test('清空对话上下文持久化，仅移除交互记录；新智能体不读取旧对话，过期版本拒绝清空',async()=>{
  const inputs=[];
  await withApi({modelCall:async(system,input)=>{inputs.push(input);return {action:'advice',reply:'已理解教师要求'};}},async({base,post,dataDir})=>{
    let result=await post('/api/workspace/sample',{revision:0});
    result=await post('/api/workspace/chat',{revision:result.body.revision,request:'旧要求：每页放十道例题'});assert.equal(result.status,200);
    const before=result.body,classroom=await(await fetch(base+'/api/classroom')).json(),settings=await(await fetch(base+'/api/model-settings')).json();assert.equal(before.messages.length,3);
    assert.equal((await post('/api/workspace',{action:'clearConversation'})).status,400);
    assert.equal((await post('/api/workspace',{action:'clearConversation',revision:before.revision-1})).status,409);
    result=await post('/api/workspace',{action:'clearConversation',revision:before.revision});assert.equal(result.status,200);assert.deepEqual(result.body.messages,[]);
    const content=s=>Object.fromEntries(Object.entries(s).filter(([k])=>!['messages','revision','savedAt'].includes(k)));
    assert.deepEqual(content(result.body),content(before));assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'workspace.json'),'utf8')).messages,[]);
    assert.deepEqual(await(await fetch(base+'/api/classroom')).json(),classroom);assert.deepEqual(await(await fetch(base+'/api/model-settings')).json(),settings);
    result=await post('/api/workspace/agent',{revision:result.body.revision,request:'只讲原理'});assert.equal(result.status,202);await untilJob(base,result.body.job.id,'completed');
    assert.deepEqual(inputs.at(-1).recentConversation,[]);assert.equal(inputs.at(-1).resources.length,before.resources.length);
    const next=await(await fetch(base+'/api/workspace')).json();assert.ok(!JSON.stringify(next.messages).includes('十道例题'));assert.equal(next.messages.length,2);
  });
});

test('执行中拒绝清空，暂停后可清空且旧任务不能恢复或写回历史',async()=>{
  let entered;const waiting=new Promise(r=>entered=r);
  await withApi({modelCall:async(system,input,config)=>{entered();await new Promise((resolve,reject)=>config.signal.addEventListener('abort',()=>reject(config.signal.reason),{once:true}));}},async({base,post})=>{
    const start=await post('/api/workspace/agent',{revision:0,request:'新建完整课件'});await waiting;
    let state=await(await fetch(base+'/api/workspace')).json();const rejected=await post('/api/workspace',{action:'clearConversation',revision:state.revision});assert.equal(rejected.status,409);assert.match(rejected.body.error,/先暂停/);
    assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),state);
    await post('/api/workspace/agent/'+start.body.job.id+'/pause',{});await untilJob(base,start.body.job.id,'paused');
    for(let i=0;i<200;i++){state=await(await fetch(base+'/api/workspace')).json();if(state.messages[0].status==='paused')break;await new Promise(r=>setTimeout(r,10));}
    const cleared=await post('/api/workspace',{action:'clearConversation',revision:state.revision});assert.equal(cleared.status,200);assert.deepEqual(cleared.body.messages,[]);
    assert.equal((await post('/api/workspace/agent/'+start.body.job.id+'/resume',{})).status,409);
    assert.deepEqual((await(await fetch(base+'/api/workspace')).json()).messages,[]);
  });
});
async function untilJob(base,id,stage){for(let i=0;i<200;i++){const job=await(await fetch(base+'/api/workspace/agent/'+id)).json();if(job.stage===stage)return job;if(job.stage==='failed')throw Error(job.error);await new Promise(r=>setTimeout(r,10));}throw Error('job timeout: '+stage);}
async function withApi(options,run){const dataDir=await mkdtemp(path.join(os.tmpdir(),'classroom-api-'));const api=createApi(root,{dataDir,...options});const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},e.statusCode||500);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const post=async(url,data)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};};try{await run({base,post,dataDir});}finally{await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}
test('对话模型失败保留已有资源并保存失败消息，可刷新后重试',async()=>withApi({modelCall:async()=>{throw new Error('真实服务失败');}},async({base,post})=>{let r=await post('/api/workspace/sample',{revision:0});const old=r.body.resources;const current=r.body.resources.find(x=>x.id===r.body.selectedId);r=await post('/api/workspace/chat',{revision:r.body.revision,request:'修改操作提示',resourceId:current.id,baseVersionId:current.currentVersionId});assert.equal(r.status,502);assert.deepEqual(r.body.state.resources,old);assert.equal(r.body.state.messages.at(-1).status,'failed');const restored=await(await fetch(base+'/api/workspace')).json();assert.equal(restored.resources.length,5);}));
test('AI成功只在候选校验并保存后形成新资源与版本',async()=>withApi({modelCall:async()=>({action:'create',reply:'按教师要求生成。',type:'ppt',name:'真实接口候选',content:{slides:[{section:'讲解',title:'新内容',bullets:['要点'],notes:[]}]}})},async({post})=>{const r=await post('/api/workspace/chat',{revision:0,request:'新建关于排序的PPT'});assert.equal(r.status,200);assert.equal(r.body.resources.length,1);assert.equal(r.body.messages.at(-1).versionId,r.body.resources[0].currentVersionId);}));
test('音频独立流式上传、坏文件失败不替换已有录音，范围回放可用',async()=>withApi({speechCall:async(mode,file)=>{if(file.includes('.mp3'))throw new Error('损坏');return {duration:30,codec:'pcm_s16le',sampleRate:16000,format:'wav'};}},async({base})=>{let response=await fetch(base+'/api/classroom/audio?name=lesson.wav&revision=0',{method:'POST',body:Buffer.alloc(200)});assert.equal(response.status,200);const state=await response.json();response=await fetch(base+'/api/classroom/audio?name=broken.mp3&revision='+state.revision,{method:'POST',body:'broken'});assert.equal(response.status,500);assert.equal((await(await fetch(base+'/api/classroom')).json()).audio.id,state.audio.id);const ranged=await fetch(base+'/api/classroom/audio?id='+state.audio.id,{headers:{Range:'bytes=10-19'}});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,10);}));
test('识别失败保留音频且不会填入示例文本',async()=>withApi({speechCall:async(mode)=>{if(mode==='probe')return {duration:30,format:'wav'};throw new Error('模型不可用');}},async({base,post})=>{let r=await fetch(base+'/api/classroom/audio?name=lesson.wav&revision=0',{method:'POST',body:'audio'});let s=await r.json();await post('/api/classroom/transcribe',{revision:s.revision});for(let i=0;i<30;i++){s=await(await fetch(base+'/api/classroom')).json();if(s.jobs[0]?.stage==='failed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(s.jobs[0].stage,'failed');assert.ok(s.audio);assert.equal(s.transcriptVersions.length,0);}));
test('真实时间合并结果保存原稿，重启可恢复录音和转写',async()=>withApi({speechCall:async mode=>mode==='probe'?{duration:30,format:'wav'}:{segments:[{id:'seg-1',start:4,end:8,text:'相邻交换的真实识别',timestampSource:'alignment'}],chunks:[{start:0,end:30}],elapsedSeconds:1,device:'cpu'}},async({base,post,dataDir})=>{const s=await(await fetch(base+'/api/classroom/audio?name=lesson.wav&revision=0',{method:'POST',body:'audio'})).json();await post('/api/classroom/transcribe',{revision:s.revision});let restored;for(let i=0;i<30;i++){restored=await(await fetch(base+'/api/classroom')).json();if(restored.jobs[0]?.stage==='completed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(restored.transcriptVersions[0].segments[0].start,4);assert.equal(restored.transcriptVersions[0].original,true);const raw=JSON.parse(await(await import('node:fs/promises')).readFile(path.join(dataDir,'classroom.json'),'utf8'));assert.equal(raw.currentTranscriptId,restored.currentTranscriptId);}));
test('转写返回繁体时自动保存原稿与简体版，任务指向简体版且时间完全一致',async()=>withApi({speechCall:async mode=>mode==='probe'?{duration:30,format:'wav'}:{segments:[{id:'seg-1',start:4,end:8,text:'這節課介紹網絡節點。',timestampSource:'alignment'}],chunks:[{start:0,end:30}]}},async({base,post})=>{
  const uploaded=await(await fetch(base+'/api/classroom/audio?name=lesson.wav&revision=0',{method:'POST',body:'audio'})).json();await post('/api/classroom/transcribe',{revision:uploaded.revision});let s;for(let i=0;i<50;i++){s=await(await fetch(base+'/api/classroom')).json();if(s.jobs[0]?.stage==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(s.transcriptVersions.length,2);const original=s.transcriptVersions[0],current=s.transcriptVersions[1];assert.equal(original.segments[0].text,'這節課介紹網絡節點。');assert.equal(original.original,true);assert.equal(current.segments[0].text,'这节课介绍网络节点。');assert.equal(s.currentTranscriptId,current.id);assert.equal(s.jobs[0].resultId,current.id);assert.equal(s.jobs[0].originalResultId,original.id);assert.deepEqual({...current.segments[0],text:original.segments[0].text},original.segments[0]);
}));
test('外部网页不能跨来源操作本机接口',async()=>withApi({},async({base})=>{const r=await fetch(base+'/api/workspace',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{"action":"clear"}'});assert.equal(r.status,403);}));

test('运行检查失败的互动候选不能提交成功资源',async()=>withApi({modelCall:async()=>({action:'create',reply:'候选',type:'game',name:'游戏',content:{mode:'steps',title:'步骤',description:'说明',hint:'提示',explanation:'解释',items:['第一步','第二步']}}),runtimeCheck:async()=>{throw new Error('运行器错误');}},async({base,post})=>{const r=await post('/api/workspace/chat',{revision:0,request:'新建游戏'});assert.equal(r.status,502);const s=await(await fetch(base+'/api/workspace')).json();assert.equal(s.resources.length,0);assert.equal(s.messages[0].status,'failed');}));

test('只构造服务器或读取静态入口不能误标运行任务，实际服务恢复仍标记中断',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'classroom-recovery-'));
  const file=path.join(dataDir,'classroom.json');
  const original=JSON.stringify({revision:7,jobs:[{id:'running-job',type:'transcribe',stage:'transcribing'}]});
  await writeFile(file,original);
  const api=createApi(root,{dataDir});
  const server=http.createServer(async(req,res)=>{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host))){res.writeHead(200);res.end('static');}});
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    await fetch(base+'/public/home.html');
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await readFile(file,'utf8'),original);
    const restored=await(await fetch(base+'/api/classroom')).json();
    assert.equal(restored.jobs[0].stage,'failed');
    assert.match(restored.jobs[0].error,/服务重启/);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('音频字节边界含chunked超限、空文件、错误容器及非法时长均不替换原录音',async()=>{
  const previous=process.env.AUDIO_MAX_BYTES;process.env.AUDIO_MAX_BYTES='64';
  try{await withApi({speechCall:async()=>({duration:2,format:'wav'})},async({base,dataDir})=>{
    let response=await fetch(base+'/api/classroom/audio?name=ok.wav&revision=0',{method:'POST',body:Buffer.alloc(64)});assert.equal(response.status,200);const original=await response.json();
    for(const size of [0,65]){response=await fetch(base+'/api/classroom/audio?name=bad.wav&revision='+original.revision,{method:'POST',body:Buffer.alloc(size)});assert.equal(response.status,size?413:400);}
    const {Readable}=await import('node:stream');response=await fetch(base+'/api/classroom/audio?name=stream.wav&revision='+original.revision,{method:'POST',body:Readable.from([Buffer.alloc(40),Buffer.alloc(40)]),duplex:'half'});assert.equal(response.status,413);assert.match((await response.json()).error,/超过/);
    response=await fetch(base+'/api/classroom/audio?name=fake.mp3&revision='+original.revision,{method:'POST',body:Buffer.alloc(10)});assert.equal(response.status,415);
    for(const revision of ['', 'NaN','-1',String(original.revision-1)]){response=await fetch(base+'/api/classroom/audio?name=old.wav&revision='+revision,{method:'POST',body:Buffer.alloc(10)});assert.equal(response.status,409);}
    assert.deepEqual(await(await fetch(base+'/api/classroom')).json(),original);assert.deepEqual(await readdir(path.join(dataDir,'audio')),[original.audio.file]);
  });
  for(const duration of [0,-1,Infinity,10801])await withApi({speechCall:async()=>({duration,format:'wav'})},async({base})=>{const response=await fetch(base+'/api/classroom/audio?name=bad.wav&revision=0',{method:'POST',body:Buffer.alloc(10)});assert.equal(response.status,422);assert.equal((await(await fetch(base+'/api/classroom')).json()).audio,null);});
  }finally{if(previous===undefined)delete process.env.AUDIO_MAX_BYTES;else process.env.AUDIO_MAX_BYTES=previous;}
});

test('服务端探测期间取消上传，清理临时文件且保留原录音',async()=>{
  let block=false,entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await withApi({speechCall:async()=>{if(block){entered();await gate;}return {duration:2,format:'wav'};}},async({base,dataDir})=>{
    const original=await(await fetch(base+'/api/classroom/audio?name=original.wav&revision=0',{method:'POST',body:'audio'})).json();block=true;
    const controller=new AbortController(),upload=fetch(base+'/api/classroom/audio?name=new.wav&revision='+original.revision,{method:'POST',body:'new-audio',signal:controller.signal});
    await started;controller.abort();await assert.rejects(upload,error=>error.name==='AbortError');await new Promise(r=>setTimeout(r,20));release();
    for(let i=0;i<30;i++){if((await readdir(path.join(dataDir,'audio'))).length===1)break;await new Promise(r=>setTimeout(r,10));}
    assert.deepEqual(await(await fetch(base+'/api/classroom')).json(),original);assert.deepEqual(await readdir(path.join(dataDir,'audio')),[original.audio.file]);
  });
});

test('上传等待中保存课程说明，完成后两份修改均保留',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  await withApi({speechCall:async()=>{entered();await gate;return {duration:2,format:'wav'};}},async({base,post})=>{
    const uploading=fetch(base+'/api/classroom/audio?name=lesson.wav&revision=0',{method:'POST',body:'audio'});await started;
    const course={title:'上传期间保存的课程',description:'新说明'};assert.equal((await post('/api/classroom',{revision:0,action:'course',course})).status,200);release();const result=await uploading;assert.equal(result.status,200);const state=await result.json();assert.deepEqual(state.course,course);assert.equal(state.audio.name,'lesson.wav');
  });
});

test('载入示例也遵守资料总量限制，资料改变后清空旧理解',async()=>withApi({},async({base,post})=>{
  let r=await post('/api/workspace',{revision:0,action:'material',material:{title:'上限一',type:'txt',content:'课'.repeat(250000)}});assert.equal(r.status,200);
  r=await post('/api/workspace',{revision:r.body.revision,action:'material',material:{title:'上限二',type:'txt',content:'教'.repeat(250000)}});assert.equal(r.status,200);const original=r.body;
  r=await post('/api/workspace/sample',{revision:original.revision});assert.equal(r.status,422);assert.match(r.body.error,/500000/);assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),original);
  r=await post('/api/workspace',{revision:original.revision,action:'clear'});
  r=await post('/api/workspace',{revision:r.body.revision,action:'context',source:'teacher',analysis:{chapters:[],objectives:[],knowledgePoints:['旧理解'],keyPoints:[],difficultPoints:[]},supplements:[]});assert.equal(r.status,200);
  r=await post('/api/workspace/sample',{revision:r.body.revision});assert.equal(r.status,200);assert.equal(r.body.analysis,null);assert.equal(r.body.analysisSource,null);
}));

test('同一版本并发重复载入示例都成功，ID和revision不重复增长',async()=>withApi({},async({base,post,dataDir})=>{
  const responses=await Promise.all(Array.from({length:8},()=>post('/api/workspace/sample',{revision:0})));for(const r of responses){assert.equal(r.status,200);assert.equal(r.body.materials.length,4);assert.equal(r.body.resources.length,5);assert.equal(r.body.revision,1);assert.deepEqual(r.body,responses[0].body);}
  const file=await readFile(path.join(dataDir,'workspace.json'),'utf8');const again=await post('/api/workspace/sample',{revision:1});assert.deepEqual(again.body,responses[0].body);assert.equal(await readFile(path.join(dataDir,'workspace.json'),'utf8'),file);
}));

test('旧重复示例整理前备份完整数据，保留当前对象，重复点击不再写入',async()=>withApi({},async({post,dataDir})=>{
  const {loadSampleWorkspace}=await import('../src/sampleWorkspace.js'),{emptyWorkspace}=await import('../src/workspace.js');const state=emptyWorkspace();
  for(let i=0;i<4;i++){const set=emptyWorkspace();loadSampleWorkspace(set);for(const row of [...set.materials,...set.resources])delete row.sampleKey;state.materials.push(...set.materials);state.resources.push(...set.resources);}state.selectedId=state.resources.at(-1).id;state.revision=5;const original=JSON.stringify(state);await writeFile(path.join(dataDir,'workspace.json'),original);
  const result=await post('/api/workspace/sample',{revision:5});assert.equal(result.status,200);assert.equal(result.body.materials.length,4);assert.equal(result.body.resources.length,5);assert.equal(result.body.selectedId,state.selectedId);
  const files=await readdir(path.join(dataDir,'backups'));assert.equal(files.length,1);assert.equal(await readFile(path.join(dataDir,'backups',files[0]),'utf8'),original);
  const again=await post('/api/workspace/sample',{revision:result.body.revision});assert.deepEqual(again.body,result.body);assert.equal((await readdir(path.join(dataDir,'backups'))).length,1);
}));

test('过期示例请求不会在用户清空后重新添加资料，仅无变化的重复请求可幂等成功',async()=>withApi({},async({post,base})=>{
  const first=await post('/api/workspace/sample',{revision:0});const cleared=await post('/api/workspace',{revision:first.body.revision,action:'clear'});
  const old=await post('/api/workspace/sample',{revision:first.body.revision});assert.equal(old.status,409);assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),cleared.body);
}));

test('模型配置API留空保留密钥、即时生效、隐藏密钥且不影响教学数据',async()=>{
  const seen=[];await withApi({modelCall:async(system,input,config)=>{seen.push({system,input,config});return input.task==='connection-test'?{ok:true}:{action:'advice',reply:'使用教师配置'};}},async({base,post,dataDir})=>{
    const workspace=await(await fetch(base+'/api/workspace')).json();
    let config=await(await fetch(base+'/api/model-settings')).json();assert.equal(config.apiKey,undefined);
    let saved=await post('/api/model-settings',{revision:config.revision,apiKey:'api-test-secret',baseUrl:'https://teacher.example/v1',model:'teacher-model',maxTokens:20000,temperature:0,prompts:{agent:'教师配置的简洁对话。',preparation:'教师配置的详细实操课。'}});
    assert.equal(saved.status,200);assert.equal(saved.body.apiKeyConfigured,true);assert.ok(!JSON.stringify(saved.body).includes('api-test-secret'));
    const tested=await post('/api/model-settings/test',{revision:saved.body.revision,apiKey:'',model:'unsaved-test-model'});assert.equal(tested.status,200);assert.equal(seen[0].config.model,'unsaved-test-model');assert.equal(seen[0].config.apiKey,'api-test-secret');
    assert.equal((await(await fetch(base+'/api/model-settings')).json()).model,'teacher-model');
    assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),workspace);
    let result=await post('/api/workspace/chat',{revision:workspace.revision,request:'教学建议'});assert.equal(result.status,200);
    assert.ok(seen[1].system.includes('教师配置的简洁对话。'));assert.ok(!seen[1].system.includes('教师配置的详细实操课。'));assert.equal(seen[1].config.model,'teacher-model');assert.equal(seen[1].config.maxTokens,20000);assert.equal(seen[1].config.temperature,0);
    const status=await(await fetch(base+'/api/status')).json();assert.equal(status.model,'teacher-model');assert.equal(status.textModelConfigured,true);
    const old=await post('/api/model-settings',{revision:config.revision,model:'stale'});assert.equal(old.status,409);
    const invalid=await post('/api/model-settings',{revision:saved.body.revision,model:''});assert.equal(invalid.status,422);
    saved=await post('/api/model-settings',{revision:saved.body.revision,clearApiKey:true});assert.equal(saved.status,200);assert.equal(saved.body.apiKeyConfigured,false);assert.equal((await(await fetch(base+'/api/status')).json()).textModelConfigured,false);
    assert.equal(JSON.parse(await readFile(path.join(dataDir,'model-settings.json'),'utf8')).apiKey,'');
    assert.ok(!JSON.stringify(result.body).includes('api-test-secret'));
    const foreign=await fetch(base+'/api/model-settings',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:JSON.stringify({revision:saved.body.revision,apiKey:'foreign'})});assert.equal(foreign.status,403);
  });
});

test('连接测试失败不保存待测配置、不修改工作空间',async()=>withApi({modelCall:async()=>{throw new Error('连接不可用');}},async({base,post})=>{
  const config=await(await fetch(base+'/api/model-settings')).json(),workspace=await(await fetch(base+'/api/workspace')).json();
  const r=await post('/api/model-settings/test',{revision:config.revision,model:'test-only'});assert.equal(r.status,500);
  assert.deepEqual(await(await fetch(base+'/api/model-settings')).json(),config);assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),workspace);
}));

const agentPlan={action:'plan',goal:'完整授课',reply:'计划',steps:[{id:'course',title:'原理与练习',tool:'ppt.create',resourceId:'current',targetIds:[],sourceIds:[],topics:[],instructions:'生成教学内容',minutes:45,pages:4}]};
const agentPassed={action:'review',passed:true,reply:'通过',issues:[],repairSteps:[]};
const agentSlides=input=>Array.from({length:input.task.pageCount},(_,i)=>({title:'教学页面 '+(input.task.pageStart+i),bullets:['原理','练习'],notes:[]}));
test('异步智能体202启动、暂停与恢复保留批次，拒绝重复任务；公开进度与文件不含密钥',async()=>{
  let entered,block=true,executions=0;const waiting=new Promise(r=>entered=r);
  await withApi({modelCall:async(system,input,config)=>{
    if(input.phase==='decide')return agentPlan;if(input.phase==='review')return agentPassed;
    executions++;if(input.task.part===2 && block){entered();await new Promise((resolve,reject)=>config.signal.addEventListener('abort',()=>reject(config.signal.reason),{once:true}));}
    return input.task.tool==='ppt.create'?{action:'create',type:'ppt',name:'智能体课件',reply:'生成',content:{slides:agentSlides(input)}}:{action:'update',reply:'补充',operations:agentSlides(input).map(slide=>({action:'add',slide}))};
  }},async({base,post,dataDir})=>{
    const started=await post('/api/workspace/agent',{revision:0,request:'新建完整课件'});assert.equal(started.status,202);const id=started.body.job.id;
    await waiting;const current=await(await fetch(base+'/api/workspace')).json();assert.equal(current.resources.length,0);
    const duplicate=await post('/api/workspace/agent',{revision:current.revision,request:'新建第二份'});assert.equal(duplicate.status,202);
    const blocked=await untilJob(base,duplicate.body.job.id,'failed');assert.match(blocked.error,/已有任务正在执行/);assert.equal(blocked.draftPages,0);
    assert.equal((await post('/api/workspace/agent/'+id+'/pause',{})).status,202);const paused=await untilJob(base,id,'paused');assert.equal(paused.completedBatches,1);assert.equal(paused.draftPages,3);assert.equal(paused.input,undefined);assert.equal(paused.drafts,undefined);
    const raw=JSON.parse(await readFile(path.join(dataDir,'agent-'+id+'.json'),'utf8'));assert.equal(raw.apiKey,undefined);assert.equal(raw.config,undefined);
    block=false;assert.equal((await post('/api/workspace/agent/'+id+'/resume',{})).status,202);await untilJob(base,id,'completed');
    const result=await(await fetch(base+'/api/workspace')).json();assert.equal(result.resources.length,1);assert.equal(result.resources[0].versions.length,1);assert.equal(result.resources[0].versions[0].content.slides.length,4);assert.equal(executions,3);
    assert.equal((await post('/api/workspace/agent/'+id+'/resume',{})).status,409);
  });
});

test('服务重启将未完成智能体变为可恢复暂停，不丢失原要求，不伪装成功',async()=>{
  const {newAgentJob}=await import('../src/agent.js'),{emptyWorkspace}=await import('../src/workspace.js');
  await withApi({modelCall:async(system,input)=>input.phase==='decide'?{...agentPlan,steps:[{...agentPlan.steps[0],pages:1}]}:input.phase==='review'?agentPassed:{action:'create',type:'ppt',name:'恢复课件',reply:'生成',content:{slides:agentSlides(input)}}},async({base,post,dataDir})=>{
    const state=emptyWorkspace(),job=newAgentJob(state,'新建完整课件');job.stage='generating';job.messageId='saved-message';
    state.messages.push({id:job.messageId,role:'user',text:job.request,jobId:job.id,status:'processing'});
    await writeFile(path.join(dataDir,'workspace.json'),JSON.stringify(state));await writeFile(path.join(dataDir,'agent-'+job.id+'.json'),JSON.stringify(job));
    const recovered=await(await fetch(base+'/api/workspace')).json();assert.equal(recovered.messages[0].status,'paused');
    assert.equal((await(await fetch(base+'/api/workspace/agent/'+job.id)).json()).stage,'paused');
    assert.equal((await post('/api/workspace/agent/'+job.id+'/resume',{})).status,202);await untilJob(base,job.id,'completed');
    assert.equal((await(await fetch(base+'/api/workspace')).json()).resources.length,1);
  });
});

async function seedReviewClassroom(dataDir){
  const {emptyClassroom}=await import('../src/classroom.js');const state=emptyClassroom();state.course={title:'模拟课堂',description:'课堂复盘'};state.transcriptVersions=[{id:'t1',source:'teacher',segments:[{id:'e1',start:1,end:10,text:'为什么要相邻交换？先比较，再交换。'}]}];state.currentTranscriptId='t1';await writeFile(path.join(dataDir,'classroom.json'),JSON.stringify(state));return state;
}
function reviewSections(input){return {sections:Object.fromEntries(input.requestedSections.map(k=>[k,[{text:k==='summary'?'课堂围绕相邻交换展开。':k==='suggestions'?'增加一次学生操作。':'一次提问后继续讲解。',kind:k==='difficulties'?'hypothesis':k==='emphasis'?'ai-inference':'transcript',evidenceIds:['e1']}]]))};}
test('清空复盘上下文会丢弃此前尚未返回的模型回复，不能复活历史',async()=>{
  let entered,release;const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  await withApi({modelCall:async()=>{entered();await waiting;return {action:'reply',reply:'旧回复'};}},async({base,post})=>{
    const state=await(await fetch(base+'/api/classroom')).json();const pending=post('/api/classroom/chat',{revision:state.revision,request:'你好'});
    try{await started;const cleared=await post('/api/classroom',{revision:state.revision,action:'clearConversation'});assert.equal(cleared.status,200);release();const result=await pending;assert.equal(result.status,409);assert.match(result.body.error,/旧回复已丢弃/);const after=await(await fetch(base+'/api/classroom')).json();assert.deepEqual(after.conversation,[]);}finally{release();await pending;}
  });
});
async function untilAnalysis(base,id,stage='completed'){
  for(let i=0;i<200;i++){const state=await(await fetch(base+'/api/classroom')).json(),job=state.jobs.find(j=>j.id===id);if(job?.stage===stage)return state;if(job?.stage==='failed')throw Error(job.error);await new Promise(r=>setTimeout(r,10));}throw Error('analysis timeout');
}
test('课堂默认总览；细分须显式请求且保留已修订确认的总结、证据及导出版本',async()=>{
  const seen=[];await withApi({modelCall:async(_,input)=>{seen.push(input);return reviewSections(input);}},async({base,post,dataDir})=>{
    await seedReviewClassroom(dataDir);let state=await(await fetch(base+'/api/classroom')).json();
    let response=await post('/api/classroom/analyze',{revision:state.revision});assert.equal(response.status,202);state=await untilAnalysis(base,response.body.jobs.at(-1).id);
    let report=state.reports.find(r=>r.id===state.currentReportId);assert.equal(report.mode,'overview');assert.deepEqual(report.sections.knowledge,[]);assert.equal(seen.length,1);
    response=await post('/api/classroom',{revision:state.revision,action:'reportItem',reportId:report.id,section:'summary',itemId:report.sections.summary[0].id,text:'教师确认的简洁总结'});state=response.body;
    response=await post('/api/classroom',{revision:state.revision,action:'reportItem',reportId:report.id,section:'summary',itemId:report.sections.summary[0].id,confirm:true});state=response.body;
    report=state.reports.find(r=>r.id===state.currentReportId);const before=structuredClone(report.sections);
    const invalid=await post('/api/classroom/analyze',{revision:state.revision,mode:'details',section:'summary',reportId:report.id});assert.equal(invalid.status,400);assert.equal(seen.length,1);
    response=await post('/api/classroom/analyze',{revision:state.revision,mode:'details',section:'observations',request:'只分析提问节奏',reportId:report.id});assert.equal(response.status,202);state=await untilAnalysis(base,response.body.jobs.at(-1).id);
    const updated=state.reports.find(r=>r.id===state.currentReportId);assert.deepEqual(updated.sections.summary,before.summary);assert.deepEqual(updated.sections.suggestions,before.suggestions);assert.equal(updated.sections.observations.length,1);assert.equal(updated.sections.knowledge.length,0);assert.deepEqual(updated.detailSections,['observations']);assert.equal(updated.parentReportId,report.id);assert.equal(seen.at(-1).request,'只分析提问节奏');
    const md=await(await fetch(base+'/api/classroom/report')).text();assert.match(md,/教师确认的简洁总结/);assert.match(md,/已确认/);assert.match(md,/表达与时间节奏/);assert.doesNotMatch(md,/## 核心知识点/);
    response=await post('/api/classroom',{revision:state.revision,action:'course',course:{title:'新课程',description:''}});state=response.body;assert.equal((await post('/api/classroom/analyze',{revision:state.revision,mode:'details',section:'knowledge',reportId:updated.id})).status,409);
  });
});
test('细分分析期间报告被人工修订时保留修订，失败不覆盖总结',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
  await withApi({modelCall:async(_,input)=>{if(input.mode==='details'){enter();await waiting;}return reviewSections(input);}},async({base,post,dataDir})=>{
    try{
      await seedReviewClassroom(dataDir);let state=await(await fetch(base+'/api/classroom')).json();let response=await post('/api/classroom/analyze',{revision:state.revision});state=await untilAnalysis(base,response.body.jobs.at(-1).id);const r=state.reports.find(r=>r.id===state.currentReportId);
      response=await post('/api/classroom/analyze',{revision:state.revision,mode:'details',section:'observations',reportId:r.id});await entered;const jobId=response.body.jobs.at(-1).id;
      state=await(await fetch(base+'/api/classroom')).json();const edited=await post('/api/classroom',{revision:state.revision,action:'reportItem',reportId:r.id,section:'summary',itemId:r.sections.summary[0].id,text:'外部操作的新修订'});assert.equal(edited.status,200);
      release();state=await untilAnalysis(base,jobId,'failed');assert.match(state.jobs.at(-1).error,/未覆盖教师修改/);assert.equal(state.currentReportId,r.id);assert.equal(state.reports.find(r=>r.id===r.id).sections.summary[0].text,'外部操作的新修订');
    }finally{release();}
  });
});

test('不兼容浏览器的WAV保存原音频并提供MP3回放；无引用替换文件被清理',async()=>{
  await withApi({speechCall:async(mode,file,event,options)=>{if(mode==='playback'){await writeFile(options.playbackPath,'compatible-mp3');return {prepared:true};}return {duration:10,codec:'adpcm_ima_wav',format:'wav'};}},async({base,dataDir})=>{
    const upload=async name=>{const state=await(await fetch(base+'/api/classroom')).json();return await(await fetch(base+'/api/classroom/audio?name='+name+'&revision='+state.revision,{method:'POST',body:'original-wav'})).json();};
    const first=await upload('first.wav');assert.ok(first.audio.playbackFile);assert.equal(await readFile(path.join(dataDir,'audio',first.audio.file),'utf8'),'original-wav');const response=await fetch(base+'/api/classroom/audio?id='+first.audio.id);assert.equal(response.headers.get('content-type'),'audio/mpeg');assert.equal(await response.text(),'compatible-mp3');
    const second=await upload('second.wav');await new Promise(r=>setTimeout(r,20));const files=await readdir(path.join(dataDir,'audio'));assert.deepEqual(files.sort(),[second.audio.file,second.audio.playbackFile].sort());
  });
});
test('报告下载绑定当前版本，别的操作改变输入后拒绝导出旧快照',async()=>{
  await withApi({modelCall:async(_,input)=>reviewSections(input)},async({base,post,dataDir})=>{
    await seedReviewClassroom(dataDir);let state=await(await fetch(base+'/api/classroom')).json();const response=await post('/api/classroom/analyze',{revision:state.revision});state=await untilAnalysis(base,response.body.jobs.at(-1).id);const query='/api/classroom/report?revision='+state.revision+'&reportId='+state.currentReportId;
    assert.equal((await fetch(base+query)).status,200);await post('/api/classroom',{revision:state.revision,action:'course',course:{title:'变化',description:''}});assert.equal((await fetch(base+query)).status,409);
  });
});
test('分析暂停阻止旧提交，继续重用已完成分段，取消删除进度且不覆盖旧报告',async()=>{
  let entered,release,block=true;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r),seen=[];
  await withApi({modelCall:async(_,input,config)=>{
    if(input.segments){seen.push(input.segments[0].id);if(input.segments[0].id==='e2'&&block){entered();await Promise.race([gate,new Promise((_,reject)=>config.signal.addEventListener('abort',()=>reject(Error('已中断')),{once:true}))]);}}
    return {sections:{summary:[{text:'整体总结',kind:'transcript',evidenceIds:[input.segments?.[0].id||'e1']}],suggestions:[]}};
  }},async({base,post,dataDir})=>{
    try{
      const state=await seedReviewClassroom(dataDir);state.transcriptVersions[0].segments=[{id:'e1',start:0,end:10,text:'内容'.repeat(4200)},{id:'e2',start:20,end:30,text:'后续'.repeat(200)}];await writeFile(path.join(dataDir,'classroom.json'),JSON.stringify(state));
      let response=await post('/api/classroom/analyze',{revision:0}),jobId=response.body.jobs.at(-1).id;await start;let current=await(await fetch(base+'/api/classroom')).json();response=await post('/api/classroom/jobs/'+jobId+'/pause',{revision:current.revision});assert.equal(response.status,200);assert.equal(response.body.jobs.at(-1).stage,'paused');assert.equal(response.body.currentReportId,null);
      block=false;release();await new Promise(r=>setTimeout(r,20));current=await(await fetch(base+'/api/classroom')).json();response=await post('/api/classroom/jobs/'+jobId+'/resume',{revision:current.revision});assert.equal(response.status,200);current=await untilAnalysis(base,jobId);assert.deepEqual(seen,['e1','e2','e2']);assert.ok(current.currentReportId);// Completion is persisted before the asynchronous checkpoint cleanup finishes.
      const progressFile='classroom-progress-'+jobId+'.json';
      for(let i=0;i<200&&(await readdir(dataDir)).includes(progressFile);i++)await new Promise(r=>setTimeout(r,10));
      assert.ok(!(await readdir(dataDir)).includes(progressFile),'已完成任务应在时限内清理检查点');
    }finally{release();}
  });
});

test('音频对话问候直接回答不生成分析；明确修改才更新报告，历史与上下文可清理',async()=>{
  await withApi({modelCall:async(_,input)=>input.phase==='classroom-decide'?input.request==='你好'?{action:'reply',reply:'你好！'}:{action:'edit',reply:'已修改总结措辞',operations:[{section:'summary',itemId:input.report.sections.summary[0].id,text:'对话修订的总结'}]}:reviewSections(input)},async({base,post,dataDir})=>{
    await seedReviewClassroom(dataDir);let state=await(await fetch(base+'/api/classroom')).json();let response=await post('/api/classroom/chat',{revision:state.revision,request:'你好'});assert.equal(response.status,200);state=response.body.state;assert.equal(state.jobs.length,0);assert.equal(state.reports.length,0);assert.equal(state.conversation.length,2);
    response=await post('/api/classroom/analyze',{revision:state.revision});state=await untilAnalysis(base,response.body.jobs.at(-1).id);response=await post('/api/classroom/chat',{revision:state.revision,request:'修改总结措辞'});assert.equal(response.status,200);state=response.body.state;const report=state.reports.find(r=>r.id===state.currentReportId);assert.equal(report.sections.summary[0].text,'对话修订的总结');assert.equal(report.history.length,1);
    response=await post('/api/classroom',{revision:state.revision,action:'clearConversation'});assert.equal(response.body.conversation.length,0);assert.equal(response.body.reports.length,1);
  });
});
