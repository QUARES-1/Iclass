import { $, esc, api, notice, download, saved, time, originalTranscript, captureView, uploadBlob } from './ui.js';
import { DEFAULT_AUDIO_LIMITS,validateUpload } from '../src/uploadPolicy.js';
import {CLASSROOM_TERMINAL_STAGES,textObservations,transcriptText,transcriptLabel} from '../src/classroomShared.js';
import {createAudioPlayback} from './audio-player.js';
const SECTIONS = {summary:'统一总结',knowledge:'核心知识点',emphasis:'教学重点',difficulties:'潜在难点（推测）',observations:'表达与时间节奏观察',suggestions:'改进建议'};
const KINDS = {transcript:'转写归纳','teacher-emphasis':'教师明确强调','ai-inference':'AI 归纳',hypothesis:'推测','timing-estimate':'时间估算'};
const TIMESTAMPS = {'whisper-word-alignment+vad-offset+chunk-offset':'模型词对齐 · 语音区间与分段偏移','whisper-word-alignment+chunk-offset':'模型词对齐 · 分段偏移','legacy-user-timestamps':'旧记录人工时间'};
const STAGES = {paused:'已暂停',cancelled:'已取消',queued:'排队中',processing:'音频处理中','loading-model':'加载本地模型',transcribing:'真实转写中',analyzing:'分段分析中',summarizing:'整课汇总中',completed:'已完成',failed:'失败，可重试'};
let state, recording, stream, recordChunks = [], recordBytes=0, recordBlob = null, recordUrl = '', timer, startedAt, recordFormat = '', pollTimer, lastRevision = -1, dirty = false, saving = false, uploading=null, taskStarting=false, requestingMic=false, limits={...DEFAULT_AUDIO_LIMITS}, recordLimitHit=false;
const drafts = new Map();
let transcriptPage=0,transcriptSearch='',exporting=false,displayedAudioId;
const PAGE_SIZE=60;
const playback=createAudioPlayback($('audio-player'),{onLabel:label=>{$('playback-label').textContent=label;$('player-dock').hidden=false;},onError:message=>notice(message,true)});
let mutationQueue = Promise.resolve();
function serial(fn) { const task = mutationQueue.catch(() => {}).then(fn); mutationQueue = task.catch(() => {}); return task; }
const transcript = () => state?.transcriptVersions.find(v => v.id === state.currentTranscriptId);
const report = () => state?.reports.find(v => v.id === state.currentReportId);
const active = type => state?.jobs.some(j => j.type === type && !CLASSROOM_TERMINAL_STAGES.includes(j.stage));
const handle = fn => async event => { try { notice(''); await fn(event); } catch (error) { notice(error.message,true); } };
async function command(action, extra = {}) { return serial(() => saveCommand(action, extra)); }
async function saveCommand(action, extra = {}) {
  saving = true; $('save-status').textContent = '保存中…';
  try { state = await api('/api/classroom',{revision:state.revision,action,...extra});
    if(action==='reportItem'&&extra.delete)drafts.delete('report:'+extra.itemId);
    for(const [key,value] of drafts) if(action==='clear'||draftMatchesSaved(key,value)) drafts.delete(key);
    dirty=drafts.size>0; render(); }
  catch (error) { $('save-status').textContent='保存失败 · 输入保留，请重试'; throw error; }
  finally { saving = false; }
}
function audioUrl(audio) { return '/api/classroom/audio?id='+encodeURIComponent(audio.id); }
function draftMatchesSaved(key,value){
  const [kind,id]=key.split(':');
  const text=kind==='excluded'?Boolean(transcript()?.segments.find(s=>s.id===id)?.excluded):kind==='course'?state.course[id==='course-title'?'title':'description']:kind==='segment'?transcript()?.segments.find(s=>s.id===id)?.text:Object.values(report()?.sections||{}).flat().find(item=>item.id===id)?.text;
  return text!==undefined && text===value;
}
function updateControls(){
  const blocked=!!uploading || !!recording || taskStarting || requestingMic;
  $('transcribe').disabled=!state.audio || active('transcribe') || active('analysis') || blocked || !!recordBlob;
  $('audio-file').disabled=blocked || active('transcribe') || active('analysis') || !!recordBlob;
  $('delete-audio').disabled=!state.audio || active('transcribe') || active('analysis') || blocked || !!recordBlob;
  $('clear-classroom').disabled=blocked || active('transcribe') || active('analysis') || !!recordBlob;
  $('record-start').disabled=blocked || active('transcribe') || active('analysis');$('record-again').disabled=$('record-start').disabled;
  for(const [button,select] of [['restore-audio','audio-history'],['restore-transcript','transcript-history'],['restore-report','report-history']])$(button).disabled=!$(select).options.length || blocked || active('transcribe') || active('analysis');
  $('save-recording').disabled=!!uploading;$('discard-recording').hidden=!recordBlob;$('discard-recording').disabled=blocked;
  $('analyze').disabled=!transcript() || active('analysis') || active('transcribe') || blocked;
  const r=report();$('analyze-details').disabled=!r || r.mode!=='overview' || r.stale || active('analysis') || active('transcribe') || blocked;
  $('save-transcript').disabled=!transcript() || active('transcribe') || active('analysis') || !!uploading || taskStarting;
  $('simplify-transcript').disabled=$('save-transcript').disabled;
  document.querySelectorAll('[data-segment],[data-exclude]').forEach(el=>el.disabled=active('transcribe') || active('analysis') || !!uploading || taskStarting);
}
function render() {
  const restoreView=captureView();
  saved(state); lastRevision=state.revision;
  $('course-title').value=state.course.title; $('course-description').value=state.course.description;
  const audio=state.audio;
  $('audio-info').innerHTML=audio ? `<h3>${esc(audio.name)}</h3><p class="muted">${time(audio.duration)} · ${(audio.bytes/1024/1024).toFixed(1)} MB · ${audio.source==='recording'?'浏览器录音':'上传录音'} · 已保存</p>` : '<p class="muted">尚未保存录音。</p>';
  $('audio-player').hidden=!audio; if(audio&&displayedAudioId!==audio.id){playback.clear();$('audio-player').src=audioUrl(audio);displayedAudioId=audio.id;$('playback-label').textContent=audio.name;}if(!audio&&displayedAudioId){playback.clear();$('audio-player').removeAttribute('src');displayedAudioId=null;}
  document.querySelector('.audio-layout').classList.toggle('has-report',Boolean(report()));
  $('player-dock').hidden=!audio;

  renderJobs();renderHistory();
  $('classroom-messages').innerHTML=(state.conversation||[]).slice(-12).map(m=>`<div class="message ${m.role==='user'?'user':''}"><strong>${m.role==='user'?'教师':'复盘助手'}</strong><p>${esc(m.text)}</p></div>`).join('');
  const t=transcript();
  $('save-transcript').disabled=!t; $('analyze').disabled=!t || active('analysis');
  $('transcript-meta').textContent=t ? `转写版本 ${t.id.slice(0,8)} · ${transcriptLabel(t)} · ${t.segments.length} 个片段 · 时间以录音开始为基准` : '完成转写后，片段将在这里出现。';
  const original=originalTranscript(state,t);
  renderTranscript(t,original);
  renderFullTranscript();
  $('text-stats').textContent=t?(()=>{const stats=textObservations(t.segments);return `文本统计：${stats.chars}字，${stats.questions}个含问句的片段；文字节奏约${stats.estimatedCharsPerMinute??0}字/分钟（识别时间估算）。`})():'';
  renderReport();
  document.querySelectorAll('[data-play]').forEach(b=>b.onclick=handle(()=>playSegment(t,t.segments.find(s=>s.id===b.dataset.play))));
  document.querySelectorAll('textarea,input[type=text],input:not([type])').forEach(el=>{
    const key=['course-title','course-description'].includes(el.id)?'course:'+el.id:el.dataset.segment?'segment:'+el.dataset.segment:el.closest('[data-report-item]')?'report:'+el.closest('[data-report-item]').dataset.reportItem:null;
    if(!key)return;const baseline=el.value;if(drafts.has(key))el.value=drafts.get(key);
    el.oninput=()=>{if(el.value===baseline)drafts.delete(key);else drafts.set(key,el.value);dirty=drafts.size>0;if(dirty)$('save-status').textContent='有未保存修改';else saved(state);if(key.startsWith('segment:'))renderFullTranscript();};
  });
  document.querySelectorAll('[data-exclude]').forEach(el=>{const key='excluded:'+el.dataset.exclude,baseline=Boolean(t.segments.find(s=>s.id===el.dataset.exclude)?.excluded);el.checked=drafts.has(key)?drafts.get(key):baseline;el.onchange=()=>{if(el.checked===baseline)drafts.delete(key);else drafts.set(key,el.checked);dirty=drafts.size>0;el.closest('.transcript-row').classList.toggle('excluded',el.checked);$('save-status').textContent=dirty?'有未保存修改':'已保存';renderFullTranscript();};});
  if(drafts.size){dirty=true;$('save-status').textContent='有未保存修改';}
  restoreView();updateControls();
}
function renderTranscript(t,original){
  const all=t?.segments||[],filtered=all.filter(s=>(drafts.get('segment:'+s.id)??s.text).toLowerCase().includes(transcriptSearch.toLowerCase()));
  transcriptPage=Math.max(0,Math.min(transcriptPage,Math.ceil(filtered.length/PAGE_SIZE)-1));
  const visible=filtered.slice(transcriptPage*PAGE_SIZE,(transcriptPage+1)*PAGE_SIZE);
  $('original-transcript').innerHTML=original?visible.map(s=>{const raw=original.segments.find(r=>r.id===s.id);return raw?`<p>${time(raw.start)}—${time(raw.end)} ${esc(raw.text)}</p>`:'';}).join(''):'<p class="muted">尚无识别原稿。</p>';
  $('transcript').innerHTML=t?visible.map(s=>`<div class="transcript-row ${s.excluded?'excluded':''}"><button data-play="${s.id}">${time(s.start)}—${time(s.end)} ▶</button><span class="badge" title="${esc(s.timestampSource)}">${esc(TIMESTAMPS[s.timestampSource]||'已保存的片段时间')}</span><textarea data-segment="${s.id}" rows="2" aria-label="${time(s.start)}转写文字">${esc(s.text)}</textarea><label><input type="checkbox" data-exclude="${s.id}">排除此误识别片段（保留原稿与时间）</label></div>`).join(''):'<p class="muted">上传或保存课堂录音，完成转写后可在这里校正。</p>';
  $('transcript-page-meta').textContent=filtered.length?`${transcriptPage*PAGE_SIZE+1}—${Math.min((transcriptPage+1)*PAGE_SIZE,filtered.length)} / ${filtered.length}片段`:'没有匹配片段';
  $('transcript-prev').disabled=transcriptPage===0;$('transcript-next').disabled=(transcriptPage+1)*PAGE_SIZE>=filtered.length;
}
function renderJobs(){
  const jobHtml=j=>`<div class="job ${j.stage==='failed'?'failed':''}"><strong>${j.type==='transcribe'?'语音转写':j.mode==='details'?'细分分析':'整体复盘'} · ${STAGES[j.stage]||j.stage}</strong>${j.audio?.name?`<p>${esc(j.audio.name)}</p>`:''}${j.createdAt?`<p>${new Date(j.createdAt).toLocaleString()}</p>`:''}${j.chunkStart!==undefined?`<p>当前片段 ${time(j.chunkStart)}—${time(j.chunkEnd)}</p>`:''}${j.totalParts?`<p>已处理 ${j.completedParts||0}/${j.totalParts}段</p>`:''}${j.error?`<p>${esc(j.error)}</p>`:''}${j.type==='analysis'&&j.input&&['failed','paused'].includes(j.stage)&&j.totalParts&&j.completedParts===j.totalParts?'<p>分段分析已保存，继续任务将从整课汇总开始。</p>':''}<div class="actions">${!CLASSROOM_TERMINAL_STAGES.includes(j.stage)?`<button data-job="${j.id}" data-job-action="pause">暂停</button><button data-job="${j.id}" data-job-action="cancel">取消任务</button>`:j.input&&['paused','failed'].includes(j.stage)?`<button data-job="${j.id}" data-job-action="resume">继续任务</button><button data-job="${j.id}" data-job-action="cancel">放弃任务</button>`:''}</div></div>`;
  const latest=state.jobs.at(-1),others=state.jobs.slice(0,-1).slice(-20).reverse();
  $('jobs').innerHTML=(latest?jobHtml(latest):'')+(others.length?`<details id="job-history" class="job-history"><summary>历史任务 · ${others.length}</summary>${others.map(jobHtml).join('')}</details>`:'');
  document.querySelectorAll('[data-job-action]').forEach(b=>b.onclick=handle(async()=>{b.disabled=true;try{state=await api(`/api/classroom/jobs/${b.dataset.job}/${b.dataset.jobAction}`,{revision:state.revision});render();}finally{b.disabled=false;}}));
}
function renderHistory(){
  const option=(value,label,selected)=>`<option value="${esc(value)}" ${selected?'selected':''}>${esc(label)}</option>`;
  const audios=new Map([state.audio,...state.transcriptVersions.map(t=>t.audio),...state.jobs.map(j=>j.audio)].filter(a=>a&&!a.deleted).map(a=>[a.id,a]));
  $('audio-history').innerHTML=[...audios.values()].map(a=>option(a.id,a.name,a.id===state.audio?.id)).join('');$('restore-audio').disabled=!audios.size;
  $('transcript-history').innerHTML=state.transcriptVersions.slice().reverse().map(t=>option(t.id,`${transcriptLabel(t)} · ${t.audio?.name||'文字记录'} · ${new Date(t.createdAt||0).toLocaleString()}`,t.id===state.currentTranscriptId)).join('');$('restore-transcript').disabled=!state.transcriptVersions.length;
  $('report-history').innerHTML=state.reports.slice().reverse().flatMap(r=>[option(r.id,`报告 · ${new Date(r.createdAt||0).toLocaleString()}`,r.id===state.currentReportId),...(r.history||[]).slice().reverse().map(h=>option(r.id+':'+h.id,`人工修订前 · ${new Date(h.createdAt).toLocaleString()}`,false))]).join('');$('restore-report').disabled=!state.reports.length;
}
function renderReport() {
  const r=report(); $('export-report').disabled=!r||exporting;
  $('confirm-report').hidden=!r;$('confirm-report').disabled=!r||r.stale||active('analysis');
  $('report-meta').textContent=r ? `${r.stale?'待更新：课程、录音或转写已变化':'对应当前输入'} · 转写版本 ${r.transcriptId.slice(0,8)} · 结论须由教师逐项确认` : '尚无报告。AI 不可用时，录音与转写仍会保存。';
  const rt=r && state.transcriptVersions.find(t=>t.id===r.transcriptId);
  const section=key=>`<section data-report-section="${key}"><h3>${SECTIONS[key]}</h3>${(r.sections[key]||[]).map(item=>`<div class="report-item ${item.confirmed&&!r.stale?'confirmed':''}" data-report-item="${item.id}" data-section="${key}"><p class="report-text">${esc(item.text)}</p><span class="badge">${item.confirmed&&!r.stale?'已确认':'待确认'}${item.edited?' · 教师修订':''}</span><details><summary>修订与确认</summary><textarea rows="3" aria-label="修订分析结论">${esc(item.text)}</textarea><div class="actions"><button data-item-save="${item.id}">保存修订</button><button data-item-confirm="${item.id}" ${r.stale?'disabled':''}>确认</button><button data-item-delete="${item.id}" class="danger">删除结论</button></div></details><details><summary>查看依据 · ${esc(KINDS[item.kind]||item.kind)}</summary>${(item.timeEvidence||[]).map(range=>`<p class="muted">时间依据 ${time(range.start)}—${time(range.end)} · ${range.basis==='segment-gap'?'片段间隔，不代表精确静音':'讲解跨度（含间隔），不代表连续发言'}</p>`).join('')}${item.evidenceIds.map(eid=>{const s=rt?.segments.find(s=>s.id===eid);return s?`<button data-evidence="${eid}">${time(s.start)}—${time(s.end)} ▶</button><p class="muted">${esc(s.text)}</p>`:'';}).join('')}</details></div>`).join('') || '<p class="muted">没有足够依据，未生成此类结论。</p>'}</section>`;
  $('report').innerHTML=!r?'':r.mode==='overview'?section('summary')+section('suggestions')+(r.detailSections||[]).map(key=>`<details id="report-detail-${key}"><summary>${SECTIONS[key]} · 细分分析</summary>${section(key)}</details>`).join(''):`<p class="muted">旧版详细报告已保留。点击“生成总结与建议”可生成精简版。</p><details id="legacy-analysis"><summary>查看原有详细报告</summary>${Object.keys(SECTIONS).map(section).join('')}</details>`;
  document.querySelectorAll('[data-evidence]').forEach(b=>b.onclick=handle(()=>playSegment(rt,rt.segments.find(s=>s.id===b.dataset.evidence))));
  if(active('analysis'))document.querySelectorAll('.report-item textarea,.report-item .actions button').forEach(el=>el.disabled=true);
  for(const [selector,operation] of [['data-item-save','save'],['data-item-confirm','confirm'],['data-item-delete','delete']]) document.querySelectorAll(`[${selector}]`).forEach(b=>b.onclick=handle(async()=>{
    const card=b.closest('[data-report-item]');
    const target={reportId:r.id,section:card.dataset.section,itemId:card.dataset.reportItem}, text=card.querySelector('textarea').value;
    if(operation==='confirm' && text!==r.sections[target.section].find(item=>item.id===target.itemId).text) await command('reportItem',{...target,text});
    if(operation==='confirm' && drafts.has('report:'+target.itemId))throw new Error('保存期间修订又有变化，请保存最新文字后再确认。');
    await command('reportItem',{...target,...(operation==='save'?{text}:{[operation]:true})});
  }));
}
async function playSegment(t,s){
  if(!s||!t?.audio||t.audio.deleted)throw new Error('此片段的原音频已删除，无法回放。');
  await playback.playRange(audioUrl(t.audio),s,`${t.audio.name} · ${time(s.start)}—${time(s.end)}`);
}
$('play-full').onclick=handle(async()=>{const player=$('audio-player');if(!player.getAttribute('src'))throw new Error('尚无可回放录音。');await playback.playFull(player.getAttribute('src'),state.audio?.name||'课堂录音');});
function ensureSaved(){if(drafts.size)throw new Error('保存等待期间又有修改，请先保存最新内容再继续。');}
async function saveAllEdits(){await saveTranscript();await saveReportEdits();await saveCourse();ensureSaved();}
function fullTranscript(){
  const t=transcript();if($('transcript-full-source').value==='original')return originalTranscript(state,t);
  return t?{...t,segments:t.segments.map(s=>({...s,text:drafts.get('segment:'+s.id)??s.text,excluded:drafts.has('excluded:'+s.id)?drafts.get('excluded:'+s.id):s.excluded}))}:null;
}
function renderFullTranscript(){
  const t=fullTranscript();$('transcript-full-text').value=transcriptText(t,{timestamps:$('transcript-full-times').checked});
  $('transcript-full-meta').textContent=t?`${transcriptLabel(t)} · ${t.segments.length}个片段 · 完整文字${drafts.size?'（有未保存修改）':''}`:'尚无此版本的转写。';
  $('export-transcript').disabled=!t;
}
$('transcript-full-source').onchange=renderFullTranscript;$('transcript-full-times').onchange=renderFullTranscript;
$('export-transcript').onclick=handle(async()=>{
  await saveAllEdits();const t=fullTranscript();if(!t)throw new Error('尚无可导出的转写。');
  const header=`完整课堂转写\n课程：${state.course.title||'未命名'}\n录音：${t.audio?.name||'文字记录'}\n转写版本：${t.id}\n片段数：${t.segments.length}\n\n`;
  download('完整课堂转写.txt',header+transcriptText(t,{timestamps:$('transcript-full-times').checked}));
});
async function upload(blob,name,source='upload') {
  if(uploading)throw new Error('已有音频正在上传，请等待或取消后再选择。');
  validateUpload({name,size:blob.size},'audio',limits);
  uploading=new AbortController();$('cancel-audio-upload').hidden=false;$('upload-status').textContent='正在上传 '+name+'…';updateControls();
  try{await saveAllEdits();return await serial(()=>saveAudio(blob,name,source));}
  catch(error){$('save-status').textContent='音频未保存 · 原有数据保留';if(error.name==='AbortError'){try{state=await api('/api/classroom');render();}catch{}}$('upload-status').textContent=error.name==='AbortError'?'已取消上传。已保存的录音未撤销，录音列表已刷新。':error.message;throw error;}
  finally{uploading=null;$('cancel-audio-upload').hidden=true;updateControls();}
}
async function saveAudio(blob,name,source) {
  if(active('transcribe')) throw new Error('当前录音正在转写，完成后再更换。');
  $('save-status').textContent='上传并检查音频中…';
  const result=await uploadBlob(`/api/classroom/audio?name=${encodeURIComponent(name)}&source=${source}&revision=${state.revision}`,blob,{signal:uploading.signal,onProgress:(loaded,total)=>{$('upload-status').textContent=total&&loaded>=total?'音频已传送，正在检查格式与时长…':`已上传 ${(loaded/1024/1024).toFixed(1)} MiB${total?' / '+(total/1024/1024).toFixed(1)+' MiB':''}…`;}});
  state=result;render();$('upload-status').textContent='音频检查通过，完整录音已保存。';notice('完整音频已保存，可回放后启动转写。');
}
async function saveCourse(){const course={title:$('course-title').value,description:$('course-description').value};if(JSON.stringify(course)!==JSON.stringify(state.course))await command('course',{course});}
async function saveTranscript(){const t=transcript();if(!t)return;for(const s of t.segments)if(drafts.has('segment:'+s.id)&&!drafts.get('segment:'+s.id).trim())drafts.set('excluded:'+s.id,true);const segments=t.segments.map(s=>({id:s.id,text:drafts.get('segment:'+s.id)??s.text,excluded:drafts.has('excluded:'+s.id)?drafts.get('excluded:'+s.id):Boolean(s.excluded)}));if(segments.some((s,i)=>s.text!==t.segments[i].text||s.excluded!==Boolean(t.segments[i].excluded)))await command('correct',{transcriptId:t.id,segments});}
function stopTracks(){stream?.getTracks().forEach(t=>t.stop());stream=null;clearInterval(timer);}
async function startRecording(){
  if(uploading || active('transcribe') || active('analysis'))throw new Error('请等待当前任务结束，或暂停任务后再录音。');
  if(recording || requestingMic)return;if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)throw new Error('当前浏览器不支持录音，请使用 Chrome/Safari 的本机地址或上传音频。');
  requestingMic=true;updateControls();$('record-status').textContent='正在请求麦克风权限…';
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}catch(e){throw new Error(e.name==='NotAllowedError'?'麦克风权限被拒绝，请在浏览器设置中允许后重试。':'麦克风不可用，请检查设备或上传录音。');}finally{requestingMic=false;updateControls();}
  try{
    recordFormat=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
    recording=recordFormat?new MediaRecorder(stream,{mimeType:recordFormat}):new MediaRecorder(stream);recordFormat=recording.mimeType;
    recordChunks=[];recordBytes=0;recordLimitHit=false;recordBlob=null;if(recordUrl)URL.revokeObjectURL(recordUrl);
    recording.ondataavailable=e=>{if(e.data.size){recordBytes+=e.data.size;recordChunks.push(e.data);}if(recordBytes>=limits.maxBytes*0.95 && recording?.state==='recording'){recordLimitHit=true;recording.stop();}};
    recording.onerror=()=>{notice('录音设备发生错误，请重试。',true);if(recording?.state!=='inactive')recording.stop();stopTracks();};
    recording.onstop=()=>{stopTracks();recordBlob=new Blob(recordChunks,{type:recordFormat});recordChunks=[];recordUrl=URL.createObjectURL(recordBlob);$('record-playback').src=recordUrl;$('record-playback').hidden=false;$('save-recording').hidden=false;$('record-again').hidden=false;$('record-start').disabled=false;$('record-stop').disabled=true;$('record-status').textContent=(recordLimitHit?'已达到录音限制，自动停止。':'录音已停止，尚未保存。')+'请回放后保存，保存后再转写。';recording=null;render();};
    recording.start(1000);startedAt=Date.now();$('record-start').disabled=true;$('record-stop').disabled=false;$('save-recording').hidden=true;$('record-playback').hidden=true;$('record-again').hidden=true;
    const tick=()=>{const seconds=(Date.now()-startedAt)/1000;$('record-status').textContent='正在录音 · '+time(seconds);if(seconds>=Math.max(0,limits.maxSeconds-1.5) && recording?.state==='recording'){recordLimitHit=true;recording.stop();}};tick();timer=setInterval(tick,Math.min(1000,Math.max(50,limits.maxSeconds*250)));render();
  }catch(e){stopTracks();recording=null;throw new Error('浏览器无法启动录音：'+e.message);}
}
$('record-start').onclick=handle(startRecording);$('record-stop').onclick=()=>{if(recording?.state!=='inactive')recording?.stop();};
$('record-again').onclick=handle(startRecording);
$('discard-recording').onclick=()=>{recordBlob=null;if(recordUrl)URL.revokeObjectURL(recordUrl);recordUrl='';$('record-playback').removeAttribute('src');$('record-playback').hidden=true;$('save-recording').hidden=true;$('record-again').hidden=true;$('record-status').textContent='已放弃未保存的录音，可上传文件或重新录制。';render();};
$('save-recording').onclick=handle(async()=>{if(!recordBlob?.size)throw new Error('录音为空，请重新录制。');await upload(recordBlob,`课堂录音-${new Date().toISOString().replace(/[:.]/g,'-')}.${recordFormat.includes('mp4')?'m4a':recordFormat.includes('ogg')?'ogg':'webm'}`,'recording');recordBlob=null;$('save-recording').hidden=true;$('record-status').textContent='录音已保存，点击启动真实转写。';render();});
$('audio-file').onchange=handle(async()=>{const file=$('audio-file').files[0];try{if(file)await upload(file,file.name);}finally{$('audio-file').value='';}});
$('cancel-audio-upload').onclick=()=>uploading?.abort();
$('save-course').onclick=handle(saveCourse);$('save-transcript').onclick=handle(saveTranscript);
$('transcribe').onclick=handle(async()=>{if(taskStarting)return;if(recording || recordBlob)throw new Error('请先停止并保存当前录音，再启动转写。');taskStarting=true;updateControls();try{await saveAllEdits();state=await api('/api/classroom/transcribe',{revision:state.revision});render();}finally{taskStarting=false;updateControls();}});
async function startAnalysis(mode){
  if(taskStarting)return;
  const request=$('detail-request').value,section=$('detail-section').value;
  taskStarting=true;updateControls();
  try{
    await saveAllEdits();
    state=await api('/api/classroom/analyze',{revision:state.revision,mode,...(mode==='details'?{section,request,reportId:report()?.id}:{})});render();
  }finally{taskStarting=false;updateControls();}
}
$('analyze').onclick=handle(()=>startAnalysis('overview'));
$('analyze-details').onclick=handle(()=>startAnalysis('details'));
$('delete-audio').onclick=handle(async()=>{if(confirm('删除原音频后将无法回放相应转写片段。文字和报告仍保留，报告会标为待更新。确定删除？'))await command('deleteAudio');});
$('clear-classroom').onclick=handle(async()=>{if(confirm('清空本课堂录音、全部转写版本与报告？删除后无法回放。'))await command('clear');});
async function saveReportEdits(){
  const r=report();if(!r)return;
  const edits=[...document.querySelectorAll('[data-report-item]')].filter(card=>drafts.has('report:'+card.dataset.reportItem)).map(card=>({reportId:r.id,section:card.dataset.section,itemId:card.dataset.reportItem,text:card.querySelector('textarea').value}));
  for(const edit of edits)await command('reportItem',edit);
}
$('export-report').onclick=handle(async()=>{
  if(exporting)return;exporting=true;$('export-report').disabled=true;
  try{await saveAllEdits();const revision=state.revision,reportId=report()?.id;
    const response=await fetch(`/api/classroom/report?revision=${revision}&reportId=${encodeURIComponent(reportId)}`);if(!response.ok)throw new Error((await response.json()).error);
    const text=await response.text();ensureSaved();if(state.revision!==revision||report()?.id!==reportId)throw new Error('报告已变化，请重新导出。');download('课堂音频复盘报告.md',text,'text/markdown;charset=utf-8');
  }finally{exporting=false;$('export-report').disabled=!report();}
});
$('confirm-report').onclick=handle(async()=>{await saveAllEdits();await command('confirmReport',{reportId:report().id});});
let chatting=false;
$('classroom-send').onclick=handle(async()=>{
  if(chatting)return;const request=$('classroom-request').value.trim();if(!request)throw new Error('请输入问题或修改要求。');
  chatting=true;$('classroom-send').disabled=true;
  try{await saveAllEdits();const result=await api('/api/classroom/chat',{revision:state.revision,request});state=result.state;if($('classroom-request').value.trim()===request)$('classroom-request').value='';render();}
  finally{chatting=false;$('classroom-send').disabled=false;}
});
$('clear-classroom-conversation').onclick=handle(()=>command('clearConversation'));
$('simplify-transcript').onclick=handle(async()=>{await saveAllEdits();await command('simplifyTranscript',{transcriptId:transcript().id});notice('当前转写已统一为简体，原稿、校正历史和片段时间保留。');});
$('restore-transcript').onclick=handle(async()=>{const transcriptId=$('transcript-history').value;await saveAllEdits();transcriptPage=0;transcriptSearch='';$('transcript-search').value='';await command('selectTranscript',{transcriptId});});
$('restore-audio').onclick=handle(async()=>{const audioId=$('audio-history').value;await saveAllEdits();await command('selectAudio',{audioId});});
$('restore-report').onclick=handle(async()=>{const [reportId,historyId]=$('report-history').value.split(':');await saveAllEdits();await command(historyId?'restoreReportRevision':'selectReport',{reportId,...(historyId?{historyId}:{})});});
$('transcript-search').oninput=()=>{transcriptSearch=$('transcript-search').value.trim();transcriptPage=0;render();};
$('transcript-prev').onclick=()=>{transcriptPage--;render();};$('transcript-next').onclick=()=>{transcriptPage++;render();};
$('jump-transcript').onclick=handle(()=>{const raw=$('transcript-time').value.trim();if(!/^\d+(?::[0-5]?\d){0,2}$/.test(raw))throw new Error('请输入时间，如12:30或1:12:30。');const seconds=raw.split(':').reduce((n,v)=>n*60+Number(v),0),t=transcript();if(!t)throw new Error('尚无转写。');transcriptSearch='';$('transcript-search').value='';const i=t.segments.findIndex(s=>s.end>=seconds);if(i<0)throw new Error('时间超出转写范围。');transcriptPage=Math.floor(i/PAGE_SIZE);render();document.querySelector(`[data-segment="${t.segments[i].id}"]`)?.scrollIntoView({block:'center'});});
async function poll(){
  try{if(!saving && !uploading && !taskStarting && (active('transcribe')||active('analysis'))){const revision=state.revision,next=await api('/api/classroom');if(!saving && !uploading && !taskStarting && revision===state.revision && next.revision>state.revision){state=next;render();}}}catch(e){notice('任务状态读取失败，已有编辑保留：'+e.message,true);}finally{pollTimer=setTimeout(poll,1600);}
}
window.addEventListener('beforeunload',e=>{if(uploading||recording||recordBlob&& !$('save-recording').hidden||dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{stopTracks();clearTimeout(pollTimer);if(recordUrl)URL.revokeObjectURL(recordUrl);});
try{state=await api('/api/classroom');render();poll();}catch(e){$('save-status').textContent='恢复失败';notice(e.message,true);}
try{const status=await api('/api/status');limits=status.audioLimits||{...limits,maxBytes:status.audioMaxBytes||limits.maxBytes};$('audio-limits').textContent=`最多 ${Number((limits.maxBytes/1024/1024).toFixed(2))} MiB、${Number((limits.maxSeconds/3600).toFixed(2))} 小时；需有可解码音轨，内容应与扩展名一致，不接受课堂视频。转写在本机进行。`;}catch(e){notice('音频限制读取失败，请刷新后重试：'+e.message,true);}
