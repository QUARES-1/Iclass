import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyClassroom, formatTime, migrateClassroom, validateSegments, applyClassroomCommand, validateReportSections, buildClassroomReport, textObservations, REPORT_SECTIONS } from '../src/classroom.js';
import { partitionTranscript, analyzeClassroom } from '../src/analysis.js';
import {transcriptText} from '../src/classroomShared.js';
const segments=[{id:'a',start:1,end:6,text:'重点是相邻交换。',timestampSource:'test-alignment'},{id:'b',start:10,end:15,text:'为什么只交换相邻元素？',timestampSource:'test-alignment'}];
function sections(evidenceIds=['a']) {return Object.fromEntries(Object.keys(REPORT_SECTIONS).map(k=>[k,[{text:k==='suggestions'?'增加一次相邻交换演示。':'相邻交换的教学内容',kind:k==='difficulties'?'hypothesis':k==='emphasis'?'teacher-emphasis':'transcript',evidenceIds}]]));}
function state(){const s=emptyClassroom();s.audio={id:'audio-1'};s.transcriptVersions=[{id:'t1',source:'asr',audioId:'audio-1',original:true,segments}];s.currentTranscriptId='t1';s.reports=[{id:'r1',transcriptId:'t1',courseVersion:0,course:{title:'排序',description:''},stale:false,sections:validateReportSections(sections(),segments)}];s.currentReportId='r1';return s;}
test('时间显示保留小时及非负时间',()=>{assert.equal(formatTime(3661),'1:01:01');assert.equal(formatTime(-1),'00:00');});
test('完整转写全文覆盖首尾所有片段，排除标记和小时级时间可追溯',()=>{
  const t={segments:Array.from({length:845},(_,i)=>({id:'s'+i,start:i*5,end:i*5+4,text:'完整文字第'+i+'段',excluded:i===400}))};
  const plain=transcriptText(t),timed=transcriptText(t,{timestamps:true});for(const s of t.segments){assert.ok(plain.includes(s.text));assert.ok(timed.includes(s.text));}
  assert.match(plain,/已排除误识别/);assert.match(timed,/\[1:10:20—1:10:24\]/);assert.equal(timed.split('\n').length,845);assert.equal(transcriptText(null),'');
});
test('旧数据只迁移音频流程字段并保留合法转写',()=>{const s=migrateClassroom({meta:{course:'旧课程'},headUpRate:{average:0.8},tone:{mood:'calm'},segments});assert.equal(s.course.title,'旧课程');assert.equal(s.transcriptVersions[0].segments.length,2);assert.equal('headUpRate' in s,false);assert.equal('tone' in s,false);});
test('真实时间检查拒绝越界、时间归零及重复ID',()=>{assert.equal(validateSegments(segments,16,'test').length,2);assert.throws(()=>validateSegments(segments,4,'test'));assert.throws(()=>validateSegments([...segments,{...segments[0],id:'c'}],16,'test'));assert.throws(()=>validateSegments([segments[0],{...segments[1],id:'a'}],16,'test'));});
test('文字校正保留识别原稿与时间，旧报告待更新',()=>{const s=state();const next=applyClassroomCommand(s,{action:'correct',transcriptId:'t1',segments:[{id:'a',text:'人工校正术语'},{id:'b',text:segments[1].text}]});assert.equal(next.transcriptVersions[0].segments[0].text,segments[0].text);assert.equal(next.transcriptVersions[0].original,true);assert.equal(next.transcriptVersions[1].original,false);assert.equal(next.transcriptVersions[1].parentId,'t1');assert.equal(next.transcriptVersions[1].segments[0].start,1);assert.equal(next.reports[0].stale,true);assert.notEqual(next.currentTranscriptId,'t1');assert.equal(s.reports[0].stale,false);});
test('课程变更与原音频删除使分析失效，过期结论不能确认',()=>{const next=applyClassroomCommand(state(),{action:'course',course:{title:'新课程',description:'新说明'}});assert.equal(next.reports[0].stale,true);const item=next.reports[0].sections.summary[0];assert.throws(()=>applyClassroomCommand(next,{action:'reportItem',reportId:'r1',section:'summary',itemId:item.id,confirm:true}),/重新分析/);assert.equal(applyClassroomCommand(state(),{action:'deleteAudio'}).audio,null);});
test('模型加载期间也不能删除正在识别的录音或清空课堂，结束后可删除',()=>{
  for(const stage of ['queued','processing','loading-model','transcribing']){
    const s=state();s.jobs=[{id:'job-1',type:'transcribe',stage}];
    for(const action of ['deleteAudio','clear'])assert.throws(()=>applyClassroomCommand(s,{action}),error=>error.statusCode===409);
    assert.equal(s.audio.id,'audio-1');assert.equal(s.transcriptVersions.length,1);
  }
  for(const stage of ['completed','failed']){
    const s=state();s.jobs=[{id:'job-1',type:'transcribe',stage}];
    assert.equal(applyClassroomCommand(s,{action:'deleteAudio'}).audio,null);
    assert.deepEqual(applyClassroomCommand(s,{action:'clear'}),{...emptyClassroom(),audioGeneration:s.audioGeneration+1,conversationGeneration:s.conversationGeneration+1});
  }
});
test('重要结论证据及推测类型必须有效',()=>{assert.throws(()=>validateReportSections(sections(['missing']),segments),/证据/);const invalid=sections();invalid.difficulties[0].kind='transcript';assert.throws(()=>validateReportSections(invalid,segments),/推测/);});
test('教师修订撤销确认，报告含修订、证据与转写版本',()=>{let s=state();const item=s.reports[0].sections.suggestions[0];s=applyClassroomCommand(s,{action:'reportItem',reportId:'r1',section:'suggestions',itemId:item.id,confirm:true});s=applyClassroomCommand(s,{action:'reportItem',reportId:'r1',section:'suggestions',itemId:item.id,text:'用四个数字展示一次交换。'});assert.equal(s.reports[0].sections.suggestions[0].confirmed,false);const md=buildClassroomReport(s);assert.match(md,/教师修订/);assert.match(md,/00:01—00:06/);assert.match(md,/t1/);assert.doesNotMatch(md,/headUpRate|抬头率统计/);});
test('普通统计仅使用文本及有来源的片段间隔',()=>{const o=textObservations(segments);assert.equal(o.questions,1);assert.deepEqual(o.gaps[0].evidenceIds,['a','b']);assert.match(o.basis,/不是声学/);});
test('长文本分段完整覆盖，不遗漏中段',()=>{const s=Array.from({length:12},(_,i)=>({id:String(i),start:i,end:i+1,text:'术语'.repeat(1300)}));const chunks=partitionTranscript(s);assert.deepEqual(chunks.flat().map(x=>x.id),s.map(x=>x.id));assert.ok(chunks.length>1);});
test('合法长校正片段独立分析，保留原ID和时间，不要求不可用的拆分操作',async()=>{
  const s=state();const corrected=applyClassroomCommand(s,{action:'correct',transcriptId:'t1',segments:[{id:'a',text:'术语'.repeat(8000)},{id:'b',text:segments[1].text}]});const t=corrected.transcriptVersions.at(-1);
  const chunks=partitionTranscript(t.segments);assert.deepEqual(chunks.map(p=>p.map(s=>s.id)),[['a'],['b']]);assert.equal(chunks[0][0].start,1);
  const result=await analyzeClassroom({},t,async(_,input)=>({sections:sections([input.segments?.[0].id||'a'])}));assert.deepEqual(result.coverage.flatMap(p=>p.ids),['a','b']);
});
test('大量短片段按完整请求大小分段，时间间隔与课程说明不会挤爆上下文',async()=>{
  const s=Array.from({length:700},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),start:i*5,end:i*5+1,text:'要点。',timestampSource:'whisper-word-alignment+vad-offset+chunk-offset'}));const seen=[];
  const result=await analyzeClassroom({title:'课程'.repeat(250),description:'说明'.repeat(4000)},{segments:s},async(_,input)=>{
    assert.ok(JSON.stringify(input).length<=115000,'每次实际模型输入都应在上限内');if(input.segments)seen.push(...input.segments.map(s=>s.id));
    return {sections:sections([input.segments?.[0].id||input.partials[0].ids[0]])};
  });
  assert.ok(result.coverage.length>1);assert.deepEqual(seen,s.map(s=>s.id));assert.deepEqual(result.coverage.flatMap(p=>p.ids),seen);
});
test('长分析统一总结不拼接分段条目，覆盖完整保留且失败不提交',async()=>{const s={id:'long',segments:Array.from({length:4},(_,i)=>({id:String(i),start:i,end:i+1,text:'术语'.repeat(2000)}))};const call=async(_,input)=>({sections:sections([input.segments?.[0].id||'0'])});const result=await analyzeClassroom({},s,call);assert.equal(result.coverage.flatMap(p=>p.ids).length,4);assert.equal(result.sections.summary.length,1);assert.equal(result.sections.suggestions.length,1);assert.equal(result.sections.knowledge.length,0);assert.equal(result.mode,'overview');await assert.rejects(()=>analyzeClassroom({},s,async()=>{throw new Error('offline');}),/第 1/);});
test('汇总只接收已引用的证据及段范围，整课覆盖仍保留全部片段',async()=>{
  const transcript={segments:Array.from({length:4},(_,i)=>({id:'segment-'+i,start:i*20,end:i*20+15,text:'知识'.repeat(2000)}))};
  let summaryInput;
  const result=await analyzeClassroom({},transcript,async(_,input)=>{
    if(input.segments)return {sections:sections([input.segments[0].id])};
    summaryInput=input;return {sections:sections(input.partials.flatMap(p=>p.ids))};
  });
  assert.deepEqual(summaryInput.partials.flatMap(p=>p.ids),['segment-0','segment-2']);
  assert.equal(summaryInput.coverage.reduce((n,p)=>n+p.segmentCount,0),4);
  assert.equal(summaryInput.coverage.at(-1).end,75);
  assert.deepEqual(result.coverage.flatMap(p=>p.ids),transcript.segments.map(s=>s.id));
  assert.ok(Object.values(result.sections).flat().every(item=>item.evidenceIds.every(id=>['segment-0','segment-2'].includes(id))));
});

