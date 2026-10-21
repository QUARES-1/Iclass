import {api, announceConnectionSettings} from './ui.js';

const includeFeedback = /\/(?:home|sprint3)\.html$/.test(location.pathname) || location.pathname === '/';
const items = [
  {id: 'model', name: 'AI 模型', endpoint: '/api/model-settings', flag: 'model-setup-skipped'},
  ...(includeFeedback ? [{id: 'feedback', name: '金数据问卷', endpoint: '/api/feedback/settings', flag: 'feedback-setup-skipped'}] : []),
];
const drafts = new Map();
let dialog, banner, active, busy = false, detecting, controller, returnFocus;
const get = id => dialog.querySelector('#setup-' + id);
function skipped(item) { try { return Boolean(sessionStorage.getItem(item.flag)); } catch { return false; } }
function remember(item, value) { try { value ? sessionStorage.setItem(item.flag, '1') : sessionStorage.removeItem(item.flag); } catch {} }
function validURL(value) {
  try {
    const url = new URL(value);
    return value.length <= 2048 && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function hasKey(item) { return item.id === 'model' ? item.config?.apiKeyConfigured : item.config?.configured; }
function validModel(value) { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value); }
function missing(item) {
  if (!item.config) return [];
  const fields = [];
  if (!validURL(item.config.baseUrl || '')) fields.push('API 地址');
  if (item.id === 'model' && !validModel(item.config.model)) fields.push('模型名称');
  if (!hasKey(item)) fields.push(item.id === 'model' ? 'API Key' : 'Access Token');
  return fields;
}
const pending = () => items.filter(item => item.error || missing(item).length);
function stash() {
  if (active?.config) drafts.set(active.id, {baseUrl: get('url').value, model: get('model').value, key: get('key').value});
}
function mountBanner() {
  if (banner) return;
  banner = document.createElement('section');
  banner.className = 'setup-reminder'; banner.hidden = true; banner.setAttribute('aria-label', '使用配置');
  banner.innerHTML = '<p role="status"></p><button type="button">补齐配置</button>';
  (document.querySelector('header') || document.body.firstElementChild).after(banner);
  banner.querySelector('button').onclick = () => void detect(true);
}
function updateBanner() {
  mountBanner();
  const list = pending();
  banner.hidden = !list.length;
  banner.querySelector('p').textContent = list.map(item => item.error ? item.name + '配置未能读取' : item.name + (item.id === 'feedback' ? '（可选）' : '') + '待补齐：' + missing(item).join('、')).join('；');
}
function mount() {
  if (dialog) return;
  dialog = document.createElement('dialog'); dialog.className = 'api-setup';
  dialog.setAttribute('aria-labelledby', 'setup-title'); dialog.setAttribute('aria-describedby', 'setup-intro');
  dialog.innerHTML = `<form id="setup-form">
    <p id="setup-progress" class="muted"></p><h2 id="setup-title" tabindex="-1">完善使用配置</h2>
    <p id="setup-intro"></p><p id="setup-missing" class="setup-missing"></p>
    <fieldset id="setup-fields">
      <label>API 地址<input id="setup-url" type="url" required maxlength="2048" autocomplete="url" spellcheck="false"><small id="setup-url-help"></small></label>
      <label id="setup-model-label">模型名称<input id="setup-model" required maxlength="200" spellcheck="false" placeholder="填写服务商提供的模型 ID"></label>
      <label id="setup-key-label"><span id="setup-key-name">API Key</span><input id="setup-key" type="password" maxlength="4096" autocomplete="off" spellcheck="false"><small id="setup-key-help"></small></label>
      <button type="button" id="setup-show-key" class="quiet" aria-pressed="false">显示本次输入</button>
      <p class="muted">密钥保存在本机服务端，已保存的值不回显。测试连接不会自动保存。</p>
      <div class="actions"><button type="button" id="setup-test">测试连接</button><button id="setup-save" class="primary" type="submit">保存并继续</button></div>
    </fieldset>
    <p id="setup-status" role="status" aria-live="polite"></p>
    <button type="button" id="setup-cancel-request" hidden>取消测试</button>
    <button type="button" id="setup-retry" hidden>重新检测（保留输入）</button>
    <div class="actions setup-footer"><button id="setup-skip" type="button">稍后配置</button><a id="setup-full-settings" href="./settings.html">完整设置</a></div>
  </form>`;
  document.body.append(dialog);
  get('skip').onclick = () => {
    if (busy) return;
    for (const item of pending()) remember(item, true);
    close();
  };
  dialog.oncancel = event => { event.preventDefault(); if (!busy) get('skip').click(); };
  get('form').onsubmit = event => { event.preventDefault(); void run(true); };
  get('test').onclick = () => void run(false);
  get('retry').onclick = () => void detect(true);
  get('cancel-request').onclick = () => controller?.abort();
  get('show-key').onclick = () => {
    const visible = get('key').type === 'password'; get('key').type = visible ? 'text' : 'password';
    get('show-key').textContent = visible ? '隐藏本次输入' : '显示本次输入'; get('show-key').setAttribute('aria-pressed', String(visible));
  };
  get('fields').oninput = () => { get('status').textContent = '输入已修改，尚未保存。'; };
}
function lock(value, testing = false) {
  busy = value; get('fields').disabled = value || !active?.config || Boolean(active?.error);
  get('skip').disabled = value; get('retry').disabled = value;
  get('full-settings').hidden = value; get('cancel-request').hidden = !testing;
  dialog.setAttribute('aria-busy', String(value));
}
function show(item) {
  mount(); active = item;
  const model = item.id === 'model', draft = drafts.get(item.id), list = pending();
  get('progress').textContent = list.length > 1 ? `待配置 ${list.length} 项 · 先完成${item.name}` : '使用配置';
  get('title').textContent = model ? '连接 AI 模型' : '连接金数据问卷（可选）';
  get('intro').textContent = model ? '用于 AI 对话、生成课件和课堂总结。请填写所用服务商的连接信息。' : '用于在线发布问卷和同步学生反馈。暂不连接也能编辑模板、导入反馈和查看统计。';
  get('missing').textContent = item.error ? '配置读取失败，请检查本机服务后重新检测。' : missing(item).length ? '待补齐：' + missing(item).join('、') : '已更新配置状态。你的输入仍保留，可确认后重新保存。';
  get('url').value = draft?.baseUrl ?? item.config?.baseUrl ?? '';
  get('url').placeholder = model ? 'https://api.example.com/v1' : 'https://jinshuju.net/api/v1';
  get('url-help').textContent = model ? '填写兼容 Chat Completions 的基础地址，通常由服务商提供。' : '金数据 API 地址一般保持默认值。';
  get('model-label').hidden = !model; get('model').disabled = !model; get('model').required = model;
  get('model').value = draft?.model ?? (model ? item.config?.model ?? '' : '');
  get('key-name').textContent = model ? 'API Key' : 'Access Token';
  get('key').value = draft?.key ?? ''; get('key').required = !hasKey(item); get('key').type = 'password';
  get('key').placeholder = hasKey(item) ? '已配置，留空保留' : model ? '填写模型服务商的 API Key' : '填写金数据个人 Access Token';
  get('key-help').textContent = hasKey(item) ? '已有密钥，留空即可保留；仅需补齐上方缺失内容。' : model ? '在模型服务商的控制台创建密钥。' : '在金数据“个人中心 → API”创建个人 Access Token，与模型密钥不同。';
  get('show-key').textContent = '显示本次输入'; get('show-key').setAttribute('aria-pressed', 'false');
  get('status').textContent = ''; get('retry').hidden = !item.error;
  get('full-settings').href = './settings.html' + (model ? '#model-form' : '#feedback-settings-form');
  get('save').textContent = list.length > 1 ? '保存并继续' : '保存并开始';
  lock(false);
  if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
  (item.error ? get('title') : !validURL(get('url').value) ? get('url') : model && !validModel(get('model').value) ? get('model') : !hasKey(item) ? get('key') : get('title')).focus({preventScroll: true});
  dialog.scrollTop = 0;
}
function close() {
  drafts.clear(); get('key').value = ''; get('key').type = 'password'; dialog.close(); active = null;
  lock(false);
  if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
  updateBanner();
}
async function detect(manual = false) {
  if (busy || detecting) return detecting;
  if (dialog?.open && !manual) return;
  if (dialog?.open) stash();
  detecting = (async () => {
    if (dialog?.open) lock(true);
    const results = await Promise.allSettled(items.map(item => api(item.endpoint, undefined, {signal: AbortSignal.timeout(15000)})));
    results.forEach((result, index) => {
      const item = items[index];
      item.error = result.status === 'rejected' || !result.value || typeof result.value !== 'object' || Array.isArray(result.value) || !Number.isSafeInteger(result.value.revision) || result.value.revision < 0;
      if (!item.error) { item.config = result.value; if (!missing(item).length) remember(item, false); }
    });
    updateBanner();
    const next = manual && active && drafts.has(active.id) ? active : pending().find(item => manual || !skipped(item));
    if (next) show(next); else if (dialog?.open) close();
  })();
  try { await detecting; } finally { detecting = null; }
}
async function run(save) {
  if (busy || !active?.config || !get('form').reportValidity()) return;
  const item = active, model = item.id === 'model', key = get('key').value.trim();
  if (!key && !hasKey(item)) { get('status').textContent = '请输入' + (model ? ' API Key。' : ' Access Token。'); get('key').focus(); return; }
  const baseUrl = get('url').value.trim();
  if (!validURL(baseUrl)) { get('status').textContent = '请输入 HTTP 或 HTTPS 基础地址，不能包含账号、密码、查询参数或片段。'; get('url').focus(); return; }
  if (model && !validModel(get('model').value)) { get('status').textContent = '请输入有效模型名称，最多 200 个字符。'; get('model').focus(); return; }
  const payload = {revision: item.config.revision, baseUrl, ...(model ? {model: get('model').value.trim(), apiKey: key} : {accessToken: key})};
  controller = new AbortController();
  const timeout = AbortSignal.timeout(save ? 15000 : Math.min(item.config.timeoutMs || 90000, 120000) + 5000);
  lock(true, !save); get('status').textContent = save ? '正在保存…' : '正在测试连接，可取消等待…';
  try {
    const result = await api(item.endpoint + (save ? '' : '/test'), payload, {signal: AbortSignal.any([controller.signal, timeout])});
    if (!save) { get('status').textContent = '连接成功，点击“' + get('save').textContent + '”使配置生效。'; return; }
    item.config = result; item.error = false; drafts.delete(item.id); get('key').value = ''; remember(item, false);
    announceConnectionSettings(item.id, result);
    updateBanner();
    const next = pending().find(candidate => !skipped(candidate));
    if (next) show(next); else close();
  } catch (error) {
    get('status').textContent = controller.signal.aborted ? '已取消测试，输入仍保留。' : timeout.aborted ? (save ? '保存响应超时，请重新检测确认状态，输入仍保留。' : '连接测试超时，输入仍保留，可重试。') : save && !error.status ? '未能确认保存结果，请重新检测配置状态，输入仍保留。' : error.message;
    if (error.status === 409 || (save && (!error.status || timeout.aborted))) { item.error = true; get('retry').hidden = false; }
  } finally { controller = null; lock(false); }
}
window.addEventListener('focus', () => void detect());
window.addEventListener('pageshow', event => { if (event.persisted) void detect(); });
window.addEventListener('storage', event => { if (event.key === 'connection-settings-updated') void detect(); });
void detect();
