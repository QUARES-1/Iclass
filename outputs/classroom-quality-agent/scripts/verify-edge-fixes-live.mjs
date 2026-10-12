// Real-provider checks with fabricated teaching data only. No teacher workspace
// or custom teacher prompt is read or sent; only configured connection fields.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ModelSettings} from '../src/modelSettings.js';
import {DEFAULT_PROMPTS} from '../src/prompts.js';
import {emptyWorkspace,createResource,currentVersion} from '../src/workspace.js';
import {newAgentJob,runTeachingAgent,commitAgentDrafts} from '../src/agent.js';
import {sampleActivities} from '../src/samples.js';
import {requestJSON} from '../src/model.js';
import {analyzeClassroom} from '../src/analysis.js';
const root=new URL('..',import.meta.url).pathname;process.loadEnvFile(path.join(root,'.env'));
const saved=await new ModelSettings(path.join(root,'data')).read();
const config={apiKey:saved.apiKey,baseUrl:saved.baseUrl,model:saved.model,maxTokens:4000,temperature:0,timeoutMs:saved.timeoutMs,maxInputChars:saved.maxInputChars,batchPages:3,maxAgentCalls:24,maxPlanSteps:12,maxRepairs:1,prompts:{...DEFAULT_PROMPTS}};
const results=[],debug=[];
const selected=process.argv[2]?.split(',');
const enabled=name=>!selected||selected.includes(name);
const call=async(system,input,options)=>{const result=await requestJSON(system,input,options);debug.push({phase:input.phase,mode:input.mode,request:input.request,response:result});return result;};
function fixture(count=3){const state=emptyWorkspace();state.requirements={topic:'排序',audience:'本科',duration:300,instructions:'讲清原理与实际操作'};const ppt=createResource(state,'ppt','模拟课件',{slides:Array.from({length:count},(_,i)=>({title:'旧标题'+(i+1),bullets:['先比较，再交换'],notes:['保留教师备注']}))});state.selectedId=ppt.id;return {state,ppt};}
async function agentCase(name,state,request,resourceId,check){if(!enabled(name))return;const job=newAgentJob(state,request,resourceId);await runTeachingAgent(job,{config,call});if(job.mode==='task')commitAgentDrafts(state,job);await check(job);const result={name,calls:job.calls,mode:job.mode,execution:job.execution,passed:true};results.push(result);console.log(JSON.stringify(result));}
try{
  {const {state,ppt}=fixture();state.analysis={chapters:[],objectives:[],knowledgePoints:['教师已修订：本轮采用交通信号灯类比顺序'],keyPoints:[],difficultPoints:[]};state.analysisSource='teacher';state.supplements=[{title:'已选择补充',description:'让学生用红黄绿三张卡片排序',source:'构造的教师补充'}];await agentCase('teacher-context',state,'根据我修订的知识点和选中的补充，用两句话建议怎么开场，不修改资源',ppt.id,job=>{assert.equal(job.mode,'conversation');assert.match(job.directCandidate.reply,/交通|信号灯|红黄绿|卡片/);});}
  {const {state,ppt}=fixture();const game=createResource(state,'game','模拟小游戏',sampleActivities[0]);await agentCase('page-attachment',state,'把小游戏放到当前PPT第2页，其他页面不动',ppt.id,()=>{const slides=currentVersion(ppt).content.slides;assert.equal(slides[1].attachment.resourceId,game.id);assert.equal(slides[0].attachment,undefined);});}
  {const {state,ppt}=fixture();await agentCase('multiple-page-edit',state,'把第2页和第3页标题分别改为第二章、第三章，只改标题',ppt.id,()=>{const slides=currentVersion(ppt).content.slides;assert.equal(slides[1].title,'第二章');assert.equal(slides[2].title,'第三章');assert.equal(slides[0].title,'旧标题1');});}
  {const {state,ppt}=fixture(6);await agentCase('batch-title-edit',state,'把当前课件所有页的标题都改为完全相同的四个字：简洁标题。不是逐页概括，六页都使用这个字符串，只改标题，正文和备注原样保留',ppt.id,()=>{assert.equal(currentVersion(ppt).content.slides.length,6);assert.ok(currentVersion(ppt).content.slides.every(s=>s.title==='简洁标题'&&s.notes[0]==='保留教师备注'));});}
  {const state=emptyWorkspace();state.messages=Array.from({length:12},(_,i)=>({id:'synthetic-history-'+i,role:i%2?'assistant':'user',text:'这是为边界测试构造的历史消息。'.repeat(600).slice(0,10000),status:'complete'}));await agentCase('long-history-greeting',state,'你好',null,job=>{assert.equal(job.mode,'conversation');assert.equal(job.calls,1);assert.equal(job.plan,null);});}
  const transcript={segments:[{id:'synthetic-1',start:0,end:20,text:'今天讨论相邻比较与交换。我先用三个数字演示。'},{id:'synthetic-2',start:20,end:40,text:'为什么只交换相邻逆序的元素？我再重复讲一次相邻交换。'},{id:'synthetic-3',start:40,end:60,text:'现在让每位同学尝试一次，再解释比较和交换的顺序。'}]};
  if(enabled('classroom-overview')){const overview=await analyzeClassroom({title:'构造的测试课堂',description:'只用于产品交互测试'},transcript,call,undefined,config);assert.equal(overview.sections.summary.length,1);assert.ok(overview.sections.suggestions.length<=3);assert.deepEqual(overview.sections.knowledge,[]);results.push({name:'classroom-overview',summaryItems:overview.sections.summary.length,suggestionItems:overview.sections.suggestions.length,passed:true});console.log(JSON.stringify(results.at(-1)));}
  if(enabled('classroom-on-demand-detail')){const detail=await analyzeClassroom({title:'构造的测试课堂',description:''},transcript,call,undefined,config,{mode:'details',requestedSections:['observations'],request:'只评价提问与重复讲解，不重复总览'});assert.equal(detail.sections.summary.length,0);assert.ok(detail.sections.observations.length>0);assert.equal(detail.sections.knowledge.length,0);results.push({name:'classroom-on-demand-detail',detailItems:detail.sections.observations.length,passed:true});console.log(JSON.stringify(results.at(-1)));}
}finally{let previous={results:[],debug:[]};if(selected){try{previous=JSON.parse(await fs.readFile(path.join(root,'artifacts/review/live-fixes.json'),'utf8'));}catch{}}
results.unshift(...previous.results.filter(r=>!results.some(current=>current.name===r.name)));debug.unshift(...(previous.debug||[]));await fs.mkdir(path.join(root,'artifacts/review'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/review/live-fixes.json'),JSON.stringify({checkedAt:new Date().toISOString(),syntheticOnly:true,teacherTeachingDataUsed:false,results,debug},null,2));}