test('迁移旧报告去除遗留指标及派生结论，合法音频观察保留',()=>{const s=state();s.reports[0].headUpRate={average:0.8};s.reports[0].sections.observations.push({id:'old',text:'注意力回落',kind:'transcript',evidenceIds:['a']});const clean=migrateClassroom(s);assert.equal('headUpRate' in clean.reports[0],false);assert.equal(clean.reports[0].sections.observations.length,1);assert.equal(clean.transcriptVersions[0].segments[0].text,segments[0].text);});

test('默认仅生成统一总结和建议，模型额外返回的细分内容不进入报告',async()=>{
  const result=await analyzeClassroom({}, {segments},async(system,input)=>{assert.deepEqual(input.requestedSections,['summary','suggestions']);assert.equal(input.mode,'overview');return {sections:sections()};});
  assert.equal(result.sections.summary.length,1);assert.equal(result.sections.suggestions.length,1);for(const key of ['knowledge','emphasis','difficulties','observations'])assert.deepEqual(result.sections[key],[]);
});
test('教师指定细分分类和要求才生成细分内容，错误依据不提交',async()=>{
  const result=await analyzeClassroom({}, {segments},async(_,input)=>{assert.deepEqual(input.requestedSections,['observations']);assert.equal(input.request,'分析重复讲解');return {sections:sections()};},undefined,{}, {mode:'details',requestedSections:['observations'],request:'分析重复讲解'});
  assert.equal(result.sections.observations.length,1);assert.deepEqual(result.sections.summary,[]);assert.deepEqual(result.detailSections,['observations']);
  await assert.rejects(analyzeClassroom({}, {segments},async()=>({sections:sections(['missing'])})),/有效原文证据/);
});
test('模型输出冗长时带实际长度要求精简，条目数量仍须遵守总览结构',async()=>{
  let calls=0;const result=await analyzeClassroom({}, {segments},async(_,input)=>{calls++;const raw=sections();if(calls===1)raw.summary[0].text='冗长'.repeat(501);else assert.match(input.feedback,/分析过长/);return {sections:raw};});assert.equal(calls,2);assert.equal(result.sections.summary.length,1);
  const limited=await analyzeClassroom({}, {segments},async()=>{const raw=sections();raw.suggestions=Array(4).fill(raw.suggestions[0]);return {sections:raw};});assert.equal(limited.sections.suggestions.length,4);
});
test('改进建议不限三条、不按240字精简，完整保留模型给出的实际做法',async()=>{
  const suggestions=Array.from({length:7},(_,i)=>({text:`建议${i+1}：`+'说明课堂问题、调整理由和可实操的示例。'.repeat(20),kind:'ai-inference',evidenceIds:['a']}));let calls=0;
  const result=await analyzeClassroom({}, {segments},async(system)=>{calls++;assert.ok(!system.includes('最多3条'));assert.ok(!system.includes('最多240字'));return {sections:{summary:[{text:'整体课堂主线。',kind:'transcript',evidenceIds:['a']}],suggestions}};});
  assert.equal(calls,1);assert.deepEqual(result.sections.suggestions.map(i=>i.text),suggestions.map(i=>i.text));assert.ok(result.sections.suggestions.every(i=>i.text.length>240));
});
test('整课汇总及多条总结修复不删减改进建议，仍验证原文依据',async()=>{
  const suggestions=Array.from({length:6},(_,i)=>({text:`不同问题的建议${i+1}`,kind:'ai-inference',evidenceIds:['a']})),s=[{id:'a',start:0,end:10,text:'讲解'.repeat(4250)},{id:'b',start:20,end:30,text:'后续课堂'}];
  const result=await analyzeClassroom({}, {segments:s},async(_,input)=>({sections:{summary:input.partials?[{text:'整体主线。',kind:'transcript',evidenceIds:['a']},{text:'教学优点及主要调整。',kind:'transcript',evidenceIds:['b']}]:[{text:'分段主线。',kind:'transcript',evidenceIds:[input.segments[0].id]}],suggestions:input.partials?suggestions:[]}}));assert.equal(result.sections.summary.length,1);assert.deepEqual(result.sections.suggestions.map(i=>i.text),suggestions.map(i=>i.text));
  await assert.rejects(analyzeClassroom({}, {segments},async()=>({sections:{summary:[{text:'整体主线。',kind:'transcript',evidenceIds:['a']}],suggestions:[{text:'建议',kind:'ai-inference',evidenceIds:['missing']}]}})),/有效原文证据/);
});
test('模型把总结合成多个自然段条目时统一展示为一项，保留文字和全部有效证据',async()=>{
  let calls=0;const result=await analyzeClassroom({}, {segments},async(_,input)=>{if(calls++)assert.match(input.feedback,/合并为一个整体总结/);return {sections:{summary:[{text:'课堂主线。',kind:'transcript',evidenceIds:['a']},{text:'主要优点与调整。',kind:'transcript',evidenceIds:['b']}],suggestions:[]}};});assert.equal(calls,2);assert.equal(result.sections.summary.length,1);assert.equal(result.sections.summary[0].text,'课堂主线。\n\n主要优点与调整。');assert.deepEqual(result.sections.summary[0].evidenceIds,['a','b']);
});
test('完整整课汇总稍超篇幅不导致两段分析全部失败，仍保留一个完整总结与引用',async()=>{
  const long='完整课堂的主线、优点与调整方向。'.repeat(80),chunks=[{id:'a',start:0,end:10,text:'教学'.repeat(4250)},{id:'b',start:20,end:30,text:'后续教学'}];let calls=0;
  const result=await analyzeClassroom({}, {segments:chunks},async(_,input)=>{calls++;return {sections:{summary:[{text:input.partials?long:'本段教学主线',kind:'transcript',evidenceIds:input.partials?['a','b']:[input.segments[0].id]}],suggestions:[]}};});
  assert.equal(calls,4);assert.equal(result.sections.summary.length,1);assert.equal(result.sections.summary[0].text,long);assert.deepEqual(result.sections.summary[0].evidenceIds,['a','b']);assert.equal(result.coverage.length,2);
});
test('篇幅精简请求失败时保留已验证的完整候选，暂停仍阻止提交',async()=>{
  const text='完整内容'.repeat(260);let calls=0;
  const result=await analyzeClassroom({}, {segments},async()=>{if(calls++)throw Error('精简请求超时');return {sections:{summary:[{text,kind:'transcript',evidenceIds:['a']}],suggestions:[]}};});assert.equal(result.sections.summary[0].text,text);
  const controller=new AbortController();calls=0;await assert.rejects(analyzeClassroom({}, {segments},async()=>{if(calls++){controller.abort();throw Error('已暂停');}return {sections:{summary:[{text,kind:'transcript',evidenceIds:['a']}],suggestions:[]}};},undefined,{signal:controller.signal}),e=>e.statusCode===499);
});

