import { $, esc, api, notice, download, saved, captureView } from './ui.js';
import { validateUpload,MAX_MATERIALS,MAX_EXTRACTED_CHARACTERS } from '../src/uploadPolicy.js';
import { renderActivity } from '../src/interactive.js';
import { buildPresentation, slidesToExportModel } from '../src/pptExport.js';
import { toMarkdown } from '../src/pptGenerator.js';
import { matchSupplements } from '../src/frontier.js';
import { watchAgent, renderAgent, resetAgent, agentCallbacks, conversationPending } from './agent-ui.js';
import { renderCode, bindCodeCopy } from './code-ui.js';

const drafts = new Map();
let mutationQueue = Promise.resolve();
function serial(fn) { const task = mutationQueue.catch(() => {}).then(fn); mutationQueue = task.catch(() => {}); return task; }
let state, busy = false, submitting = false, previewReady = false, previewToken = '', previewIdentity='', previewTimer, contextSuggestions = [], materialUpload=null, understanding=false, sampleLoading=false;
const resource = () => state?.resources.find(r => r.id === state.selectedId);
const version = r => r?.versions.find(v => v.id === r.currentVersionId);
const isFormal = r => r.type === 'ppt' ? version(r).content.slides.length > 0 && version(r).content.slides.every(s => s.status === 'confirmed') : version(r).confirmed;
function stateCommand(action, extra = {}) { const r = resource(); return { revision: state.revision, action, resourceId: r?.id, baseVersionId: version(r)?.id, ...extra }; }
function checkTarget(expectedId) {
  if ((resource()?.id || null) !== expectedId) throw new Error('操作对象已切换，请检查当前资源后重新发送；原要求已保留。');
}
async function command(action, extra = {}, expectedId) { return serial(() => {
  if(expectedId !== undefined)checkTarget(expectedId);
  return saveCommand(action, extra);
}); }
async function saveCommand(action, extra = {}) {
  $('save-status').textContent = '保存中…';
  const previousResourceId = resource()?.id;
  try { state = await api('/api/workspace', stateCommand(action, extra));
    for (const [key,value] of drafts) {
      if (action==='clear' || ['material','removeMaterial'].includes(action) && /^(analysis|supplement):/.test(key) || ['restore','undo','delete'].includes(action) && key.startsWith(previousResourceId+':') || action==='deleteSlide' && key.startsWith(previousResourceId+':'+extra.slideId+':') || action==='editSlide' && submittedPageDraft(key,value,previousResourceId,extra) || draftMatchesSaved(key,value)) drafts.delete(key);
    }
    render(); return state; }
  catch (error) { $('save-status').textContent = '保存失败 · 输入仍保留，请重试'; throw error; }
}
function handle(fn) { return async event => { try { notice(''); await fn(event); } catch (e) { notice(e.message, true); } }; }
function renderSettings() {
  for (const [key, val] of Object.entries(state.requirements)) $(key).value = val;
}
function renderContext() {
  const titles = { chapters: '章节', objectives: '教学目标', knowledgePoints: '知识点（逐行）', keyPoints: '重点', difficultPoints: '难点' };
  $('analysis-source').textContent = state.analysis ? ({llm:'AI 理解结果',local:'本地规则解析（非 AI）',teacher:'教师修订的理解结果'}[state.analysisSource] || '已保存理解结果（旧记录未记录来源，请核实）')+(state.analysisWarning?' · '+state.analysisWarning:'') : '';
  $('analysis-editor').innerHTML = state.analysis ? Object.entries(titles).map(([key,title]) => `<label>${title}<textarea data-analysis="${key}" rows="3">${esc(state.analysis[key]?.join('\n') || '')}</textarea></label>`).join('') : '<p class="muted">先理解资料，或直接提出生成要求。</p>';
  contextSuggestions = matchSupplements(state.analysis?.knowledgePoints || []);
  for (const selected of state.supplements) if (!contextSuggestions.some(s => s.title === selected.title)) contextSuggestions.push(selected);
  $('supplements').innerHTML = '<p class="muted">本地知识库补充；来源需教师核实。</p>' + contextSuggestions.map((s, i) => `<label><input style="display:inline;width:auto" type="checkbox" data-supplement="${i}" ${state.supplements.some(x => x.title === s.title) ? 'checked' : ''}>${esc(s.title)}<small>${esc(s.description)} · ${esc(s.source)}</small></label>`).join('');
}
function render() {
  const restoreView=captureView(),messages=$('messages'),followMessages=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;
  saved(state); renderSettings(); renderContext();
  $('material-count').textContent = state.materials.length;
  $('materials').innerHTML = state.materials.map(m => `<div class="material" data-material="${m.id}"><button data-remove-material="${m.id}" title="移除资料" ${materialUpload?'disabled':''}>×</button><strong>${esc(m.title)}</strong><p class="muted">${m.status === 'failed' ? '解析失败：' + esc(m.error) : `${m.content.length} 字符 · 已解析${m.source === 'sample' ? ' · 示例' : ''}${m.truncated?' · 已截取：原文 '+m.originalCharacters+' 字符，仅保留前 250000 字符':''}`}</p>${m.status === 'failed' ? '' : `<details><summary>查看解析内容</summary><pre class="material-content">${esc(m.content)}</pre></details>`}</div>`).join('');
  const materialChars=state.materials.reduce((n,m)=>n+m.content.length,0);
  $('context-limit').textContent=materialChars>50000?'资料正文合计 '+materialChars+' 字符。备课智能体会按主题检索相关正文并分批处理。':'';
  document.querySelectorAll('[data-remove-material]').forEach(b => b.onclick = handle(async () => { await command('removeMaterial', {materialId:b.dataset.removeMaterial}); notice('资料已移除；后续 AI 使用更新后的上下文，已有资源保留。'); }));
  $('resource-count').textContent = state.resources.length;
  $('resources').innerHTML = state.resources.map(r => `<button class="resource ${r.id === state.selectedId ? 'selected' : ''}" data-resource="${r.id}">${esc(r.name)}<small>${{ppt:'PPT',game:'小游戏',web:'教学网页'}[r.type]} · ${r.origin === 'sample' ? '本地示例 · ' : ''}${isFormal(r) ? '已确认' : '待确认'} · ${r.versions.length} 个版本</small></button>`).join('');
  document.querySelectorAll('[data-resource]').forEach(b => b.onclick = handle(async () => {
    $('frame-host').style.pointerEvents='none';$('preview-status').textContent='正在切换资源…';
    try{await command('select', {resourceId:b.dataset.resource});}
    finally{$('frame-host').style.pointerEvents='';if(previewReady)$('preview-status').textContent='当前版本已初始化，请试玩主要操作、反馈与重置后确认。';}
  }));
  const r = resource(), v = version(r);
  $('empty').hidden = !!r; $('resource-tools').hidden = !r; $('delete-resource').hidden = !r;
  $('resource-title').textContent = r?.name || '从一个教学想法开始';
  $('resource-meta').textContent = v ? `${isFormal(r) ? '已确认' : '待确认'}${r.type==='ppt'?' · '+v.content.slides.length+' 页':''} · ${r.origin === 'sample' ? '本地示例 · ' : ''}版本 ${v.id.slice(0,8)}` : '资料、预览和对话都在这里';
  $('operation-scope').hidden = !r;
  $('operation-target').textContent = '操作对象：' + (r?.name || '新资源');
  const oldScope = $('scope').value;
  $('scope').innerHTML = '<option value="">当前整份资源</option>' + (r?.type === 'ppt' ? v.content.slides.map((s,i) => `<option value="${s.id}">第 ${i+1} 页：${esc(s.title)}</option>`).join('') : '');
  if ([...$('scope').options].some(o => o.value === oldScope)) $('scope').value = oldScope;
  $('history').innerHTML = r ? [...r.versions].reverse().map(x => `<option value="${x.id}">${x.id.slice(0,8)} · ${esc(x.summary.slice(0,80))}${x.summary.length>80?'…':''}${x.id === v.id ? '（当前）' : ''}</option>`).join('') : '';
  $('undo').disabled = !v?.parentId; $('export-final').disabled = !r || !isFormal(r);
  $('reflow-code').hidden=r?.type!=='ppt'||!v.content.slides.some(s=>s.code&&s.code.kind!=='output');
  $('btn-export-pptx-final').disabled = !r || !isFormal(r); $('export-md-final').hidden = r?.type !== 'ppt'; $('export-md-final').disabled = !r || !isFormal(r); $('export-md').hidden = r?.type !== 'ppt';
  renderSlides(r, v); renderPreview(r, v);
  $('messages').innerHTML = state.messages.map(m => `<div class="message ${m.role} ${m.status === 'failed' ? 'failed' : ''}"><strong>${m.role === 'user' ? '教师' : '备课智能体'}</strong>${m.text.length>600?`<p>${esc(m.text.slice(0,180))}…</p><details><summary>完整内容</summary><p>${esc(m.text)}</p></details>`:`<p>${esc(m.text)}</p>`}${m.status === 'processing' ? `<small>${m.mode==='task'?'正在处理，进度见上方。':'正在回应…'}</small>` : ''}${m.error ? `<small>这条要求尚未完成。</small><details><summary>查看原因</summary><p>${esc(m.error)}</p></details><button data-retry="${m.id}">重新规划这条要求</button>` : ''}${m.summary ? `<details><summary>修改记录</summary><small>${esc(m.summary)}</small></details>` : ''}</div>`).join('');
  if(!state.messages.some(m=>m.jobId))resetAgent();
  restoreDrafts();
  restoreView();if(followMessages)messages.scrollTop=messages.scrollHeight;
  document.querySelectorAll('[data-retry]').forEach(b => b.onclick = handle(async () => { if(busy)return;const m = state.messages.find(m => m.id === b.dataset.retry); if(m.resourceId && state.resources.some(r=>r.id===m.resourceId) && state.selectedId!==m.resourceId)await command('select',{resourceId:m.resourceId});$('scope').value='';$('request').value=m.text;await sendRequest(); }));
}
function draftMatchesSaved(key,value){
  const [first,second,field]=key.split(':');let savedValue;
  if(first==='setting')savedValue=state.requirements[second];
  else if(first==='analysis')savedValue=state.analysis?.[second];
  else if(first==='supplement'){const title=contextSuggestions[Number(second)]?.title;savedValue=state.supplements.some(s=>s.title===title);}
  else {const r=state.resources.find(r=>r.id===first),v=version(r),slide=v?.content.slides?.find(s=>s.id===second);savedValue=second==='activity'?v?.content[field==='activity-title'?'title':'description']:field==='codeSource'?slide?.code?.source?.replace(/\r\n?/g,'\n'):field==='codeLanguage'?slide?.code?.language:slide?.[field];}
  if(Array.isArray(savedValue))return JSON.stringify(savedValue)===JSON.stringify(String(value).split('\n').map(x=>x.trim()).filter(Boolean));
  return typeof savedValue==='boolean'?savedValue===value:savedValue!==undefined && String(savedValue)===String(value);
}
function submittedPageDraft(key,value,resourceId,extra){
  if(!key.startsWith(resourceId+':'+extra.slideId+':'))return false;
  const field=key.split(':')[2],submitted=field==='codeSource'?extra.patch?.code?.source:field==='codeLanguage'?extra.patch?.code?.language:extra.patch?.[field];
  if(submitted===undefined)return false;
  const draft=Array.isArray(submitted)?String(value).split('\n').map(x=>x.trim()).filter(Boolean):value;
  return JSON.stringify(draft)===JSON.stringify(submitted);
}
function draftKey(el) {
  if (['topic','audience','duration','instructions'].includes(el.id)) return 'setting:'+el.id;
  if (el.dataset.analysis) return 'analysis:'+el.dataset.analysis;
  if (el.dataset.supplement!==undefined) return 'supplement:'+el.dataset.supplement;
  if (el.dataset.field) return resource().id+':'+el.closest('[data-slide]').dataset.slide+':'+el.dataset.field;
  if (['activity-title','activity-description'].includes(el.id)) return resource()?.id+':activity:'+el.id;
  return null;
}
function restoreDrafts() {
  for (const el of document.querySelectorAll('input,textarea')) {
    const key=draftKey(el); if (!key) continue;
    const baseline=el.type==='checkbox'?el.checked:el.value;
    if (drafts.has(key)) { if(el.type==='checkbox') el.checked=drafts.get(key); else el.value=drafts.get(key); }
    el.oninput=()=>{const value=el.type==='checkbox'?el.checked:el.value;if(value===baseline)drafts.delete(key);else drafts.set(key,value);if(drafts.size)$('save-status').textContent='有未保存修改';else saved(state);};
  }
  if(drafts.size) $('save-status').textContent='有未保存修改';
}
async function flushCurrentEdits() { const targetId=resource()?.id || null,edits=collectEditorEdits(); for(const e of edits) await command(e.action,e.extra,targetId);checkTarget(targetId);if(collectEditorEdits().length)throw new Error('保存期间又有新修改，请保存后重新确认或导出。'); }
function renderSlides(r, v) {
  $('page-navigation').hidden=r?.type!=='ppt';
  $('page-jump').innerHTML=r?.type==='ppt'?'<option value="">定位到页面…</option>'+v.content.slides.map((s,i)=>`<option value="${s.id}">${i+1}. ${esc(s.title)}</option>`).join(''):'';
  const isPpt = r?.type === 'ppt'; $('ppt-footer').hidden = !isPpt;
  $('review-list').innerHTML = isPpt ? v.content.slides.map((s, i) => `<article class="slide-card" data-slide="${s.id}"><div class="slide-head"><span>第 ${i+1} 页 · ${esc(s.section)}</span><span>${s.status === 'confirmed' ? '✓ 已确认' : '待确认'}</span></div><div class="slide-screen"><h3>${esc(s.title)}</h3><ul>${s.bullets.map(t => `<li>${esc(t)}</li>`).join('')}</ul>${s.example ? `<p class="slide-example">示例：${esc(s.example)}</p>` : ''}${s.counterExample ? `<p>反例：${esc(s.counterExample)}</p>` : ''}${renderCode(s.code,s.id)}${s.attachment ? `<p>↗ ${esc(s.attachment.title)} · 固定版本 ${s.attachment.versionId.slice(0,8)}</p>` : ''}</div><div class="slide-edit"><details><summary>直接编辑与教师备注</summary><label>标题<input data-field="title" value="${esc(s.title)}"></label><label>正文（逐行）<textarea data-field="bullets" rows="4">${esc(s.bullets.join('\n'))}</textarea></label><label>示例<textarea data-field="example" rows="2">${esc(s.example || '')}</textarea></label><label>反例<textarea data-field="counterExample" rows="2">${esc(s.counterExample || '')}</textarea></label><label>代码语言<input data-field="codeLanguage" value="${esc(s.code?.language || 'text')}" placeholder="cpp / python / javascript"></label><label>示例代码（保留换行缩进）<textarea class="code-editor" data-field="codeSource" rows="8" spellcheck="false">
${esc(s.code?.source || '')}</textarea></label><label>教师备注（逐行）<textarea data-field="notes" rows="3">${esc(s.notes.join('\n'))}</textarea></label><button data-save-slide="${s.id}">保存页面修改</button></details><div class="actions"><button data-confirm-slide="${s.id}">确认本页</button><button data-target-slide="${s.id}">通过对话修改本页</button><button data-delete-slide="${s.id}" class="danger">删除本页</button></div><label>关联互动版本<select data-attach-select="${s.id}"><option value="">选择互动资源</option>${state.resources.filter(x => x.type !== 'ppt').map(x => `<option value="${x.id}">${esc(x.name)} · ${version(x).id.slice(0,8)}</option>`).join('')}</select></label><button data-attach="${s.id}">放入本页</button></div></article>`).join('') : '';
  if(isPpt)bindCodeCopy(v.content.slides);
  document.querySelectorAll('[data-save-slide]').forEach(b => b.onclick = handle(async () => {
    const edit=collectEditorEdits().find(e=>e.extra.slideId===b.dataset.saveSlide);
    if(edit) await command(edit.action,edit.extra);
  }));
  document.querySelectorAll('[data-confirm-slide]').forEach(b => b.onclick = handle(async () => { await flushCurrentEdits(); await command('confirm', {slideId:b.dataset.confirmSlide}); }));
  document.querySelectorAll('[data-delete-slide]').forEach(b => b.onclick = handle(() => command('deleteSlide', {slideId:b.dataset.deleteSlide})));
  document.querySelectorAll('[data-target-slide]').forEach(b => b.onclick = () => { $('scope').value = b.dataset.targetSlide; document.querySelector('.workbench').dataset.tab = 'chat'; $('request').focus(); });
  document.querySelectorAll('[data-attach]').forEach(b => b.onclick = handle(() => command('attach', {slideId:b.dataset.attach,activityId:document.querySelector(`[data-attach-select="${b.dataset.attach}"]`).value})));
}
function renderPreview(r, v, force=false) {
  $('activity-panel').hidden = !r || r.type === 'ppt';
  if(r && r.type!=='ppt'){$('activity-title').value=v.content.title;$('activity-description').value=v.content.description;}
  const identity=r && r.type!=='ppt'?`${r.id}:${v.id}:${v.confirmed}`:'';
  if(identity && identity===previewIdentity && !force)return;
  previewIdentity=identity;
  clearTimeout(previewTimer);
  $('activity-panel').hidden = !r || r.type === 'ppt'; $('frame-host').replaceChildren();
  previewToken = ''; previewReady = false;
  if (!r || r.type === 'ppt') return;
  $('activity-title').value = v.content.title; $('activity-description').value = v.content.description;
  previewToken = `${r.id}:${v.id}:${crypto.randomUUID()}`;
  const iframe = document.createElement('iframe'); iframe.title = '互动资源隔离预览'; iframe.setAttribute('sandbox','allow-scripts'); iframe.referrerPolicy = 'no-referrer';
  iframe.style.visibility='hidden';iframe.onload=()=>{iframe.dataset.loaded='true';activatePreview(iframe);};
  iframe.srcdoc = renderActivity(v.content, {token:previewToken, draft:!v.confirmed, version:v.id,source:r.origin}); $('frame-host').append(iframe);
  $('preview-status').textContent = '正在初始化当前版本…';
  previewTimer = setTimeout(() => { $('preview-status').textContent = '预览未在预期时间内启动，可退出、重置或通过对话重新生成。'; }, 6000);
}
window.addEventListener('message', event => {
  const frame = $('frame-host').querySelector('iframe');
  if (event.source !== frame?.contentWindow || event.origin !== 'null' || event.data?.type !== 'activity-ready' || event.data?.token !== previewToken) return;
  frame.dataset.ready='true';activatePreview(frame);
});
function activatePreview(frame){
  if(frame.dataset.loaded!=='true'||frame.dataset.ready!=='true')return;
  // Wait for the newly navigated frame to be laid out before accepting input.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if($('frame-host').querySelector('iframe')!==frame)return;
    frame.style.visibility='';clearTimeout(previewTimer);previewReady=true;$('preview-status').textContent='当前版本已初始化，请试玩主要操作、反馈与重置后确认。';
  }));
}
function collectContext() {
  if (!state.analysis) return null;
  const analysis = Object.fromEntries([...document.querySelectorAll('[data-analysis]')].map(el => [el.dataset.analysis,el.value.split('\n').map(x => x.trim()).filter(Boolean)]));
  const supplements = [...document.querySelectorAll('[data-supplement]:checked')].map(el => contextSuggestions[Number(el.dataset.supplement)]);
  return {analysis,supplements};
}
function collectEditorEdits() {
  const r = resource(), v = version(r); if (!r) return [];
  if (r.type !== 'ppt') return $('activity-title').value!==v.content.title || $('activity-description').value!==v.content.description ? [{action:'editActivity',extra:{title:$('activity-title').value,description:$('activity-description').value}}] : [];
  return [...document.querySelectorAll('[data-slide]')].flatMap(card => {
    const slide = v.content.slides.find(s => s.id===card.dataset.slide),patch = {};
    for (const el of card.querySelectorAll('[data-field]')) {
      if(el.dataset.field.startsWith('code'))continue;
      const key = el.dataset.field, val = ['bullets','notes'].includes(key) ? el.value.split('\n').map(x=>x.trim()).filter(Boolean) : el.value;
      if (JSON.stringify(val)!==JSON.stringify(slide[key] ?? '')) patch[key]=val;
    }
    const source=card.querySelector('[data-field=codeSource]').value,language=card.querySelector('[data-field=codeLanguage]').value || 'text';
    // Textarea values normalize CRLF/CR. Keep the stored bytes when the teacher
    // changes another field, confirms, or exports without editing source.
    const savedSource=slide.code?.source||'',sourceChanged=source!==savedSource.replace(/\r\n?/g,'\n');
    if(sourceChanged||(source&&language!==(slide.code?.language||'text')))patch.code=source.trim()?{...slide.code,source:sourceChanged?source:savedSource,language}:null;
    return Object.keys(patch).length ? [{action:'editSlide',extra:{slideId:slide.id,patch}}] : [];
  });
}
async function saveSettings() {
  const requirements = Object.fromEntries(['topic','audience','duration','instructions'].map(k => [k,$(k).value])); requirements.duration = Number(requirements.duration);
  if (JSON.stringify(requirements) !== JSON.stringify(state.requirements)) await command('settings', {requirements});
}
async function sendRequest() {
  if (busy) return;
  if(materialUpload)throw new Error('请等待本批资料上传完成，或先停止上传再发送要求。');
  const request = $('request').value.trim(), scope = $('scope').value;
  const targetId = resource()?.id || null;
  const editorEdits = collectEditorEdits();
  const context = collectContext();
  if (!request) throw new Error('请输入消息。');
  submitting=true;busy = true; $('send').disabled = true;
  try {
    await saveSettings();
    for (const edit of editorEdits) await command(edit.action,edit.extra,targetId);
    if (context && (JSON.stringify(context.analysis)!==JSON.stringify(state.analysis)||JSON.stringify(context.supplements)!==JSON.stringify(state.supplements))) await command('context',context);
    await mutationQueue;
    checkTarget(targetId);
    const r = resource(); notice('');
    const result = await api('/api/workspace/agent', {revision:state.revision,request,resourceId:r?.id || null,baseVersionId:version(r)?.id || null,pageId:scope || null});
    state=result.workspace;
    if($('request').value.trim()===request)$('request').value = ''; render(); followAgent(result.job);
  } catch (error) {
    if (error.state) { state = error.state; render(); }
    if(!$('request').value.trim())$('request').value = request; throw error;
  } finally {submitting=false;busy=submitting||conversationPending();$('send').disabled=busy||!!materialUpload;}
}
function followAgent(job){watchAgent(job);}
agentCallbacks({onState:next=>{state=next;render();},onProgress:async(job,isCurrent)=>{
    const message=state?.messages.find(m=>m.jobId===job.id&&m.role==='user');
    if(message && message.mode!==job.mode){
      busy=true;$('send').disabled=true;
      const next=await api('/api/workspace');if(!isCurrent())return;
      if(next.revision>=state.revision)state=next;render();
    }
    busy=submitting||conversationPending();$('send').disabled=busy||!!materialUpload;
  },onEnd:async (finished,isCurrent)=>{
    const next=await api('/api/workspace');if(!isCurrent())return;if(next.revision>=state.revision)state=next;render();busy=submitting||conversationPending();$('send').disabled=busy||!!materialUpload;
    if(finished.stage==='completed'){if(finished.mode==='conversation')notice('');else notice('成果已保存，请审阅后确认。');}
    else if(finished.stage==='paused')notice('已暂停，草稿与进度已保存，点击继续可恢复。');
    else notice(finished.error || '任务尚未完成，草稿已保留。',true);
  }});
