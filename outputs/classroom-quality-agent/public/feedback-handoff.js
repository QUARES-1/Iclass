import {scopedURL, scopeKey, lessonId} from './lesson-scope.js';
import {api,esc} from './ui.js';
let loading=false;
export async function receiveFeedbackHandoff(){
  const key=new URL(location.href).searchParams.get('feedback');if(!key)return;
  const input=document.getElementById('request');if(!input)return;
  if(loading||document.querySelector('.feedback-handoff-card'))return;
  const initial=input.value;
  let handoff;loading=true;
  const source=new URL(location.href).searchParams.get('sourceLesson');
  const endpoint=source&&source!==lessonId?'/api/lessons/'+encodeURIComponent(source)+'/handoff?id='+encodeURIComponent(key)+'&target='+encodeURIComponent(lessonId):'/api/feedback/handoffs/'+encodeURIComponent(key);
  try{handoff=await api(endpoint,undefined,{signal:AbortSignal.timeout(15000)});}
  catch(e){
    const p=document.createElement('p');p.setAttribute('role','alert');p.textContent='建议载入失败：'+(e.name==='TimeoutError'?'读取超时，请检查连接。':e.message)+' ';
    const retry=document.createElement('button');retry.type='button';retry.textContent='重试载入建议';p.append(retry);input.before(p);
    retry.onclick=()=>{retry.disabled=true;void receiveFeedbackHandoff().finally(()=>p.remove());};return;
  }finally{loading=false;}
  const card=document.createElement('section');card.className='feedback-handoff-card';
  card.innerHTML='<strong>来自课后复盘：'+esc(handoff.title)+'</strong><p>'+esc(handoff.stale?'来源已更新，请核对这些历史建议。':'建议已载入，发送前可修改要求和选择课件。')+'</p>'+
    (handoff.target?'<p>建议目标：'+esc(handoff.target.name)+'。'+(handoff.targetStatus==='missing'?'该课件已不存在，请选择其他课件或新建。':handoff.targetStatus==='changed'?'课件版本已经变化，请核对当前内容。':'请在资源列表核对并选择。')+'不会自动切换当前课件。</p>':'<p>请选择要修改的课件，或明确新建课件。</p>')+
    '<button type="button" data-insert-feedback>插入建议</button><details><summary>查看携带内容</summary><pre style="white-space:pre-wrap;max-height:260px;overflow:auto">'+esc(handoff.request)+'</pre></details>';
  input.before(card);
  const draftKey=scopeKey('feedback-handoff-draft-'+key);
  let previous;try{previous=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(typeof previous?.text!=='string')previous=null;}catch{}
  function persist(){try{sessionStorage.setItem(draftKey,JSON.stringify({text:input.value,loaded:true}));}catch{}}
  if(previous&&input.value===initial&&!initial)input.value=previous.text;
  else if(!previous&&!initial&&input.value===initial){input.value=handoff.request;persist();}
  card.querySelector('[data-insert-feedback]').onclick=()=>{
    if(!input.value.includes(handoff.request))input.value=(input.value.trim()?input.value.trim()+'\n\n':'')+handoff.request;
    input.dispatchEvent(new Event('input',{bubbles:true}));persist();input.focus();
  };
  input.addEventListener('input',persist);persist();
  // A user still sends through the existing form; receiving never submits.
}
