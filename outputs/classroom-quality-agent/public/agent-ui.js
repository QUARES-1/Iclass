import {scopedURL, scopeKey} from './lesson-scope.js';
import { $, esc, api, notice } from './ui.js';

const stageNames = { queued:'正在思考',deciding:'正在思考',reading:'查看内容',planning:'自主规划',retrieving:'读取资料',generating:'分批生成',validating:'校验成果',reviewing:'检查教学目标',repairing:'自动修正',committing:'保存新版本',completed:'执行完成',paused:'已暂停',failed:'暂未完成' };
const watches = new Map(), jobs = new Map();
const terminal = job => ['completed','paused','failed'].includes(job.stage);
const isTask = job => job.mode === 'task' || (!job.mode && Boolean(job.plan));
let activeJob, generation=0, onEnd = async () => {}, onState = () => {}, onProgress = () => {};
export function conversationPending(){return [...watches.values()].some(w => !terminal(w.job) && !isTask(w.job));}
function choosePanel(){
  const values=[...jobs.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)), tasks=values.filter(isTask);
  let job=tasks.find(j=>!terminal(j)) || tasks.at(-1) || null;
  if(job?.stage==='completed' && values.at(-1) && !isTask(values.at(-1)))job=null;
  paintAgent(job);
}
export function agentCallbacks(callbacks){onEnd=callbacks.onEnd;onState=callbacks.onState;onProgress=callbacks.onProgress || onProgress;}
export function resetAgent(){for(const w of watches.values()){clearTimeout(w.timer);w.controller?.abort();}watches.clear();jobs.clear();generation++;paintAgent(null);}
export function renderAgent(job) {
  if(job)jobs.set(job.id,job);
  const values=[...jobs.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const keep=new Set([values.at(-1)?.id,values.filter(isTask).at(-1)?.id]);
  for(const entry of values)if(terminal(entry)&&!keep.has(entry.id))jobs.delete(entry.id);
  choosePanel();
}
function paintAgent(job) {
  const changed=activeJob?.id!==job?.id;
  activeJob = job; const panel = $('agent-progress'); if (!panel) return;
  panel.hidden = !job; if (!job) return;
  if(changed)panel.querySelectorAll('details').forEach(d=>d.open=false);
  const terminal = ['completed','paused','failed'].includes(job.stage);
  $('agent-stage').textContent = stageNames[job.stage] || '执行中';
  $('agent-detail').textContent = job.detail || '正在准备计划';
  $('agent-meter').hidden=!job.totalBatches;
  $('agent-count').textContent = `${job.completedBatches}/${job.totalBatches} 批已完成${job.draftPages ? ' · 草稿 '+job.draftPages+' 页' : ''}`;
  $('agent-meter').max = Math.max(1,job.totalBatches); $('agent-meter').value = job.completedBatches;
  $('agent-pause').hidden = terminal; $('agent-resume').hidden = !['paused','failed'].includes(job.stage);
  $('agent-draft').hidden=!job.draftResources?.length;$('agent-draft').href=scopedURL('/public/agent-draft.html?id='+encodeURIComponent(job.id));
  $('agent-plan').innerHTML = job.plan ? `<p>${esc(job.plan.goal)}</p><ol>${job.plan.steps.map(s=>`<li>${esc(s.title)}${s.minutes?' · '+s.minutes+' 分钟':''}${s.pages?' · 预计 '+s.pages+' 页':''}</li>`).join('')}</ol>` : '<p>本次直接执行，无需展开课程计划。</p>';
  $('agent-observations').innerHTML = job.observations?.length ? job.observations.map(o=>`<li>${esc(o.kind==='tool-result'?'已完成：':'')}${esc(o.text.slice(0,240))}${o.text.length>240?`…<details><summary>完整记录</summary>${esc(o.text)}</details>`:''}</li>`).join('') : '<li>执行记录会随任务更新。</li>';
  $('agent-error').textContent = job.error || ''; $('agent-error').hidden = !job.error;
  $('agent-review').hidden=!job.review;$('agent-issues').innerHTML=job.review?`<p>${esc(job.review.passed?'内容检查通过':'内容检查发现待处理问题')}</p><ul>${job.review.issues.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>${job.review.suggestions?.length?`<p>可选改进建议</p><ul>${job.review.suggestions.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>`:''}`:'';
}
export function watchAgent(job) {
  const previous=watches.get(job.id);if(previous){clearTimeout(previous.timer);previous.controller?.abort();}
  const token=generation, watch={job,timer:null};watches.set(job.id,watch);
  let failures=0;
  const currentWatch=()=>token===generation && watches.get(job.id)===watch;
  renderAgent(job);Promise.resolve(onProgress(job,currentWatch)).catch(e=>notice(e.message,true));
  const poll=async()=>{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);watch.controller=controller;
    try{
      const current=await api('/api/workspace/agent/'+job.id,undefined,{signal:controller.signal});if(!currentWatch())return;
      failures=0;watch.job=current;renderAgent(current);await onProgress(current,currentWatch);
      if(terminal(current)){
        await onEnd(current,currentWatch);
        if(currentWatch())watches.delete(job.id);return;
      }
      watch.timer=setTimeout(poll,900);
    }catch(e){
      if(!currentWatch())return;
      failures++;if(activeJob?.id===job.id)$('agent-detail').textContent='暂时无法读取进度，正在重新连接…';
      if(failures===6)notice('进度连接暂时中断，正在重连；已保存的任务进度保留。',true);
      watch.timer=setTimeout(poll,Math.min(15000,1500*failures));
    }finally{clearTimeout(timeout);if(watch.controller===controller)watch.controller=null;}
  };
  watch.timer=setTimeout(poll,100);
}
$('agent-pause').onclick = async () => {
  if (!activeJob) return; $('agent-pause').disabled = true;
  try { await api('/api/workspace/agent/'+activeJob.id+'/pause',{}); $('agent-detail').textContent='正在暂停，保留已完成草稿…'; }
  catch(e){notice(e.message,true);} finally{$('agent-pause').disabled=false;}
};
$('agent-resume').onclick = async () => {
  if (!activeJob) return; $('agent-resume').disabled = true;
  try { const result=await api('/api/workspace/agent/'+activeJob.id+'/resume',{}); onState(result.workspace); watchAgent(result.job); }
  catch(e){notice(e.message,true);} finally{$('agent-resume').disabled=false;}
};
