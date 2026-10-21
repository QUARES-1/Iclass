import { api } from './ui.js';
let generation = 0;
function render(config) {
  document.getElementById('home-model').textContent = config.apiKeyConfigured && config.model?.trim() ? '当前模型：' + config.model : '模型配置待补齐，可使用向导或进入设置。';
}
window.addEventListener('model-settings-saved', event => { generation++; render(event.detail); });
async function refresh() {
  const current = ++generation;
  try { const config = await api('/api/model-settings', undefined, {signal: AbortSignal.timeout(15000)}); if (current === generation) render(config); }
  catch { if (current === generation) document.getElementById('home-model').textContent = '模型状态暂时无法读取，可进入设置检查。'; }
}
window.addEventListener('storage', event => { if (event.key === 'connection-settings-updated') void refresh(); });
void refresh();
