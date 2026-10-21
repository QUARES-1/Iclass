import {scopedURL, scopeKey, lessonId} from './lesson-scope.js';
import {$,esc,api,notice,download,captureView} from './ui.js';
let boot,current,template,templateRevision,preview,job,recordOffset=0,recordTotal=0,busy=false,loadSequence=0,recordSequence=0,pollController,recordController,sourceController,jobLoad,searchTimer;
const dirty=new Set(),selectedSuggestions=new Set();
const recordDrafts=new Map();
const chatDrafts=new Map();
function saveChatDraft(){if(current){const value=$('feedback-request').value;value?chatDrafts.set(current.id,value):chatDrafts.delete(current.id);}}
function restoreChatDraft(){ $('feedback-request').value=chatDrafts.get(current.id)||'';}
let suggestionSelectionVersion=null;
let suggestionBaseVersion=0,suggestionDraft=[];
const types={single:'单选',multiple:'多选',rating:'评分',select:'下拉选择',text:'开放文本'};
const statuses={draft:'尚未发布',pending:'等待发布',publishing:'正在发布',published:'已发布',mapping:'已创建，字段映射待修复',uncertain:'创建结果待核实',failed:'发布失败'};
const uuid=()=>crypto.randomUUID();
const url=(suffix='')=>'/api/feedback/sessions/'+current.id+suffix;
$('new-date').value=new Date().toLocaleDateString('sv-SE');
function saved(){ $('save-status').textContent=dirty.size?'有未保存的编辑':'已保存';$('discard-report-edit').hidden=!dirty.has('report');$('discard-suggestion-edit').hidden=!dirty.has('suggestions');if(dirty.has('report'))$('report-status').textContent='报告有未保存的编辑，保存后需要重新确认。';}
async function run(fn){
  if(busy)return;busy=true;notice('');document.body.setAttribute('aria-busy','true');$('save-status').textContent='正在处理…';
  try{await fn();}catch(e){notice(e.message,true);}finally{busy=false;document.body.removeAttribute('aria-busy');saved();}
}
function mark(key){dirty.add(key);saved();}
function safeAction(fn){return ()=>void run(fn);}
function stopReads(){pollController?.abort();recordController?.abort();sourceController?.abort();jobLoad?.controller.abort();clearTimeout(searchTimer);}
async function refreshBoot(){
  boot=await api('/api/feedback/bootstrap');templateRevision=boot.templates.revision;
  $('class-list').innerHTML=boot.sessions.map(c=>'<button class="class-item" data-class="'+c.id+'" aria-current="'+(current?.id===c.id)+'">'+esc(c.title)+'<small>'+esc(c.date)+' · '+c.count+' 份反馈 · '+esc(statuses[c.publish]||c.publish)+'</small></button>').join('')||'<p class="muted">尚无课堂。</p>';
  document.querySelectorAll('[data-class]').forEach(b=>b.onclick=()=>void chooseClass(b.dataset.class));
  $('import-limits').textContent='UTF-8 JSON，最多 '+Math.round(boot.limits.fileBytes/1024/1024)+' MiB、'+boot.limits.records+' 条反馈，单条文本最多 '+boot.limits.text+' 字符。先预览再导入。';
}
async function chooseClass(classId){
  if(busy){notice('正在处理，请稍后再切换课堂。');return;}
  if(current?.id===classId)return;
  if(dirty.size){
    const leave=await new Promise(resolve=>{
      $('leave-dialog').showModal();
      $('stay-class').onclick=()=>{ $('leave-dialog').close();resolve(false);};
      $('discard-class').onclick=()=>{ $('leave-dialog').close();resolve(true);};
      $('leave-dialog').oncancel=e=>{e.preventDefault();$('leave-dialog').close();resolve(false);};
    });if(!leave)return;
  }
  saveChatDraft();stopReads();++loadSequence;dirty.clear();recordDrafts.clear();selectedSuggestions.clear();suggestionSelectionVersion=null;preview=null;recordOffset=0;job=null;$('record-search').value='';
  $('class-work').hidden=true;$('save-status').textContent='正在切换课堂…';await loadClass(classId,true);
}
async function loadClass(classId,full=false,signal){
  const sequence=++loadSequence;
  try{
    const c=await api('/api/feedback/sessions/'+classId,undefined,{signal});
    if(sequence!==loadSequence||current?.id===classId&&current.revision>c.revision)return;
    current=c;localStorage.setItem(scopeKey('feedback-current-class'),classId);if(full){job=null;renderJob();restoreChatDraft();preview=null;$('commit-import').disabled=true;$('import-preview').textContent='';const player=$('evidence-player');player.pause();player.onloadedmetadata=null;player.removeAttribute('src');delete player.dataset.source;delete player.dataset.end;player.hidden=true;$('evidence').hidden=true;}
    $('class-empty').hidden=true;$('class-work').hidden=false;
    renderClass(full);
    if(full){await refreshBoot();await loadSources();await loadRecords();}
  }catch(e){if(sequence===loadSequence&&e.name!=='AbortError')notice(e.message,true);}
}
function renderClass(full=false){
  const restore=captureView(),c=current;
  $('class-title').textContent=c.title;$('class-source').textContent=(c.resourceError?c.resourceError+' · ':'')+(c.sample?'本地示例 · ':'')+(c.source?'已关联课堂转写':'未关联音频')+(c.ppt?' · PPT：'+c.ppt.name:' · PPT 背景可选')+(c.source?.needsRefresh||c.ppt?.needsRefresh?' · 来源已变化，请在课堂信息中重新核对并关联，历史依据保留。':'');
  if(full||!dirty.has('course')){
    $('course-title').value=c.title;$('course-date').value=c.date;$('course-description').value=c.description;
    $('course-template').innerHTML=boot.templates.versions.map(v=>'<option value="'+v.id+'">'+esc(v.title)+' · '+new Date(v.createdAt).toLocaleString()+'</option>').join('');
    $('course-template').value=c.template.id;$('course-template').disabled=c.ended||c.stats.total>0;
    $('course-deadline').value=c.deadline?new Date(Date.parse(c.deadline)-new Date(c.deadline).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  }
  if(full){template=structuredClone(c.template);renderTemplate();}
  const p=c.publish,deadline=c.deadline&&Date.now()>=Date.parse(c.deadline);
  $('publish-status').textContent=(statuses[p.status]||p.status)+(deadline?' · 本轮统计已截止，远端填写状态请在金数据核对':'')+(p.error?'：'+p.error:'');
  $('end-course').disabled=c.ended;$('end-course').textContent=c.ended?'课程已结束':'课程结束';
  $('retry-publish').hidden=!['pending','failed'].includes(p.status);$('repair-mapping').hidden=p.status!=='mapping';
  $('bind-panel').hidden=!['uncertain','mapping'].includes(p.status);
  $('sync-feedback').disabled=p.status!=='published'||c.sync?.status==='syncing';
  $('share').hidden=p.status!=='published';
  if(p.status==='published'){
    $('survey-url').href=p.url;
    const qr=scopedURL('/api/feedback/sessions/'+c.id+'/qr');
    if($('survey-qr').dataset.token!==p.token){$('survey-qr').src=qr;$('download-qr').href=qr;$('survey-qr').dataset.token=p.token;}
  }
  $('sync-status').textContent=c.sync?.status==='syncing'?'正在获取全部反馈，原统计保留…':(c.sync?.error||'')+(c.sync?.updatedAt?' · 上次同步 '+new Date(c.sync.updatedAt).toLocaleString():'');
  renderStatistics();
  $('feedback-messages').innerHTML=c.messages.map(m=>'<div class="feedback-message '+m.role+'"><strong>'+esc(m.role==='user'?'教师':'智能体')+'</strong><div>'+esc(m.text)+'</div></div>').join('');
  $('task-history').hidden=!(c.jobIds?.length>1);$('feedback-job-select').innerHTML=(c.jobIds||[]).slice().reverse().map((id,i)=>'<option value="'+id+'">'+esc(c.messages.find(m=>m.role==='user'&&m.jobId===id)?.text.slice(0,60)||'历史任务 '+(c.jobIds.length-i))+'</option>').join('');if(job)$('feedback-job-select').value=job.id;
  $('report-select').innerHTML='<option value="">请选择报告</option>'+c.reports.slice().reverse().map(r=>'<option value="'+r.id+'">'+new Date(r.createdAt).toLocaleString()+(r.stale?' · 待更新':r.confirmed?' · 已确认':' · 草稿')+'</option>').join('');
  const report=c.reports.find(r=>r.id===(dirty.has('report')?$('report-text').dataset.report:c.currentReportId));
  $('report-select').value=report?.id||'';
  if(!dirty.has('report')){$('report-text').value=report?.text||'';$('report-text').dataset.version=report?.version||'';$('report-text').dataset.report=report?.id||'';}
  $('report-status').textContent=report?(report.stale?'依据已变化，保留历史草稿，请更新后再确认。':report.confirmed?'教师已确认':'报告待教师确认'):'可先讨论，也可生成整体复盘。';
  if(dirty.has('report')&&report?.id!==c.currentReportId)$('report-status').textContent+=' 新候选已另存，当前编辑保留，保存后可切换查看。';
  $('report-text').disabled=!report;$('discard-report-edit').hidden=!dirty.has('report');$('discard-suggestion-edit').hidden=!dirty.has('suggestions');
  for(const id of ['save-report','confirm-report','export-report','show-evidence'])$(id).disabled=!report;
  $('confirm-report').disabled=!report||report.stale;
  $('report-history').innerHTML=(report?.history||[]).slice().reverse().map(h=>'<button data-restore-report="'+h.version+'">恢复修订 '+h.version+'</button>').join('')||'<p class="muted">尚无人工修订。</p>';
  document.querySelectorAll('[data-restore-report]').forEach(b=>b.onclick=safeAction(async()=>{if(dirty.has('report'))throw new Error('请先保存当前报告修订。');await command('restoreReport',{reportId:report.id,version:Number(b.dataset.restoreReport)});}));
  if(!dirty.has('suggestions'))renderSuggestions();
  $('suggestion-history').innerHTML=(c.suggestionHistory||[]).slice().reverse().map(h=>'<button data-restore-suggestions="'+h.version+'">恢复建议修订 '+h.version+'</button>').join('')||'<p class="muted">尚无历史。</p>';
  document.querySelectorAll('[data-restore-suggestions]').forEach(b=>b.onclick=safeAction(async()=>{if(dirty.has('suggestions'))throw new Error('请先保存当前建议修订。');await command('restoreSuggestions',{version:Number(b.dataset.restoreSuggestions)});}));
  const listed=boot.sessions.find(s=>s.id===c.id);if(listed){listed.count=c.stats.total;listed.title=c.title;listed.publish=c.publish.status;const row=document.querySelector('[data-class="'+c.id+'"]');if(row)row.querySelector('small').textContent=c.date+' · '+c.stats.total+' 份反馈 · '+(statuses[c.publish.status]||c.publish.status);}

  if(c.activeJobId&&(!job||job.status==='completed'&&job.id!==c.activeJobId))void loadJob(c.id,c.activeJobId);
  saved();restore();
}
function answerLines(template,answers){
  return Object.entries(answers).map(([key,value])=>{
    const q=template.questions.find(q=>q.id===key),label=q?.label||key;
    const display=v=>q?.options?.find(o=>o.id===v)?.label??v;
    return label+'：'+(Array.isArray(value)?value.map(display).join('、'):display(value));
  }).join('\n');
}
function renderStatistics(){
  const s=current.stats;
  $('statistics').innerHTML='<p><strong>'+s.total+' 份反馈</strong> · 排除 '+s.excluded+' · 晚到 '+s.late+' · 时间待核对 '+s.unknownTime+' · 含无效项 '+s.invalid+'</p>'+
    (s.missingDimensions?.length?'<p class="muted">未设置问题：'+esc(s.missingDimensions.join('、'))+'</p>':'')+(s.total?'<details><summary>查看各题统计图表</summary>'+s.questions.map(q=>'<div class="stat-question"><strong>'+esc(q.label)+'</strong><small> · 有效回答 '+q.n+'</small>'+
      (q.options?q.options.map(o=>'<div>'+esc(o.label)+'：'+o.count+'（'+(o.percent??'—')+'%）<div class="stat-bar"><span style="width:'+(o.percent||0)+'%"></span></div></div>').join(''):'')+
      (q.type==='rating'?'<p>均分 '+(q.mean===null?'—':q.mean.toFixed(2))+' · '+q.distribution.map(x=>x.score+'分 '+x.count+'份').join(' / ')+'</p>':'')+
      (q.comments?'<p>'+q.comments.length+' 条意见，可展开原始反馈查看。</p>':'')+'</div>').join('')+'</details>':'<p class="muted">暂无反馈。可以先关联音频并进行复盘。</p>');
}
function renderSuggestions(){
  suggestionBaseVersion=current.suggestionVersion||0;suggestionDraft=structuredClone(current.suggestions);
  if(suggestionSelectionVersion!==current.suggestionVersion){selectedSuggestions.clear();current.suggestions.forEach(s=>selectedSuggestions.add(s.id));suggestionSelectionVersion=current.suggestionVersion;}

  $('ppt-suggestions').innerHTML=current.suggestions.map((s,i)=>'<div class="suggestion-row"><label><input type="checkbox" class="inline-input" data-suggestion-select="'+s.id+'" '+(selectedSuggestions.has(s.id)?'checked':'')+'>建议 '+(i+1)+'</label><textarea data-suggestion-text="'+s.id+'" rows="3">'+esc(s.text)+'</textarea></div>').join('')||'<p class="muted">生成复盘后会给出建议，也可单独提出下一课改进要求。</p>';
  document.querySelectorAll('[data-suggestion-select]').forEach(el=>el.onchange=()=>{el.checked?selectedSuggestions.add(el.dataset.suggestionSelect):selectedSuggestions.delete(el.dataset.suggestionSelect);});
  document.querySelectorAll('[data-suggestion-text]').forEach(el=>el.oninput=()=>mark('suggestions'));
}
function collectTemplate(){
  template.title=$('template-title').value;template.description=$('template-description').value;
  return structuredClone(template);
}
function renderTemplate(){
  $('template-title').value=template.title;$('template-description').value=template.description;
  $('questions').innerHTML=template.questions.map((q,i)=>'<article class="question-editor" data-question="'+q.id+'"><div class="question-head"><strong>第 '+(i+1)+' 题</strong><select data-q-type="'+q.id+'">'+Object.entries(types).map(([type,label])=>'<option value="'+type+'" '+(type===q.type?'selected':'')+'>'+label+'</option>').join('')+'</select><button data-q-move="'+q.id+'" data-direction="-1">上移</button><button data-q-move="'+q.id+'" data-direction="1">下移</button><button data-q-copy="'+q.id+'">复制</button><button data-q-delete="'+q.id+'" class="danger">删除</button></div><label>题目<input data-q-label="'+q.id+'" value="'+esc(q.label)+'" maxlength="1000"></label><label>说明<input data-q-notes="'+q.id+'" value="'+esc(q.notes||'')+'" maxlength="2000"></label><label><input type="checkbox" class="inline-input" data-q-required="'+q.id+'" '+(q.required?'checked':'')+'>必填</label>'+
    (q.type==='rating'?'<label>评分上限<select data-q-max="'+q.id+'">'+[3,5,10].map(v=>'<option '+(q.max===v?'selected':'')+'>'+v+'</option>').join('')+'</select></label>':'')+
    (['single','multiple','select'].includes(q.type)?(q.options||[]).map((o,j)=>'<div class="question-option"><input aria-label="选项 '+(j+1)+'" data-option="'+q.id+':'+o.id+'" value="'+esc(o.label)+'" maxlength="1000"><button data-o-move="'+q.id+':'+o.id+'" data-direction="-1" aria-label="上移选项">↑</button><button data-o-move="'+q.id+':'+o.id+'" data-direction="1" aria-label="下移选项">↓</button><button data-o-delete="'+q.id+':'+o.id+'" aria-label="删除选项">删除</button></div>').join('')+'<button data-o-add="'+q.id+'">增加选项</button>':'')+'</article>').join('');
  const q=id=>template.questions.find(q=>q.id===id);
  $('add-question').disabled=template.questions.length>=boot.limits.questions;
  document.querySelectorAll('[data-q-copy]').forEach(el=>el.disabled=template.questions.length>=boot.limits.questions);
  document.querySelectorAll('[data-o-add]').forEach(el=>el.disabled=q(el.dataset.oAdd).options.length>=boot.limits.options);
  const bind=(selector,event,fn)=>document.querySelectorAll(selector).forEach(el=>el[event]=()=>{fn(el);mark('template');});
  bind('[data-q-label]','oninput',el=>q(el.dataset.qLabel).label=el.value);
  bind('[data-q-notes]','oninput',el=>q(el.dataset.qNotes).notes=el.value);
  bind('[data-q-required]','onchange',el=>q(el.dataset.qRequired).required=el.checked);
  bind('[data-q-max]','onchange',el=>q(el.dataset.qMax).max=Number(el.value));
  bind('[data-option]','oninput',el=>{const [qid,oid]=el.dataset.option.split(':');q(qid).options.find(o=>o.id===oid).label=el.value;});
  bind('[data-q-type]','onchange',el=>{const item=q(el.dataset.qType);item.type=el.value;if(['single','multiple','select'].includes(item.type)&&!item.options)item.options=[{id:uuid(),label:'选项一'},{id:uuid(),label:'选项二'}];if(item.type==='rating')item.max=5;renderTemplate();});
  bind('[data-q-delete]','onclick',el=>{collectTemplate();template.questions=template.questions.filter(x=>x.id!==el.dataset.qDelete);renderTemplate();});
  bind('[data-q-copy]','onclick',el=>{if(!canAddQuestion())return;collectTemplate();const copy=structuredClone(q(el.dataset.qCopy));copy.id=uuid();copy.options?.forEach(o=>o.id=uuid());template.questions.push(copy);renderTemplate();});
  bind('[data-q-move]','onclick',el=>{collectTemplate();const i=template.questions.findIndex(x=>x.id===el.dataset.qMove),j=i+Number(el.dataset.direction);if(j>=0&&j<template.questions.length)[template.questions[i],template.questions[j]]=[template.questions[j],template.questions[i]];renderTemplate();});
  bind('[data-o-add]','onclick',el=>{if(q(el.dataset.oAdd).options.length>=boot.limits.options){notice('每题最多 '+boot.limits.options+' 个选项。',true);return;}collectTemplate();q(el.dataset.oAdd).options.push({id:uuid(),label:'新选项'});renderTemplate();});
  bind('[data-o-delete]','onclick',el=>{collectTemplate();const [qid,oid]=el.dataset.oDelete.split(':');q(qid).options=q(qid).options.filter(o=>o.id!==oid);renderTemplate();});
  bind('[data-o-move]','onclick',el=>{collectTemplate();const [qid,oid]=el.dataset.oMove.split(':'),options=q(qid).options,i=options.findIndex(o=>o.id===oid),j=i+Number(el.dataset.direction);if(j>=0&&j<options.length)[options[i],options[j]]=[options[j],options[i]];renderTemplate();});
}
async function command(action,body={}){
  const classId=current.id,result=await api(url(),{revision:current.revision,action,...body});
  if(current?.id===classId){if(result.revision>=current.revision)current=result;renderClass();}return result;
}
async function loadSources(){
  const classId=current.id;
  sourceController?.abort();const controller=new AbortController();sourceController=controller;
  const results=await Promise.allSettled([api('/api/classroom',undefined,{signal:controller.signal}),api('/api/workspace',undefined,{signal:controller.signal})]);
  if(sourceController===controller)sourceController=null;
  if(current?.id!==classId||controller.signal.aborted)return;
  if(results[0].status==='fulfilled')$('audio-source').innerHTML='<option value="">请选择</option>'+results[0].value.transcriptVersions.slice().reverse().map(t=>'<option value="'+t.id+'">'+esc(t.audio?.name||t.source)+' · '+new Date(t.createdAt).toLocaleString()+'</option>').join('');
  if(results[1].status==='fulfilled')$('ppt-source').innerHTML='<option value="">不关联</option>'+results[1].value.resources.filter(r=>r.type==='ppt').map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join('');
}
async function loadRecords(){
  if(!current)return;const classId=current.id,sequence=++recordSequence;
  recordController?.abort();const controller=new AbortController();recordController=controller;let response;
  try{response=await api(url('/records')+'?offset='+recordOffset+'&q='+encodeURIComponent($('record-search').value),undefined,{signal:controller.signal});}catch(e){if(e.name==='AbortError')return;throw e;}
  finally{if(recordController===controller)recordController=null;}
  if(current?.id!==classId||sequence!==recordSequence)return;
  recordTotal=response.total;
  $('feedback-records').innerHTML=response.records.map(original=>{const r={...original,...recordDrafts.get(original.id)};return '<article class="feedback-record '+(r.errors.length?'invalid':'')+'"><strong>'+esc(r.id)+(r.source==='sample'?' · 示例':'')+'</strong><p>'+esc(r.submittedAt||'未提供提交时间')+(r.late?' · 晚到':'')+(r.unknownTime?' · 时间待核对':'')+'</p><pre>'+esc(answerLines(response.template,r.answers))+'</pre>'+(r.errors.length?'<p>'+esc(r.errors.join('；'))+'</p>':'')+'<label><input class="inline-input" type="checkbox" data-exclude="'+r.id+'" '+(r.excluded?'checked':'')+'>排除此反馈</label><input aria-label="排除原因" data-reason="'+r.id+'" maxlength="1000" value="'+esc(r.reason||'')+'" placeholder="排除原因（可选）"><button data-save-exclude="'+r.id+'">保存排除状态</button></article>';}).join('')||'<p class="muted">没有匹配的反馈。</p>';
  $('records-page').textContent=recordTotal?(recordOffset+1)+'～'+Math.min(recordOffset+50,recordTotal)+' / '+recordTotal:'0 条';
  $('records-prev').disabled=!recordOffset;$('records-next').disabled=recordOffset+50>=recordTotal;
  const draft=recordId=>({excluded:document.querySelector('[data-exclude="'+recordId+'"]').checked,reason:document.querySelector('[data-reason="'+recordId+'"]').value});
  document.querySelectorAll('[data-exclude],[data-reason]').forEach(el=>el.oninput=()=>{const recordId=el.dataset.exclude||el.dataset.reason;recordDrafts.set(recordId,draft(recordId));mark('records');});
  document.querySelectorAll('[data-save-exclude]').forEach(b=>b.onclick=safeAction(async()=>{const recordId=b.dataset.saveExclude,submitted=draft(recordId);await command('exclude',{recordId,...submitted});if(JSON.stringify(recordDrafts.get(recordId))===JSON.stringify(submitted))recordDrafts.delete(recordId);if(!recordDrafts.size)dirty.delete('records');await loadRecords();}));
}
async function send(request){
  const classId=current.id;
  const response=await api(url('/chat'),{revision:current.revision,request});
  if(current?.id!==classId)return;
  job=response;await loadClass(classId);renderJob();
}
function renderJob(){
  $('feedback-job').hidden=!job;if(!job)return;
  $('job-detail').textContent=job.detail+(job.error?'：'+job.error:'');
  $('job-progress').max=job.progress?.total||1;$('job-progress').value=job.progress?.completed||0;
  $('pause-job').hidden=job.status!=='running';$('resume-job').hidden=!['paused','failed'].includes(job.status);$('cancel-job').hidden=['cancelled','completed'].includes(job.status);
  $('job-plan').innerHTML=(job.plan||[]).map((s,i)=>'<p>'+esc((i+1)+'. '+s.title)+'</p>').join('')+(job.observations||[]).map(o=>'<p class="muted">'+esc(o)+'</p>').join('');
}
async function loadJob(classId,jobId,signal){
  if(jobLoad?.classId===classId&&jobLoad.jobId===jobId&&!jobLoad.controller.signal.aborted)return jobLoad.promise;
  jobLoad?.controller.abort();const controller=new AbortController(),pending={classId,jobId,controller};jobLoad=pending;
  const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,15000);
  pending.promise=(async()=>{
    try{const result=await api('/api/feedback/sessions/'+classId+'/job?id='+jobId,undefined,{signal:controller.signal});if(current?.id===classId){job=result;renderJob();}}
    catch(e){if(e.name!=='AbortError'&&current?.id===classId)notice(e.message,true);}
    finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);if(jobLoad===pending)jobLoad=null;}
  })();return pending.promise;
}
async function saveReport(){
  const reportId=$('report-text').dataset.report;if(!reportId)throw new Error('请先选择报告。');
  const submitted=$('report-text').value;
  const result=await api(url(),{revision:current.revision,action:'report',reportId,baseVersion:Number($('report-text').dataset.version),text:submitted});
  if($('report-text').value===submitted)dirty.delete('report');
  if(result.revision>=current.revision)current=result;renderClass();if(dirty.has('report')){$('report-text').dataset.version=result.reports.find(r=>r.id===reportId).version;}
}
async function saveSuggestions(){
  const submitted=[...document.querySelectorAll('[data-suggestion-text]')].map(el=>({...suggestionDraft.find(s=>s.id===el.dataset.suggestionText),text:el.value}));
  const result=await command('suggestions',{suggestions:submitted,baseSuggestionVersion:suggestionBaseVersion});suggestionBaseVersion=result.suggestionVersion;if([...document.querySelectorAll('[data-suggestion-text]')].every((el,i)=>el.value===submitted[i]?.text)){dirty.delete('suggestions');renderSuggestions();}
}
function courseInput(){return {title:$('course-title').value,date:$('course-date').value,description:$('course-description').value,templateId:$('course-template').value,deadline:$('course-deadline').value?new Date($('course-deadline').value).toISOString():null};}
function canAddQuestion(){if(template.questions.length<boot.limits.questions)return true;notice('模板最多 '+boot.limits.questions+' 道题。',true);return false;}
$('new-class').onsubmit=e=>{e.preventDefault();void run(async()=>{
  if(dirty.size)throw new Error('请先保存当前编辑再新建课堂。');
  const input={title:$('new-title').value,date:$('new-date').value};saveChatDraft();stopReads();++loadSequence;$('class-work').inert=true;
  try{
    const created=await api('/api/feedback/sessions',input);saveChatDraft();current=created;recordDrafts.clear();selectedSuggestions.clear();suggestionSelectionVersion=null;preview=null;recordOffset=0;$('record-search').value='';await refreshBoot();await loadClass(created.id,true);
    if($('new-title').value===input.title)$('new-title').value='';
  }finally{$('class-work').inert=false;}
});};
$('course-form').oninput=()=>mark('course');
$('course-form').onsubmit=e=>{e.preventDefault();void run(async()=>{const input=courseInput();await command('update',input);if(JSON.stringify(courseInput())===JSON.stringify(input))dirty.delete('course');await refreshBoot();renderClass();});};
$('template-title').oninput=$('template-description').oninput=()=>mark('template');
$('add-question').onclick=()=>{if(!canAddQuestion())return;collectTemplate();const type=$('add-question-type').value;template.questions.push({id:uuid(),label:'新问题',notes:'',type,required:false,max:5,...(['single','multiple','select'].includes(type)?{options:[{id:uuid(),label:'选项一'},{id:uuid(),label:'选项二'}]}:{})});mark('template');renderTemplate();};
$('restore-template').onclick=safeAction(async()=>{template=await api('/api/feedback/default-template');mark('template');renderTemplate();notice('默认模板已载入为草稿，保存后生效；原问卷不变。');});
$('preview-template').onclick=()=>{const t=collectTemplate();$('template-preview').hidden=false;$('template-preview').innerHTML='<h3>'+esc(t.title)+'</h3><p>'+esc(t.description)+'</p>'+t.questions.map((q,i)=>'<p><strong>'+(i+1)+'. '+esc(q.label)+(q.required?' *':'')+'</strong> · '+types[q.type]+'</p><p>'+esc(q.options?.map(o=>o.label).join(' / ')||(q.type==='rating'?'1～'+q.max:'开放文本'))+'</p>').join('');};
$('save-template').onclick=safeAction(async()=>{const submitted=collectTemplate(),result=await api('/api/feedback/templates',{revision:templateRevision,template:submitted});templateRevision=result.revision;const unchanged=JSON.stringify(collectTemplate())===JSON.stringify(submitted);if(unchanged){template=structuredClone(result.versions.at(-1));dirty.delete('template');}await refreshBoot();if(!current.ended&&!current.stats.total)await command('update',{templateId:result.versions.at(-1).id});if(unchanged)renderTemplate();notice(current.ended?'模板已保存，供后续课堂使用；当前已发布问卷不变。':'模板已保存并选用于当前课堂。');});
$('reload-feedback').onclick=safeAction(async()=>{await refreshBoot();await loadClass(current.id);notice('已更新保存状态，未保存编辑保留。');});
$('end-course').onclick=safeAction(async()=>{if(dirty.has('course'))throw new Error('请先保存课堂信息。');await command('end');notice(dirty.has('template')?'已按保存版本启动发布，未保存模板编辑仍保留。':'已记录课程结束，问卷立即开始发布。');});
$('retry-publish').onclick=safeAction(()=>command('publish'));
$('repair-mapping').onclick=safeAction(()=>command('repair'));
$('sync-feedback').onclick=safeAction(()=>command('sync'));
$('bind-form').onclick=safeAction(()=>command('bind',{token:$('bind-token').value.trim()}));
$('copy-survey-url').onclick=safeAction(async()=>{await navigator.clipboard.writeText(current.publish.url);notice('填写链接已复制。');});
$('link-audio').onclick=safeAction(()=>command('linkAudio',{transcriptId:$('audio-source').value}));
$('unlink-audio').onclick=safeAction(()=>command('unlinkAudio'));
$('link-ppt').onclick=safeAction(()=>command('linkPpt',{resourceId:$('ppt-source').value}));
$('unlink-ppt').onclick=safeAction(()=>command('unlinkPpt'));
$('delete-class').onclick=safeAction(async()=>{if(!confirm('删除本地课堂、反馈和复盘？远端问卷与原录音、课件保留。'))return;const classId=current.id;await command('delete');stopReads();++loadSequence;chatDrafts.delete(classId);current=null;job=null;dirty.clear();$('feedback-request').value='';$('evidence-player').pause();$('evidence-player').onloadedmetadata=null;$('class-work').hidden=true;$('class-empty').hidden=false;await refreshBoot();});
$('load-feedback-samples').onclick=safeAction(async()=>{await api('/api/feedback/samples',{});await refreshBoot();notice('样例课堂已准备好，重复载入不会复制课堂。');});
$('record-search').oninput=()=>{recordOffset=0;clearTimeout(searchTimer);recordController?.abort();searchTimer=setTimeout(()=>void loadRecords().catch(e=>notice(e.message,true)),180);};
$('records-prev').onclick=safeAction(async()=>{recordOffset=Math.max(0,recordOffset-50);await loadRecords();});
$('records-next').onclick=safeAction(async()=>{if(recordOffset+50<recordTotal)recordOffset+=50;await loadRecords();});
$('download-import-template').onclick=()=>download('feedback-import-template.json',JSON.stringify({classId:current.id,template:current.publish.template||current.template,records:[],说明:'records 每项为 {id,source,submittedAt,answers}，answers 使用下方模板的题目标识，选择题填写选项标识。'},null,2),'application/json');
$('feedback-file').onchange=()=>void run(async()=>{
  const file=$('feedback-file').files[0];if(!file)return;
  preview=null;$('commit-import').disabled=true;$('import-preview').textContent='正在预览…';
  try{if(!/\.json$/i.test(file.name))throw new Error('请选择 .json 文件。');if(!file.size)throw new Error('文件为空。');if(file.size>boot.limits.fileBytes)throw new Error('文件超过允许大小。');let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('文件须为 UTF-8 编码。');}let data;try{data=JSON.parse(content);}catch{throw new Error('JSON 格式无效，请检查文件。');}
    preview=await api(url('/preview'),{data});$('import-preview').innerHTML='<p>总计 '+preview.total+'，有效 '+preview.valid+'，新增 '+preview.added+'，更新 '+preview.updated+'，重复 '+preview.skipped+'。</p>'+preview.errors.map(e=>'<p class="danger">第 '+e.row+' 条：'+esc(e.error)+'</p>').join('');$('commit-import').disabled=!preview.valid;
  }catch(e){$('import-preview').textContent='预览未完成，请重新选择文件。';throw e;}finally{$('feedback-file').value='';}
});
$('commit-import').onclick=safeAction(async()=>{if(!preview)return;current=await api(url('/import'),{revision:current.revision,previewId:preview.id,validOnly:$('import-valid-only').checked});preview=null;$('commit-import').disabled=true;renderClass();await loadRecords();notice('导入完成；统计已更新。');});
$('feedback-request').oninput=saveChatDraft;
$('feedback-chat').onsubmit=e=>{e.preventDefault();void run(async()=>{const request=$('feedback-request').value;if(!request.trim())return;await send(request);if($('feedback-request').value===request)$('feedback-request').value='';saveChatDraft();});};
$('analyze-feedback').onclick=safeAction(()=>send('请结合本课堂已有问卷与音频资料，生成一份完整的整体复盘和改进建议。'));
$('make-ppt-suggestions').onclick=safeAction(()=>send('请结合已有资料与报告，只给出并保存下一节课PPT的具体改进建议，不修改PPT。'));
$('clear-feedback-context').onclick=safeAction(async()=>{if(!confirm('清空本课堂讨论记录？报告和其他成果保留。'))return;await command('clearConversation');});
for(const [button,action]of [['pause-job','pause'],['resume-job','resume'],['cancel-job','cancel']])$(button).onclick=safeAction(async()=>{job=await api(url('/job'),{id:job.id,action});renderJob();});
$('view-feedback-job').onclick=safeAction(()=>loadJob(current.id,$('feedback-job-select').value));
$('report-text').oninput=()=>mark('report');
$('report-select').onchange=()=>void run(async()=>{if(dirty.has('report')){ $('report-select').value=current.currentReportId;throw new Error('请先保存当前报告修订。');}await command('selectReport',{reportId:$('report-select').value});});
$('save-report').onclick=safeAction(saveReport);
$('discard-report-edit').onclick=safeAction(async()=>{if(!confirm('放弃未保存的报告编辑，载入已保存版本？'))return;dirty.delete('report');renderClass();});
$('discard-suggestion-edit').onclick=safeAction(async()=>{if(!confirm('放弃未保存的建议编辑，载入已保存版本？'))return;dirty.delete('suggestions');renderClass();});
$('confirm-report').onclick=safeAction(async()=>{if(dirty.has('report'))await saveReport();if(dirty.has('report'))throw new Error('保存等待期间报告已继续修改，请保存后重新确认。');const r=current.reports.find(r=>r.id===current.currentReportId);await command('report',{reportId:r.id,baseVersion:r.version,confirm:true});});
$('export-report').onclick=safeAction(async()=>{
  if(dirty.has('report'))await saveReport();const classId=current.id,r=current.reports.find(r=>r.id===current.currentReportId),text=$('report-text').value;
  const response=await fetch(scopedURL(url('/report')+'?id='+r.id+'&version='+r.version));if(!response.ok){const e=await response.json();throw new Error(e.error);}
  const content=await response.text();if(current.id!==classId||$('report-text').value!==text||dirty.has('report'))throw new Error('导出等待期间内容已变化，请保存后重新导出。');
  download('课堂复盘.md',content,'text/markdown;charset=utf-8');
});
$('save-suggestions').onclick=safeAction(saveSuggestions);
$('handoff-suggestions').onclick=safeAction(async()=>{const selection=()=>[...document.querySelectorAll('[data-suggestion-select]:checked')].map(e=>e.dataset.suggestionSelect),ids=selection();if(!ids.length)throw new Error('请至少选择一条建议。');if(dirty.has('suggestions'))await saveSuggestions();if(dirty.has('suggestions')||JSON.stringify(selection())!==JSON.stringify(ids))throw new Error('等待期间建议或选择已变化，请核对并保存后重新携带。');const h=await api(url('/handoff'),{revision:current.revision,ids});if(dirty.size||$('feedback-request').value.trim()||JSON.stringify(selection())!==JSON.stringify(ids))throw new Error('当前有未保存的编辑或未发送的讨论，请处理后重新携带建议。');const destination=$('handoff-lesson')?.value;if(destination&&destination!==lessonId)location.href='/public/index.html?lesson='+encodeURIComponent(destination)+'&feedback='+encodeURIComponent(h.id)+'&sourceLesson='+encodeURIComponent(lessonId);else location.href=scopedURL(h.url);});
$('show-evidence').onclick=safeAction(async()=>{
  const r=current.reports.find(r=>r.id===$('report-text').dataset.report),e=await api(url('/evidence')+'?reportId='+r.id);
  $('evidence').hidden=false;$('evidence').innerHTML='<h3>报告当时的原始依据</h3>'+
    '<p>反馈 '+e.records.length+' 份，转写 '+e.segments.length+' 段。</p>'+
    e.findings.map(f=>'<p><strong>'+esc(f.text)+'</strong><br>'+esc(f.evidenceIds.map(ref=>ref.startsWith('feedback:')?'学生反馈原文':ref.startsWith('stat:')?'问卷统计':ref.startsWith('segment:')?'课堂转写片段':ref.startsWith('page:')?'课件原文':ref.startsWith('resource:')?'本课次教学资源':'教师课堂说明').join('、'))+'</p>').join('')+
    '<details><summary>教学资源原文与说明</summary>'+(e.teachingResources||[]).map(r=>'<p><strong>'+esc(r.title)+'</strong> · '+esc(r.origin)+'</p><pre style="white-space:pre-wrap">'+esc(r.content)+'</pre>').join('')+'</details>'+
    '<details><summary>反馈原文</summary>'+e.records.map(r=>'<p>'+esc(r.id)+'：'+esc(answerLines(e.template,r.answers))+'</p>').join('')+'</details>'+
    '<details><summary>转写与回听</summary>'+e.segments.map(s=>'<p><button data-play-segment="'+s.start+'" data-end="'+s.end+'">'+Math.floor(s.start/60)+':'+String(Math.floor(s.start%60)).padStart(2,'0')+'</button> '+esc(s.text)+'</p>').join('')+'</details>';
  document.querySelectorAll('[data-play-segment]').forEach(b=>b.onclick=()=>{
    const player=$('evidence-player');player.hidden=false;const src=scopedURL(url('/audio')+'?reportId='+r.id);
    const play=()=>{player.currentTime=Number(b.dataset.playSegment);player.dataset.end=b.dataset.end;void player.play().catch(err=>notice(err.message,true));};
    if(player.dataset.source!==src){player.onloadedmetadata=null;player.src=src;player.dataset.source=src;}
    if(player.readyState>=1)play();else player.onloadedmetadata=()=>{player.onloadedmetadata=null;play();};
  });
});
$('evidence-player').ontimeupdate=()=>{const p=$('evidence-player');if(p.dataset.end&&p.currentTime>=Number(p.dataset.end)){p.pause();delete p.dataset.end;}};
$('evidence-player').onerror=()=>{$('evidence-player').onloadedmetadata=null;delete $('evidence-player').dataset.source;notice('原音频可能已删除，转写依据仍可查看。',true);};
window.addEventListener('beforeunload',e=>{if(dirty.size||$('feedback-request').value.trim()){e.preventDefault();e.returnValue='';}});
setInterval(()=>{
  if(!current||document.hidden||busy||pollController)return;const classId=current.id;
  if(!['pending','publishing','mapping'].includes(current.publish.status)&&current.sync?.status!=='syncing'&&job?.status!=='running')return;
  const controller=new AbortController();pollController=controller;const timeout=setTimeout(()=>controller.abort(),15000);
  void loadClass(classId,false,controller.signal).then(()=>{if(current?.id===classId&&job?.status==='running'&&!controller.signal.aborted)return loadJob(classId,job.id,controller.signal);}).catch(()=>{}).finally(()=>{clearTimeout(timeout);if(pollController===controller)pollController=null;});
},1800);
setInterval(()=>{if(current&&!document.hidden&&!busy&&current.publish.status==='published'&&(!current.deadline||Date.parse(current.deadline)>Date.now())&&current.sync?.status!=='syncing')void run(()=>command('sync'));},60000);
try{await refreshBoot();const selected=localStorage.getItem(scopeKey('feedback-current-class'));if(boot.sessions.length)await loadClass(boot.sessions.some(c=>c.id===selected)?selected:boot.sessions[0].id,true);else $('save-status').textContent='可新建课堂';}catch(e){notice(e.message,true);}