test('整体总结允许充分展开仍只有一个条目，不把分段摘要拼到报告',async()=>{
  const text='课堂主线与结构。'.repeat(65),result=await analyzeClassroom({}, {segments},async()=>({sections:{summary:[{text,kind:'transcript',evidenceIds:['a']}],suggestions:[]}}));
  assert.equal(result.sections.summary.length,1);assert.equal(result.sections.summary[0].text,text);assert.ok(text.length>400);
});
test('跨分段间隔作为真实时间依据传入，汇总不追加逐段观察',async()=>{
  const s=[{id:'before',start:0,end:10,text:'讲解'.repeat(4200)},{id:'after',start:600,end:610,text:'后续'.repeat(200)}],inputs=[];
  await analyzeClassroom({}, {segments:s},async(_,input)=>{inputs.push(input);return {sections:{observations:[{text:'间隔估算',kind:'timing-estimate',timeEvidence:[{startId:input.segments?.[0].id==='after'?'before':input.segments?.[0].id||'before',endId:input.segments?.[0].id||'after',basis:input.segments?.[0].id==='after'?'segment-gap':'transcript-span'}],evidenceIds:input.segments?.[0].id==='after'?['before','after']:[input.segments?.[0].id||'before']}]}};},undefined,{}, {mode:'details',requestedSections:['observations']});
  assert.deepEqual(inputs[1].textObservations.gaps,[{start:10,end:600,evidenceIds:['before','after']}]);assert.equal(inputs[1].previousBoundarySegment.id,'before');
});
test('分段分析失败后从保存的分段继续，不再请求已完成片段',async()=>{
  const s=[{id:'a',start:0,end:10,text:'讲解'.repeat(4200)},{id:'b',start:20,end:30,text:'后续'.repeat(200)}];let checkpoint,firstCalls=0;
  const result=()=>({sections:{summary:[{text:'整体总结',kind:'transcript',evidenceIds:['a']}],suggestions:[]}});
  await assert.rejects(analyzeClassroom({}, {segments:s},async(_,input)=>{firstCalls++;if(input.segments[0].id==='b')throw Error('中断');return result();},async patch=>{if(patch.checkpoint)checkpoint=structuredClone(patch.checkpoint);}),/中断/);
  assert.equal(firstCalls,2);const seen=[];const final=await analyzeClassroom({}, {segments:s},async(_,input)=>{seen.push(input.segments?.[0].id||'summary');return result();},undefined,{}, {checkpoint});
  assert.deepEqual(seen,['b','summary']);assert.deepEqual(final.coverage.flatMap(p=>p.ids),['a','b']);
});
test('排除幻觉片段与空白校正保留原稿和时间，AI不读取被排除文字',async()=>{
  let s=state();s=applyClassroomCommand(s,{action:'correct',transcriptId:'t1',segments:[{id:'a',text:''},{id:'b',text:segments[1].text}]});
  assert.equal(s.transcriptVersions[0].segments[0].text,segments[0].text);const t=s.transcriptVersions.at(-1);assert.equal(t.segments[0].excluded,true);assert.equal(t.segments[0].start,1);
  await analyzeClassroom({},t,async(_,input)=>{assert.deepEqual(input.segments.map(s=>s.id),['b']);return {sections:{summary:[{text:'保留片段的总结',kind:'transcript',evidenceIds:['b']}],suggestions:[]}};});
});
test('报告删除和修改留修订版本，可以恢复并整体确认，过期输入不能确认',()=>{
  let s=state();const r=s.reports[0],item=r.sections.summary[0];s=applyClassroomCommand(s,{action:'reportItem',reportId:r.id,section:'summary',itemId:item.id,delete:true});assert.equal(s.reports[0].sections.summary.length,0);
  const h=s.reports[0].history[0];s=applyClassroomCommand(s,{action:'restoreReportRevision',reportId:r.id,historyId:h.id});assert.equal(s.reports[0].sections.summary[0].text,item.text);assert.equal(s.reports[0].history.length,2);
  s=applyClassroomCommand(s,{action:'confirmReport',reportId:r.id});assert.ok(Object.values(s.reports[0].sections).flat().every(item=>item.confirmed));
  s=applyClassroomCommand(s,{action:'course',course:{title:'新说明',description:''}});assert.throws(()=>applyClassroomCommand(s,{action:'confirmReport',reportId:r.id}),/重新分析/);
});
test('转写恢复保留所有版本，删除后的音频不会由历史恢复重新出现',()=>{
  let s=state();s.transcriptVersions[0].audio={id:'audio-1',name:'原录音',file:'audio.wav'};s=applyClassroomCommand(s,{action:'correct',transcriptId:'t1',segments:segments.map(x=>({id:x.id,text:x.text+'校正'}))});
  s=applyClassroomCommand(s,{action:'selectTranscript',transcriptId:'t1'});assert.equal(s.transcriptVersions.length,2);assert.equal(s.audio.id,'audio-1');
  s=applyClassroomCommand(s,{action:'deleteAudio'});s=applyClassroomCommand(s,{action:'selectTranscript',transcriptId:'t1'});assert.equal(s.audio,null);assert.equal(s.transcriptVersions[0].audio.deleted,true);
});
test('分析期间不能清空或切换版本，暂停后允许保留版本操作',()=>{
  const s=state();s.jobs=[{id:'job',type:'analysis',stage:'summarizing'}];for(const cmd of [{action:'clear'},{action:'selectTranscript',transcriptId:'t1'},{action:'selectReport',reportId:'r1'}])assert.throws(()=>applyClassroomCommand(s,cmd),e=>e.statusCode===409);
  s.jobs[0].stage='paused';assert.equal(applyClassroomCommand(s,{action:'selectTranscript',transcriptId:'t1'}).currentTranscriptId,'t1');
});
test('不能以存在的片段ID为无依据的学生掌握判断背书',()=>{
  for(const text of ['学生已经理解了所有内容。','全班听懂了本节课。','学生掌握得很好。'])assert.throws(()=>validateReportSections({summary:[{text,kind:'transcript',evidenceIds:['a']}],suggestions:[]},segments,['summary','suggestions']),/无法由转写支持/);
});
test('时间判断按真实起止计算，拒绝无效区间和连续发言推断，导出保留计算依据',()=>{
  const item={text:'两个识别片段之间有一段间隔。',kind:'timing-estimate',evidenceIds:['a'],timeEvidence:[{startId:'a',endId:'b',basis:'segment-gap',seconds:999}]};
  const sections=validateReportSections({observations:[item]},segments,['observations']);assert.equal(sections.observations[0].timeEvidence[0].seconds,4);assert.deepEqual(sections.observations[0].evidenceIds,['a','b']);
  const s=state();s.reports[0].sections.observations=sections.observations;assert.match(buildClassroomReport(s),/约4秒/);assert.match(buildClassroomReport(s),/不代表精确静音/);
  for(const change of [{timeEvidence:[]},{timeEvidence:[{startId:'b',endId:'a',basis:'segment-gap'}]},{timeEvidence:[{startId:'a',endId:'missing',basis:'transcript-span'}]},{text:'教师连续讲授400秒。'}])assert.throws(()=>validateReportSections({observations:[{...item,...change}]},segments,['observations']),e=>e.statusCode===502);
});
test('历史报告恢复也过滤已弃用的非音频指标',()=>{
  const s=state();s.reports[0].history=[{id:'old-history',sections:{summary:[{text:'抬头率很高',kind:'transcript',evidenceIds:['a']}],suggestions:[]}}];
  const clean=applyClassroomCommand(s,{action:'restoreReportRevision',reportId:'r1',historyId:'old-history'});assert.deepEqual(clean.reports[0].sections.summary,[]);
});
