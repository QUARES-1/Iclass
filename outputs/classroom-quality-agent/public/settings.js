import { $, api, notice, announceConnectionSettings } from './ui.js';

let settings, busy = false, dirty = false;
const promptKeys = ['agent','preparation', 'materials', 'classroom', 'outline', 'feedback', 'feedbackSummary', 'feedbackSuggestions'];
function changed() { dirty = true; $('save-status').textContent = '有未保存配置'; $('test-result').textContent = '配置已修改，尚未测试当前内容。'; }
function render() {
  $('base-url').value = settings.baseUrl; $('model').value = settings.model;
  $('api-key').value = ''; $('api-key').disabled = false; $('api-key').type = 'password'; $('show-key').textContent = '显示本次输入'; $('clear-key').checked = false;
  $('key-status').textContent = settings.apiKeyConfigured ? '已配置密钥；输入新值可替换，留空保留。' : '尚未配置密钥，请填写。';
  $('max-tokens').value = settings.maxTokens; $('temperature').value = settings.temperature;
  $('timeout-seconds').value = settings.timeoutMs / 1000; $('max-input-chars').value = settings.maxInputChars;
  for(const [key,id] of Object.entries({batchPages:'batch-pages',maxAgentCalls:'max-agent-calls',maxPlanSteps:'max-plan-steps',maxRepairs:'max-repairs'})) $(id).value=settings[key];
  for (const key of promptKeys) $('prompt-' + key).value = settings.prompts[key];
  for (const [key, value] of Object.entries(settings.contracts)) $('contract-' + key).textContent = value;
  $('settings-fields').disabled = false; dirty = false;
  $('save-status').textContent = settings.savedAt ? '已保存 · ' + new Date(settings.savedAt).toLocaleTimeString() : '当前使用初始配置';
}
function payload() {
  return { revision: settings.revision, baseUrl: $('base-url').value.trim(), model: $('model').value.trim(), apiKey: $('api-key').value.trim(), clearApiKey: $('clear-key').checked,
    maxTokens: Number($('max-tokens').value), temperature: Number($('temperature').value), timeoutMs: Number($('timeout-seconds').value) * 1000,
    maxInputChars: Number($('max-input-chars').value),batchPages:Number($('batch-pages').value),maxAgentCalls:Number($('max-agent-calls').value),maxPlanSteps:Number($('max-plan-steps').value),maxRepairs:Number($('max-repairs').value), prompts: Object.fromEntries(promptKeys.map(key => [key, $('prompt-' + key).value])) };
}
async function run(task) {
  if (busy || !settings) return;
  busy = true; $('settings-fields').disabled = true; notice('');
  try { await task(); } catch (e) { notice(e.message, true); $('save-status').textContent = dirty ? '保存或测试失败 · 修改仍保留' : '操作失败'; }
  finally { busy = false; $('settings-fields').disabled = false; }
}
$('model-form').oninput = changed;
$('model-form').onsubmit = event => {
  event.preventDefault();
  const patch = payload();
  void run(async () => { $('save-status').textContent = '正在保存…'; settings = await api('/api/model-settings', patch); render(); announceConnectionSettings('model', settings); $('test-result').textContent = '配置已保存；下一次 AI 请求会使用这份配置。'; notice('模型与提示词已保存并生效。'); });
};
$('test-model').onclick = () => {
  if (!$('model-form').reportValidity()) return;
  const patch = payload();
  void run(async () => {
    $('test-result').textContent = '正在测试模型连接…';
    try { const result = await api('/api/model-settings/test', patch); $('test-result').textContent = `${result.model} 连接成功，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒。${dirty ? '当前修改尚未保存。' : ''}`; }
    catch (e) { $('test-result').textContent = '连接测试失败：' + e.message; throw e; }
  });
};
$('reload-model').onclick = () => {
  if (dirty && !confirm('重新载入会丢弃此页面未保存的配置修改，继续吗？')) return;
  void run(async () => { settings = await api('/api/model-settings'); render(); $('test-result').textContent = '已重新载入保存的配置。'; });
};
$('show-key').onclick = () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? '隐藏本次输入' : '显示本次输入'; };
document.querySelectorAll('[data-reset]').forEach(button => button.onclick = () => { const key = button.dataset.reset; $('prompt-' + key).value = settings.defaults.prompts[key]; changed(); notice('此提示词已恢复默认值，保存后生效。'); });
$('clear-key').onchange = () => { if ($('clear-key').checked) { $('api-key').value = ''; $('api-key').disabled = true; } else $('api-key').disabled = false; changed(); };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
try { settings = await api('/api/model-settings'); render(); } catch (e) { notice('配置读取失败：' + e.message + '。请刷新后重试。', true); $('save-status').textContent = '配置读取失败'; }
