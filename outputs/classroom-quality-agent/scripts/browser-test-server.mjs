// Deterministic model fixture for browser integration; never used in the app.
import http from 'node:http';
import fs from 'node:fs/promises';
import { sampleActivities } from '../src/samples.js';
import { codeFixture } from '../test-support/codeFixture.js';
process.env.PORT='3107';process.env.LLM_RATE_LIMIT='1000';process.env.LLM_BASE_URL='http://127.0.0.1:3108';process.env.LLM_API_KEY='browser-test-fixture';process.env.DATA_DIR=new URL('../artifacts/browser-data',import.meta.url).pathname;
await fs.rm(process.env.DATA_DIR,{recursive:true,force:true});
const truncated=new Set(),reviewed=new Set();
const mock=http.createServer(async(req,res)=>{
  let data='';for await(const c of req)data+=c;
  const body=JSON.parse(data);let input,out;
  // The retained material-understanding route sends a plain-text prompt.
  // Fail that fixture request explicitly so the app exercises its labelled
  // local-rule fallback; never crash the mock and the application process.
  try{input=JSON.parse(body.messages.at(-1).content);}catch{res.writeHead(503);res.end('{}');return;}
  if(input.task==='connection-test'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}));return;}
  if(input.phase==='execute' && input.request?.includes('长课件慢速'))await new Promise(r=>setTimeout(r,input.request.includes('并行聊天验证')?2500:650));
  if(input.phase==='execute' && input.request?.includes('长课件自动') && !truncated.has(input.request)){truncated.add(input.request);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{'}}]}));return;}
  if(input.request?.includes('服务失败')){res.writeHead(503);res.end('{}');return;}
  if(input.phase==='classroom-decide'){
    if(input.request==='把总结改成教师的新总结')out={action:'edit',reply:'已调整总结措辞。',operations:[{section:'summary',itemId:input.report.sections.summary[0].id,text:'教师的新总结'}]};
    else if(input.request==='补充提问与时间节奏分析')out={action:'analyze',section:'observations',reply:'正在补充这部分分析，保留整体复盘。'};
    else out={action:'reply',reply:'你好！可以一起讨论这份课堂复盘。'};
  }
  else if(input.phase==='decide' && input.request==='你好'){out={action:'reply',reply:'你好！有什么想一起讨论的？'};}
  else if(input.phase==='decide' && input.request==='平衡树是什么？'){out={action:'reply',reply:'平衡树通过维护树的高度或结构，让查找、插入和删除保持高效。'};}
  else if(input.phase==='decide' && input.request==='帮我改一下'){out={action:'clarify',reply:'要修改哪份资源的哪一部分？'};}
  else if(input.phase==='decide' && input.request==='现在生成到哪里了？'){
    out=input.toolResults.length?{action:'reply',reply:'正在生成课件，已完成 '+input.toolResults[0].data.find(t=>t.mode==='task').completedBatches+' 批。'}:{action:'tool',tool:'task.status',args:{}};
  }
  else if(input.phase==='decide' && input.request==='解释第二页内容'){
    const target=input.resources.find(r=>r.id===input.selectedId);
    out=input.toolResults.length?{action:'reply',reply:'第二页内容：'+input.toolResults[0].data.content.slides[0].title}:{action:'tool',tool:'resource.read',args:{resourceId:target.id,pageIds:[target.pages[1].id]}};
  }
  else if(input.phase==='decide' && input.request==='把小游戏放到当前PPT第2页'){
    const target=input.resources.find(r=>r.id===input.selectedId),activity=input.resources.find(r=>r.type==='game');
    out={action:'attach',reply:'已关联第二页小游戏',pptId:target.id,activityId:activity.id,slideId:target.pages[1].id};
  }
  else if(input.phase==='decide' && input.request==='把第2页和第3页标题分别改为第二章、第三章'){
    const target=input.resources.find(r=>r.id===input.selectedId);out={action:'update',reply:'已修改两个标题',operations:target.pages.slice(1,3).map((p,i)=>({action:'update',slideId:p.id,patch:{title:['第二章','第三章'][i]}}))};
  }
  else if(input.phase==='decide' && input.request==='把当前课件所有页的标题改得简洁'){
    const target=input.resources.find(r=>r.id===input.selectedId);out={action:'plan',courseMode:'partial',reply:'分批简化标题',steps:[{id:'titles',title:'简化标题',tool:'ppt.update',resourceId:target.id,targetIds:target.pages.map(p=>p.id),instructions:'仅修改标题',minutes:0,pages:target.pages.length}]};
  }
  else if(input.phase==='execute' && input.request==='把当前课件所有页的标题改得简洁'){
    out={action:'update',reply:'标题已简化',operations:input.task.targetIds.map(slideId=>({action:'update',slideId,patch:{title:'简洁标题'}}))};
  }
  else if(input.phase==='decide' && input.request==='第2页标题改为关键操作'){
    const target=input.resources.find(r=>r.id===input.selectedId);
    out=input.toolResults.length?{action:'update',reply:'第二页标题已改为关键操作',operations:[{action:'update',slideId:target.pages[1].id,patch:{title:'关键操作'}}]}:{action:'tool',tool:'resource.read',args:{resourceId:target.id,pageIds:[target.pages[1].id]}};
  }
  else if(input.segments || input.partials){const segs=input.segments || input.partials.flatMap(p=>p.ids.map(id=>({id,text:'分段内容'})));out={sections:Object.fromEntries((input.requestedSections||['summary','knowledge','emphasis','difficulties','observations','suggestions']).map(k=>[k,[{text:'接口测试模型：'+segs[0].text,kind:k==='difficulties'?'hypothesis':k==='emphasis'?'ai-inference':'transcript',evidenceIds:[segs[0].id]}]]))};}
  else if(input.phase==='decide'&&input.request?.includes('输出修正验证')){out={action:'plan',goal:input.request,reply:'验证已有源码的输出修正',steps:[{id:'implementation',title:'示例代码',tool:'ppt.create',resourceId:'current',targetIds:[],instructions:'提供真实示例代码',focus:'implementation',needsCode:true,topics:[],sourceIds:[],minutes:input.requirements.duration,pages:1}]};}
  else if(input.phase==='review'&&input.request?.includes('输出修正验证')){const output=input.content.find(p=>p.content.code?.kind==='output'),r=input.resources.find(r=>r.type==='ppt');out=output.content.code.source==='9'?{action:'review',passed:true,reply:'输出修正功能通过',issues:[],repairSteps:[]}:{action:'review',passed:false,reply:'修正输出字段',issues:['预期输出标注需要修正'],repairSteps:[{id:'fix-output',title:'修正预期输出',tool:'ppt.update',resourceId:r.id,targetIds:[output.content.id],instructions:'将输出块中的输出由 8 改为 9，保留已有源码',focus:'demonstration',needsCode:true,pages:1,minutes:0,sourceIds:[],topics:[]}]};}
  else if(input.phase==='execute'&&input.request?.includes('输出修正验证')){const output=input.resource?.content.slides.find(s=>s.code?.kind==='output');out=output?{action:'update',reply:'仅修改输出文本，保留程序',operations:[{action:'update',slideId:output.id,patch:{code:{source:'9'}}}]}:{action:'create',type:'ppt',name:'输出修正功能课件',reply:'提供示例代码',content:{slides:[{title:'完整实现',bullets:[],notes:[],code:{language:'cpp',source:'int square(int x) { return x * x; }\n',expectedOutput:'8'}}]}};}
  else if(input.phase==='decide'){const target=input.resources.find(r=>r.id===input.selectedId),create=/新建/.test(input.request),activity=/小游戏|游戏/.test(input.request);out={action:'plan',goal:input.request,reply:'安排教学步骤',steps:[{id:'lesson',title:'教学内容',tool:create?(activity?'activity.create':'ppt.create'):(target?.type==='ppt'?'ppt.update':'activity.update'),resourceId:target?.id||'current',targetIds:create?[]:(input.scopeIds||target?.pages?.slice(0,1).map(p=>p.id)||[]),instructions:input.request,topics:[],sourceIds:[],minutes:input.requirements.duration,pages:input.request.includes('代码展示验证')?1:/长课件/.test(input.request)?7:create&&!activity?3:1}]};}
  else if(input.phase==='review'){out={action:'review',passed:true,reply:'教学目标检查通过',issues:[],repairSteps:[]};if(input.request?.includes('长课件自动') && !reviewed.has(input.request)){reviewed.add(input.request);const r=input.resources.find(r=>r.type==='ppt');out={action:'review',passed:false,reply:'缺少可实操示例',issues:['补充最后一页实操示例'],repairSteps:[{id:'repair',title:'补充实操',tool:'ppt.update',resourceId:r.id,targetIds:[r.pages.at(-1).id],instructions:'增加具体可操作案例',topics:[],sourceIds:[],pages:1,minutes:0}]};}}
  else if(input.phase==='execute' && input.request?.includes('代码展示验证')){out={action:'create',type:'ppt',name:'代码课件',reply:'代码已生成',content:{slides:[{title:'实现与调用',section:'讲解',bullets:[],notes:[],code:{language:'cpp',source:codeFixture,expectedOutput:'14\n'}}]}};}
  else if(input.phase==='execute' && input.request?.includes('长课件') && !input.task.id.startsWith('repair')){const slides=Array.from({length:input.task.pageCount},(_,i)=>({title:'实操页 '+(input.task.pageStart+i),bullets:['原理','操作步骤'],notes:['教师备注']}));out=input.task.tool==='ppt.create'?{action:'create',type:'ppt',name:'自主长课件',reply:'本批已完成',content:{slides}}:{action:'update',reply:'补充后续章节',operations:slides.map(slide=>({action:'add',slide}))};}
  else if(input.request?.includes('小游戏') && /新建/.test(input.request)){out={action:'create',type:'game',name:'接口测试小游戏',reply:'接口测试模型生成内容',content:sampleActivities[0]};}
  else if(input.resource?.type==='ppt' && (!input.request?.includes('新建') || input.task?.id?.startsWith('repair'))){const page=input.resource.content.slides.find(s=>input.scopeIds?.includes(s.id)) || input.resource.content.slides[0];out={action:'update',reply:'接口测试模型修改指定字段',operations:[{action:'update',slideId:page.id,patch:{example:'具体例子：[3, 1, 2] 排成 [1, 2, 3]'}}]};}
  else if(input.resource && !input.request?.includes('新建')){out={action:'update',reply:'接口测试模型更新规则',content:{...input.resource.content,description:'新增操作提示：先比较再选择。',questions:input.resource.content.questions?.map(q=>({...q,explanation:'修改后的解释：保持同值相对顺序。'}))}};}
  else{out={action:'create',type:'ppt',name:'接口测试PPT',reply:'接口测试模型生成PPT',content:{slides:[1,2,3].map(i=>({section:'讲解',title:'排序页面 '+i,bullets:['相邻比较','仅交换逆序元素'],notes:['教师备注'],example:'原例子',counterExample:'反例'}))}};}
  if(input.course?.title==='建议展开验证'&&out.sections?.suggestions)out.sections.suggestions=Array.from({length:7},(_,i)=>({text:`建议${i+1}：`+'说明课堂问题、调整理由和可实操的示例。'.repeat(20),kind:'ai-inference',evidenceIds:[input.segments?.[0].id||input.partials[0].ids[0]]}));
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(out)}}]}));
});
await new Promise(r=>mock.listen(3108,'127.0.0.1',r));
const {server}=await import('../server.js');server.listen(3107,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();mock.close();process.exit(0);});
