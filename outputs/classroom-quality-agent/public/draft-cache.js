import {scopeKey} from './lesson-scope.js';
// Browser drafts are separate from saved teaching content and contain no settings.
export function createDraftCache(scope,{capture,apply,fingerprint,onError=()=>{}}){
  scope=scopeKey(scope);
  let tab;try{tab=sessionStorage.getItem('draft-tab');if(!tab){tab=crypto.randomUUID();sessionStorage.setItem('draft-tab',tab);}}catch{tab=crypto.randomUUID();}
  const key=scope+':'+tab,journal='teaching-draft:'+key;let db,ready=false,pending=null,writing=false,failed=false,banner,edits=0,stamp=0;
  const warn=()=>{if(!failed){failed=true;onError('浏览器草稿缓存不可用，请手动保存当前编辑。');}};
  const open=()=>db||=(new Promise((resolve,reject)=>{const request=indexedDB.open('teaching-drafts',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('草稿缓存被占用'));}));
  async function transaction(mode,run){const connection=await open();return new Promise((resolve,reject)=>{const tx=connection.transaction('drafts',mode),result=run(tx.objectStore('drafts'));tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function drain(){if(writing)return;writing=true;try{while(pending){const next=pending;pending=null;await transaction('readwrite',store=>next.empty?store.delete(key):store.put(next));if(next.empty){try{const cached=JSON.parse(localStorage.getItem(journal)||'null');if(cached?.updatedAt<=next.updatedAt)localStorage.removeItem(journal);}catch{}}}}catch{warn();}finally{writing=false;}}
  function save(){
    if(!ready)return;const data=capture(),empty=!data.entries.length&&!Object.values(data.fields).some(Boolean),record={...data,key,scope,base:fingerprint(),updatedAt:stamp=Math.max(Date.now(),stamp+1),empty};
    try{const text=JSON.stringify(record);if(text.length>4*1024**2){warn();return;}if(text.length<=200000)localStorage.setItem(journal,text);else localStorage.removeItem(journal);}catch{warn();}
    pending=record;void drain();
  }
  function show(record){
    banner?.remove();banner=document.createElement('section');banner.className='panel';banner.setAttribute('role','status');
    const label=document.createElement('p');label.textContent='发现未保存草稿，来源版本或浏览器标签页已变化。可恢复到当前编辑区核对，已有新输入优先保留。';banner.append(label);
    for(const [name,action]of [['恢复草稿',()=>{const result=apply(record);if(result?.skipped){label.textContent=`已恢复可匹配的编辑；${result.skipped} 项内容无法匹配原页面或片段，可下载原草稿查看。`;banner.querySelector('button').disabled=true;}else banner.remove();save();}],['下载草稿',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='未保存草稿.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}],['丢弃此草稿',()=>{void transaction('readwrite',store=>store.delete(record.key));try{localStorage.removeItem('teaching-draft:'+record.key);}catch{}banner.remove();}]]){const button=document.createElement('button');button.type='button';button.textContent=name;button.onclick=action;banner.append(button);}
    document.getElementById('notice').after(banner);
  }
  async function restore(){
    const before=edits;let records=[];
    try{records=await transaction('readonly',store=>store.getAll());}catch{warn();}
    try{const cached=JSON.parse(localStorage.getItem(journal)||'null');if(cached)records.push(cached);}catch{}
    const latest=new Map();for(const record of records)if(!latest.has(record.key)||latest.get(record.key).updatedAt<=record.updatedAt)latest.set(record.key,record);
    const candidates=[...latest.values()].filter(r=>r.scope===scope&&!r.empty&&Array.isArray(r.entries)&&r.fields&&typeof r.base==='string').sort((a,b)=>(b.key===key)-(a.key===key)||b.updatedAt-a.updatedAt),record=candidates[0];stamp=Math.max(0,...records.map(r=>Number(r.updatedAt)||0));
    ready=true;
    if(record){if(record.key===key&&record.base===fingerprint()&&before===edits)apply(record);else{if(record.key===key){record.key=scope+':recovery:'+crypto.randomUUID();try{await transaction('readwrite',store=>store.put(record));}catch{warn();}}show(record);}}
  }
  document.addEventListener('input',()=>{edits++;queueMicrotask(save);});document.addEventListener('change',()=>queueMicrotask(save));
  window.addEventListener('pagehide',save);
  return {save,restore};
}
export async function clearBrowserDrafts(){
  await new Promise((resolve,reject)=>{const request=indexedDB.open('teaching-drafts',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'key'});request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').clear();tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};};});
  for(const key of Object.keys(localStorage))if(key.startsWith('teaching-draft:'))localStorage.removeItem(key);
}
