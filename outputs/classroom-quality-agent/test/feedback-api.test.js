import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createApi,json} from '../src/api.js';
import {Store} from '../src/store.js';
import {ModelSettings} from '../src/modelSettings.js';

async function fixture(run,extra={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'feedback-http-')),store=new Store(dir),modelSettings=new ModelSettings(dir,{LLM_API_KEY:'feedback-http-fixture'});
  const api=createApi(fileURLToPath(new URL('..',import.meta.url)),{dataDir:dir,modelSettings,modelCall:async(system,input)=>{
    if(input.phase==='feedback-decide')return input.toolResults.length?{action:'reply',reply:'整体复盘已保存。'}:{action:'tool',tool:'analysis.generate'};
    assert.ok(input.items.some(i=>i.evidenceId==='segment:seg-one'));
    return {summary:'整体总结：课堂讲解了平衡树。',findings:[{text:'教师示范了完整函数。',kind:'observation',evidenceIds:['segment:seg-one']}],suggestions:[]};
  },feedbackClientFactory:()=>({getMe:async()=>{throw new Error('secret-provider-fixture raw response');}}),...extra});
  const server=http.createServer(async(req,res)=>{try{if(!await api(req,res,new URL(req.url,'http://'+req.headers.host)))json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},e.statusCode||500);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,request=(url,init)=>fetch(base+url,init);
  const post=async(url,data,status=200)=>{const response=await request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
  try{await run({store,dir,request,post});}finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
}
test('真实HTTP路由保护凭据、跨域和UTF-8边界，缺连接不影响本地课堂',async()=>fixture(async({request,post})=>{
  const config=await(await request('/api/feedback/settings')).json();assert.equal(config.configured,false);
  const saved=await post('/api/feedback/settings',{revision:config.revision,accessToken:'secret-provider-fixture'});assert.equal(saved.configured,true);assert.ok(!JSON.stringify(saved).includes('secret-provider-fixture'));
  const failed=await post('/api/feedback/settings/test',{revision:saved.revision},502);assert.ok(!JSON.stringify(failed).includes('secret-provider-fixture'));
  const response=await request('/api/feedback/sessions',{method:'POST',headers:{Origin:'https://foreign.test','Content-Type':'application/json'},body:'{"title":"foreign"}'});assert.equal(response.status,403);
  const malformed=await request('/api/feedback/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:Buffer.from([0x7b,0x22,0xff,0x22,0x7d])});assert.equal(malformed.status,400);
  const c=await post('/api/feedback/sessions',{title:'本地课堂'});assert.equal(c.title,'本地课堂');assert.equal(c.stats.total,0);
}));
test('仅音频可分析，历史证据与范围回听独立于最新转写，来源变化使报告待更新',async()=>fixture(async({store,dir,request,post})=>{
  const filename='11111111-1111-4111-8111-111111111111.wav',audio={id:'audio-one',file:filename,name:'独立测试音频.wav'};
  const t={id:'transcript-one',audioId:audio.id,audio,segments:[{id:'seg-one',start:0,end:4,text:'教师示范了完整函数。'}]};
  await store.update('classroom',undefined,{revision:0},()=>({revision:0,course:{title:'平衡树',description:''},audio,transcriptVersions:[t],currentTranscriptId:t.id,reports:[],jobs:[]}));
  await mkdir(path.join(dir,'audio'));await writeFile(path.join(dir,'audio',filename),Buffer.from('0123456789abcdef'));
  let c=await post('/api/feedback/sessions',{title:'仅音频课堂'}),url='/api/feedback/sessions/'+c.id;
  c=await post(url,{revision:c.revision,action:'linkAudio',transcriptId:t.id});
  const j=await post(url+'/chat',{revision:c.revision,request:'整体复盘'},202);
  let job;
  for(let i=0;i<200;i++){job=await(await request(url+'/job?id='+j.id)).json();if(['completed','failed'].includes(job.status))break;await delay(10);}
  assert.equal(job.status,'completed');assert.equal(job.config,undefined);c=await(await request(url)).json();assert.equal(c.reports.length,1);const report=c.reports[0];
  const playback=await request(url+'/audio?reportId='+report.id,{headers:{Range:'bytes=2-5'}});assert.equal(playback.status,206);assert.equal(await playback.text(),'2345');
  assert.equal((await request(url+'/audio?reportId='+report.id,{headers:{Range:'bytes=20-30'}})).status,416);
  await store.update('classroom',undefined,null,x=>{x.transcriptVersions.push({...t,id:'transcript-two',parentId:t.id,segments:[{...t.segments[0],text:'教师的新校正。'}]});x.currentTranscriptId='transcript-two';return x;});
  c=await(await request(url)).json();assert.equal(c.source.needsRefresh,true);assert.equal(c.reports[0].stale,true);
  const evidence=await(await request(url+'/evidence?reportId='+report.id)).json();assert.equal(evidence.segments[0].text,'教师示范了完整函数。');
  await post(url,{revision:c.revision,action:'report',reportId:report.id,baseVersion:1,confirm:true},422);
  await rm(path.join(dir,'audio',filename));assert.equal((await request(url+'/audio?reportId='+report.id)).status,404);
  assert.equal((await(await request(url+'/evidence?reportId='+report.id)).json()).segments.length,1);
}));
test('模型限流仅阻止续跑，不阻止暂停或取消任务',async()=>{
  let checks=0;
  await fixture(async({request,post})=>{
    const c=await post('/api/feedback/sessions',{title:'任务控制课堂'}),url='/api/feedback/sessions/'+c.id;
    const job=await post(url+'/chat',{revision:c.revision,request:'你好'},202);
    assert.equal((await post(url+'/job',{id:job.id,action:'pause'})).status,'paused');
    await post(url+'/job',{id:job.id,action:'resume'},429);
    assert.equal((await post(url+'/job',{id:job.id,action:'cancel'})).status,'cancelled');assert.equal(checks,1);
  },{feedbackRateLimit:()=>{checks++;return true;}});
});
test('跨课堂预览、任务、报告和音频引用不能串用，回答可按中文选项搜索',async()=>fixture(async({store,dir,request,post})=>{
  let a=await post('/api/feedback/sessions',{title:'隔离课堂甲'}),b=await post('/api/feedback/sessions',{title:'隔离课堂乙'});const urlA='/api/feedback/sessions/'+a.id,urlB='/api/feedback/sessions/'+b.id;
  const preview=await post(urlA+'/preview',{data:{classId:a.id,records:[{id:'isolation-one',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4}}]}});
  await post(urlB+'/import',{revision:b.revision,previewId:preview.id},422);a=await post(urlA+'/import',{revision:a.revision,previewId:preview.id});assert.equal(a.stats.total,1);assert.equal((await(await request(urlB)).json()).stats.total,0);
  const q=a.template.questions.find(q=>q.id==='q-difficulty'),label=q.options.find(o=>o.id==='hard').label;
  assert.equal((await(await request(urlA+'/records?q='+encodeURIComponent(label))).json()).total,1);
  const j=await post(urlA+'/chat',{revision:a.revision,request:'你好'},202);assert.equal((await request(urlB+'/job?id='+j.id)).status,404);await post(urlB+'/job',{id:j.id,action:'pause'},404);
  const filename='22222222-2222-4222-8222-222222222222.wav';await mkdir(path.join(dir,'audio'));await writeFile(path.join(dir,'audio',filename),'local-b-audio');
  await store.update('feedback-source-isolated-source',undefined,{revision:0},()=>({audio:{file:filename}}));
  await store.update('feedback-input-without-audio',undefined,{revision:0},()=>({source:null,records:[]}));
  await store.update('feedback-class-'+b.id,undefined,null,x=>{x.source={id:'isolated-source'};x.reports=[{id:'without-audio',inputId:'without-audio'}];return x;});
  assert.equal((await request(urlB+'/audio?reportId=report-from-other-class')).status,404);
  assert.equal((await request(urlB+'/audio?reportId=without-audio')).status,404);
  assert.equal((await request(urlB+'/evidence?reportId=report-from-other-class')).status,404);assert.equal((await request(urlB+'/report?id=report-from-other-class&version=1')).status,409);
  for(let i=0;i<100;i++){const job=await(await request(urlA+'/job?id='+j.id)).json();if(job.status==='completed')break;await delay(10);}
},{modelCall:async()=>({action:'reply',reply:'你好！'})}));
test('异常JSON形状、重复建议标识与无效交接选择均明确拒绝且不改原稿',async()=>fixture(async({request,post})=>{
  for(const data of [null,[],1,'hello'])await post('/api/feedback/sessions',data,400);
  let c=await post('/api/feedback/sessions',{title:'异常输入课堂'}),url='/api/feedback/sessions/'+c.id;
  c=await post(url,{revision:c.revision,action:'suggestions',suggestions:[{id:'keep',text:'教师原建议',evidenceIds:[]}]});
  for(const suggestions of [[null],[{id:'keep',text:'第一条'},{id:'keep',text:'第二条'}],[{id:'keep',text:'错误引用',evidenceIds:'course'}]])await post(url,{revision:c.revision,action:'suggestions',suggestions},422);
  for(const ids of ['keep',['keep','missing'],['keep','keep']])await post(url+'/handoff',{revision:c.revision,ids},422);
  const after=await(await request(url)).json();assert.equal(after.revision,c.revision);assert.deepEqual(after.suggestions,c.suggestions);
}));