async function exportResource(draft = true, markdown = false) {
  await flushCurrentEdits();
  const r = resource(), v = version(r); if (!r) throw new Error('请选择资源。');
  if (!draft && !isFormal(r)) throw new Error('当前资源的全部内容确认后才能导出正式稿。');
  const prefix = `${r.name.replace(/[\\/:*?"<>|]/g,'-')}-${draft?'草稿':'正式稿'}-${v.id.slice(0,8)}`;
  if (r.type !== 'ppt') { download(prefix + '.html', renderActivity(v.content, {draft,version:v.id,source:r.origin}), 'text/html;charset=utf-8'); return; }
  const slides = v.content.slides, md = `<!-- ${draft?'草稿 · 待确认':'正式稿 · 全部有效页面已确认'}；${r.origin==='sample'?'本地示例（含后续修改）；':''}资源版本 ${v.id} -->\n` + toMarkdown(slides, {confirmedOnly:!draft});
  if (markdown) { download(prefix+'.md',md,'text/markdown;charset=utf-8'); return; }
  const attachments = slides.flatMap(s => s.attachment ? [s.attachment] : []);
  if (!draft && attachments.some(a => !(state.resources.find(r => r.id === a.resourceId)?.versions.find(v => v.id === a.versionId)?.confirmed || a.confirmed))) throw new Error('配套互动版本尚未确认，请先确认该版本，再导出正式稿。');
  const model = slidesToExportModel(slides, {canonical:true,confirmedOnly:!draft}).map(s => ({...s,draft}));
  const ppt = buildPresentation(model,window.PptxGenJS), buffer = await ppt.write({outputType:'arraybuffer'});
  if (!attachments.length) download(prefix+'.pptx',buffer,'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  else {
    const zip = new window.JSZip(); zip.file(prefix+'.pptx',buffer); zip.file(prefix+'.md',md);
    for (const a of attachments) zip.file(a.fileName,renderActivity(a.content,{draft,version:a.versionId,source:a.source}));
    zip.file('打开说明.txt','解压全部文件至同一文件夹。PPT 页面入口指向固定版本 HTML。若演示软件禁止本地超链接，请在浏览器直接打开对应 HTML 文件。文件包含全部脚本和样式，无需联网。\n资源版本：'+v.id);
    download(prefix+'-配套资源.zip',await zip.generateAsync({type:'arraybuffer'}),'application/zip');
  }
}
$('save-settings').onclick = handle(saveSettings);
$('add-text').onclick = handle(async () => { const content = $('material-text').value.trim();if(content.length>MAX_EXTRACTED_CHARACTERS)throw new Error('粘贴资料超过 250000 字符，请精简后提交。');await command('material',{material:{title:'粘贴资料 '+(state.materials.length+1),type:'文本',content}});if($('material-text').value.trim()===content)$('material-text').value = ''; });
$('files').onchange = handle(async () => {
  if(materialUpload)return;
  const files = [...$('files').files];
  const remaining=MAX_MATERIALS-state.materials.length;
  if(files.length>remaining){$('files').value='';$('parse-status').textContent=`最多 ${MAX_MATERIALS} 条资料，剩余 ${remaining} 个名额；本批未上传，请减少选择数量或移除资料。`;return;}
  materialUpload=new AbortController();$('files').disabled=true;$('add-text').disabled=true;$('cancel-material-upload').hidden=false;$('understand').disabled=true;$('clear-workspace').disabled=true;$('sample').disabled=true;$('send').disabled=true;render();
  let completed=0,failed=0,cancelled=false;
  try{for (const file of files) {
    if(materialUpload.signal.aborted){cancelled=true;break;}
    $('parse-status').textContent = file.name + ' · 解析中…';
    try {
      validateUpload(file,'material');
      const response = await fetch('/api/extract-file?name='+encodeURIComponent(file.name),{method:'POST',body:file,signal:materialUpload.signal}), result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if(materialUpload.signal.aborted){cancelled=true;break;}
      await command('material',{material:{title:file.name,type:result.type,content:result.content,truncated:result.truncated,originalCharacters:result.originalCharacters}});completed++;
    } catch (e) {if(e.name==='AbortError'){cancelled=true;break;}await command('materialFailure',{title:file.name.slice(0,255),error:e.message});failed++;}
  }}finally{materialUpload=null;$('files').value='';$('files').disabled=false;$('add-text').disabled=false;$('cancel-material-upload').hidden=true;$('understand').disabled=understanding;$('clear-workspace').disabled=false;$('sample').disabled=sampleLoading;$('send').disabled=busy;render();$('parse-status').textContent=`${cancelled?'已停止本批上传，已保存资料保留。':'本批完成。'}成功 ${completed}，失败 ${failed}；失败原因见资料列表。`;}
});
$('cancel-material-upload').onclick=()=>materialUpload?.abort();
$('understand').onclick = handle(async () => {
  if(understanding)return;
  const materials = state.materials.filter(m => m.status === 'parsed'); if (!materials.length) throw new Error('请先加入有效资料。');
  const input=JSON.stringify(materials);understanding=true;$('understand').disabled=true;$('understand').textContent='正在理解资料…';
  try{
    const response = await api('/api/analyze-materials',{materials});
    await serial(()=>{
      if(JSON.stringify(state.materials.filter(m=>m.status==='parsed'))!==input)throw new Error('理解期间资料已变更，本次结果未应用，请重新理解资料。');
      return saveCommand('context',{analysis:response.analysis,supplements:[],source:response.source,warning:response.warning||''});
    });
    if (response.warning) notice(response.warning);
  }finally{understanding=false;$('understand').disabled=!!materialUpload;$('understand').textContent='理解资料';}
});
$('save-context').onclick = handle(async () => {
  const analysis = state.analysis ? Object.fromEntries([...document.querySelectorAll('[data-analysis]')].map(el => [el.dataset.analysis,el.value.split('\n').map(x => x.trim()).filter(Boolean)])) : null;
  const supplements = [...document.querySelectorAll('[data-supplement]:checked')].map(el => contextSuggestions[Number(el.dataset.supplement)]);
  await command('context',{analysis,supplements});
});
$('sample').onclick = handle(async () => {
  if(sampleLoading)return;
  sampleLoading=true;$('sample').disabled=true;$('sample').textContent='正在载入…';
  try{await serial(async()=>{
    const before=state,materialIds=new Set(before.materials.map(m=>m.id));
    state=await api('/api/workspace/sample',{revision:state.revision});
    const addedMaterials=state.materials.some(m=>!materialIds.has(m.id));
    if(addedMaterials)for(const key of drafts.keys())if(/^(analysis|supplement):/.test(key))drafts.delete(key);
    render();notice(state.revision===before.revision?'本地示例已载入，保留当前内容；没有重复添加。':addedMaterials?'已补充缺少的本地示例；资料上下文已更新，请重新理解。':'本地示例已整理，已有修改和当前选择保留。');
  });}finally{sampleLoading=false;$('sample').disabled=!!materialUpload;$('sample').textContent='载入本地示例';}
});
$('clear-workspace').onclick = handle(async () => { if (confirm('清空当前教学资料、全部资源、历史版本和对话？')){await command('clear');busy=false;$('send').disabled=!!materialUpload;} });
$('clear-context').onclick = handle(async () => {
  if(!state)throw new Error('正在恢复工作空间，请稍候。');
  if(busy||state.messages.some(m=>m.status==='processing'))throw new Error('请先暂停正在执行的任务，再清空上下文。');
  if(!state.messages.length){notice('当前没有历史对话。');return;}
  if(!confirm('清空全部历史对话和对话上下文？课件、资料、教师设置和输入中的新要求会保留。已暂停任务将无法继续，旧对话无法恢复。'))return;
  const button=$('clear-context');button.disabled=true;
  try{await command('clearConversation');resetAgent();notice('已清空历史对话和对话上下文；课件、资料与教师设置保留。');$('request').focus();}
  finally{button.disabled=false;}
});
$('delete-resource').onclick = handle(async () => { if (confirm('删除资源及其历史版本？已放入 PPT 的互动快照仍保留。')) await command('delete'); });
$('undo').onclick = handle(() => command('undo'));
$('restore').onclick = handle(() => command('restore',{versionId:$('history').value}));
$('rename').onclick = handle(async () => { const name = prompt('资源名称',resource().name); if (name) await command('rename',{name}); });
$('reflow-code').onclick=handle(async()=>{
  const target=resource()?.id,button=$('reflow-code');button.disabled=true;
  try{await flushCurrentEdits();await command('reflowCode',{},target);notice('已按完整函数和代码部分整理分页；完整源码保留。');}
  finally{button.disabled=false;}
});
$('add-slide').onclick = handle(() => command('addSlide'));
$('btn-confirm-all').onclick = handle(async () => { await flushCurrentEdits(); await command('confirm'); });
$('save-activity').onclick = handle(() => command('editActivity',{title:$('activity-title').value,description:$('activity-description').value}));
$('confirm-activity').onclick = handle(async () => { if (!$('frame-host').querySelector('iframe') || !previewReady) throw new Error('请先运行并试玩当前版本。'); if (collectEditorEdits().length) { await flushCurrentEdits(); throw new Error('基本信息已保存，请试玩更新后的版本再确认。'); } await command('confirm'); });
$('reset-preview').onclick = () => renderPreview(resource(),version(resource()),true);
$('exit-preview').onclick = () => { clearTimeout(previewTimer); $('frame-host').replaceChildren(); previewToken = ''; previewReady = false; $('preview-status').textContent = '已退出，点击重新试玩可恢复。'; };
$('fullscreen').onclick = handle(async () => { if (!$('frame-host').querySelector('iframe')) throw new Error('请先重新试玩。'); await $('frame-host').requestFullscreen(); });
$('export-draft').onclick = handle(() => exportResource(true));
$('export-final').onclick = $('btn-export-pptx-final').onclick = handle(() => exportResource(false));
$('export-md').onclick = handle(() => exportResource(true,true));
$('export-md-final').onclick = handle(() => exportResource(false,true));
$('chat-form').onsubmit = handle(async e => { e.preventDefault(); await sendRequest(); });
$('page-jump').onchange=()=>{const id=$('page-jump').value;if(id)document.querySelector(`[data-slide="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'start'});};
$('btn-generate-ppt').onclick = () => { $('request').value = '根据当前课程要求与资料，新建一份适合 '+$('duration').value+' 分钟授课的 PPT。'; document.querySelector('.workbench').dataset.tab='chat'; $('request').focus(); };
document.querySelectorAll('[data-new]').forEach(b => b.onclick = () => { const type={ppt:'PPT',game:'小游戏',web:'教学网页'}[b.dataset.new]; $('request').value='新建一个关于'+($('topic').value||'请填写课程主题')+'的'+type+'。'; document.querySelector('.workbench').dataset.tab='chat'; $('request').focus(); });
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => document.querySelector('.workbench').dataset.tab=b.dataset.tab);
window.addEventListener('beforeunload',event=>{if(drafts.size||busy||materialUpload||$('request').value.trim()||$('material-text').value.trim()){event.preventDefault();event.returnValue='';}});
try { state = await api('/api/workspace'); render(); const users=state.messages.filter(m=>m.role==='user'&&m.jobId), latestTask=[...users].reverse().find(m=>m.mode==='task'||!m.mode), pending=users.filter(m=>m.status==='processing');for(const id of new Set([latestTask?.jobId,users.at(-1)?.jobId,...pending.map(m=>m.jobId)].filter(Boolean))){const job=await api('/api/workspace/agent/'+id);if(state.messages.some(m=>m.jobId===job.id)){if(['completed','paused','failed'].includes(job.stage))renderAgent(job);else followAgent(job);}}const status = await api('/api/status'); $('model-status').textContent = status.textModelConfigured ? '当前模型：' + status.model : '请先配置文本模型，或载入本地示例。'; }
catch (error) { $('save-status').textContent='恢复失败'; notice(error.message,true); }

window.addEventListener('focus', async () => { try { const status = await api('/api/status'); $('model-status').textContent = status.textModelConfigured ? '当前文本模型：' + status.model + '。' : '文本模型尚未配置，请打开“模型与提示词设置”。'; } catch {} });
