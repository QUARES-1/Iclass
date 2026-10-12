import {esc,notice} from './ui.js';
export function renderCode(code,id){
  if(!code)return '';
  return `<section class="code-block"><div class="code-heading"><span>${esc(code.kind==='output'?'预期运行输出':code.language+' 示例代码')}${code.parts>1?' · 第 '+code.part+'/'+code.parts+' 段':''}</span><button type="button" data-copy-code="${esc(id)}">${code.kind==='output'?'复制输出':'复制完整代码'}</button></div><pre><code>${esc(code.source)}</code></pre>${code.expectedOutput?`<p>预期运行输出</p><pre>${esc(code.expectedOutput)}</pre>`:''}</section>`;
}
export function bindCodeCopy(slides,root=document){
  root.querySelectorAll('[data-copy-code]').forEach(button=>button.onclick=async()=>{
    const page=slides.find(s=>s.id===button.dataset.copyCode);if(!page?.code)return;
    const code=page.code,parts=code.blockId?slides.filter(s=>s.status!=='deleted'&&s.code?.blockId===code.blockId&&(s.code.kind==='output')===(code.kind==='output')):[page];
    const source=parts.map(s=>s.code.source).join('');
    try{await navigator.clipboard.writeText(source);notice(code.kind==='output'?'已复制运行输出。':'已复制完整示例代码。');}
    catch{notice('无法访问剪贴板，请在代码块中选中并复制。',true);}
  });
}
