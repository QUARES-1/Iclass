import {$,esc,api,notice,download} from './ui.js';
import {renderCode,bindCodeCopy} from './code-ui.js';
import {toMarkdown} from '../src/pptGenerator.js';
const id=new URLSearchParams(location.search).get('id');let latest;
async function refresh(){
  $('refresh-draft').disabled=true;
  try{
    if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('任务地址无效。');
    latest=await api('/api/workspace/agent/'+id+'/draft');
    $('draft-stage').textContent=latest.job.stage==='completed'?'任务已完成；此处为任务草稿快照':'任务草稿 · 尚未完成最终检查';
    $('draft-detail').textContent=latest.job.error||latest.job.detail||'';
    $('draft-review').hidden=!latest.job.review?.issues?.length&&!latest.job.review?.suggestions?.length;$('draft-issues').innerHTML=(latest.job.review?.issues||[]).map(s=>'<li>'+esc(s)+'</li>').join('')+(latest.job.review?.suggestions||[]).map(s=>'<li>可选建议：'+esc(s)+'</li>').join('');
    $('draft-content').innerHTML=latest.resources.length?latest.resources.map(r=>`<h2>${esc(r.name)}</h2>`+(r.type==='ppt'?r.content.slides.map((s,i)=>`<article class="draft-page"><small>第 ${i+1} 页 · 草稿</small><h3>${esc(s.title)}</h3><ul>${s.bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>${s.example?`<p>示例：${esc(s.example)}</p>`:''}${renderCode(s.code,s.id)}${s.counterExample?`<p>反例：${esc(s.counterExample)}</p>`:''}<details><summary>教师备注</summary><pre>${esc(s.notes.join('\n'))}</pre></details></article>`).join(''):`<article class="draft-page"><h3>${esc(r.content.title)}</h3><p>${esc(r.content.description)}</p><p class="muted">互动资源完成后请回工作台实际试玩。</p></article>`)).join(''):'<p>还没有完成的生成批次。</p>';
    bindCodeCopy(latest.resources.flatMap(r=>r.type==='ppt'?r.content.slides:[]));
    $('download-draft').disabled=!latest.resources.some(r=>r.type==='ppt');notice('');
  }catch(e){notice(e.message,true);}finally{$('refresh-draft').disabled=false;}
}
$('refresh-draft').onclick=refresh;
$('download-draft').onclick=()=>download('备课任务-'+id.slice(0,8)+'-未确认草稿.md','# 备课任务草稿（未确认）\n\n'+latest.resources.filter(r=>r.type==='ppt').map(r=>'## '+r.name+'\n\n'+toMarkdown(r.content.slides,{confirmedOnly:false})).join('\n\n'),'text/markdown;charset=utf-8');
await refresh();
