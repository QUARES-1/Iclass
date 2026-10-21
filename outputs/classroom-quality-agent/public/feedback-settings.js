import {$,api,notice,announceConnectionSettings} from './ui.js';
let current,busy=false,dirty=false;
function render(){ $('feedback-base-url').value=current.baseUrl;$('feedback-token').value='';$('feedback-token').disabled=false;$('feedback-clear-token').checked=false;$('feedback-key-status').textContent=current.configured?'已配置，留空保留。':'尚未配置。';$('feedback-settings-fields').disabled=false;dirty=false;}
function payload(){return {revision:current.revision,baseUrl:$('feedback-base-url').value.trim(),accessToken:$('feedback-token').value.trim(),clearToken:$('feedback-clear-token').checked};}
async function run(test){if(busy||!current||!$('feedback-settings-form').reportValidity())return;busy=true;$('feedback-settings-fields').disabled=true;$('feedback-connection-result').textContent=test?'正在测试…':'正在保存…';try{const result=await api('/api/feedback/settings'+(test?'/test':''),payload());if(!test){current=result;render();announceConnectionSettings('feedback',current);}$('feedback-connection-result').textContent=test?'连接成功，当前输入尚未保存。':'问卷连接已保存。';}catch(e){$('feedback-connection-result').textContent=e.message;}finally{busy=false;$('feedback-settings-fields').disabled=false;}}
$('feedback-settings-form').onsubmit=e=>{e.preventDefault();void run(false);};
$('feedback-test-connection').onclick=()=>void run(true);
$('feedback-settings-form').oninput=()=>{dirty=true;};
$('feedback-clear-token').onchange=()=>{if($('feedback-clear-token').checked)$('feedback-token').value='';$('feedback-token').disabled=$('feedback-clear-token').checked;dirty=true;};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
try{current=await api('/api/feedback/settings');render();}catch(e){$('feedback-connection-result').textContent='读取失败：'+e.message;}
