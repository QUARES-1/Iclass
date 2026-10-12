export const $ = id => document.getElementById(id);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function notice(text, error = false) { $('notice').hidden = !text; $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
export async function api(url, data, options = {}) {
  const response = await fetch(url, data === undefined ? options : { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), ...options });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '请求失败，请重试。'); error.state = result.state; error.status = response.status; throw error; }
  return result;
}
export function download(name, body, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([body], {type})), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 15000);
}
export function saved(state) { $('save-status').textContent = state.savedAt ? '已保存 · ' + new Date(state.savedAt).toLocaleTimeString() : '已恢复 · 尚无修改'; }
export function time(seconds) { const t = Math.max(0, Math.floor(Number(seconds) || 0)); return (Math.floor(t / 3600) ? Math.floor(t / 3600) + ':' : '') + String(Math.floor(t / 60) % 60).padStart(2,'0') + ':' + String(t % 60).padStart(2,'0'); }
export function originalTranscript(state, current) {
  const versions=new Map(state.transcriptVersions.map(t=>[t.id,t])), seen=new Set();
  for(let t=current;t && t.audioId===current.audioId && !seen.has(t.id);t=versions.get(t.parentId)) {
    if(t.source==='asr')return t;
    seen.add(t.id);
  }
}

// Preserve the user's editing position across a saved-state redraw.
function viewKey(el){
  if(el.id)return 'id:'+el.id;
  if(el.dataset.field)return 'slide:'+el.closest('[data-slide]')?.dataset.slide+':'+el.dataset.field;
  if(el.dataset.segment)return 'segment:'+el.dataset.segment;
  if(el.closest('[data-report-item]') && el.tagName==='TEXTAREA')return 'report:'+el.closest('[data-report-item]').dataset.reportItem;
  if(el.dataset.resource)return 'resource:'+el.dataset.resource;
}
function detailsKey(el){return el.id || (el.closest('[data-report-item]')?.dataset.reportItem ? el.closest('[data-report-item]').dataset.reportItem+':'+el.querySelector(':scope > summary')?.textContent : null) || el.closest('[data-slide]')?.dataset.slide || el.closest('[data-material]')?.dataset.material || el.querySelector(':scope > summary')?.textContent.trim().replace(/\s+\d+$/,'');}
export function captureView(){
  const active=document.activeElement,key=active && viewKey(active),selection=typeof active?.selectionStart==='number'?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
  const details=new Map([...document.querySelectorAll('details')].map(el=>[detailsKey(el),el.open]));
  const positions=['.sources','.chat','#messages','#transcript','#original-transcript'].map(selector=>[selector,document.querySelector(selector)?.scrollTop]);
  const x=window.scrollX,y=window.scrollY;
  return ()=>{
    for(const el of document.querySelectorAll('details'))if(details.has(detailsKey(el)))el.open=details.get(detailsKey(el));
    if(key){const el=[...document.querySelectorAll('input,textarea,button,select')].find(el=>viewKey(el)===key);if(el){el.focus({preventScroll:true});if(selection)el.setSelectionRange?.(...selection);}}
    for(const [selector,top] of positions)if(top!==undefined){const el=document.querySelector(selector);if(el)el.scrollTop=top;}
    window.scrollTo(x,y);
  };
}

export function uploadBlob(url,blob,{signal,onProgress=()=>{}}={}){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),abort=()=>xhr.abort();
    const finish=(fn,value)=>{signal?.removeEventListener('abort',abort);fn(value);};
    xhr.open('POST',url);xhr.responseType='json';
    xhr.upload.onprogress=event=>onProgress(event.loaded,event.lengthComputable?event.total:null);
    xhr.onload=()=>{const data=xhr.response;if(xhr.status>=200&&xhr.status<300 && data)finish(resolve,data);else{const error=new Error(data?.error||'上传失败，请重试。');error.status=xhr.status;finish(reject,error);}};
    xhr.onerror=()=>finish(reject,new Error('上传连接中断，原有数据保留，请检查服务后重试。'));
    xhr.onabort=()=>{const error=new Error('已取消上传。');error.name='AbortError';finish(reject,error);};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){const error=new Error('已取消上传。');error.name='AbortError';finish(reject,error);return;}xhr.send(blob);
  });
}
