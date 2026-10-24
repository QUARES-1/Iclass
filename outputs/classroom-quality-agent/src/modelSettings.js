import { Store, AppError } from './store.js';
import { DEFAULT_PROMPTS, CHAT_CONTRACT, CLASSROOM_CONTRACT } from './prompts.js';

const numericRules = {
  maxTokens: [1, 1000000, true], temperature: [0, 2, false],
  timeoutMs: [5000, 600000, true], maxInputChars: [1000, 2000000, true],
  batchPages: [1, 6, true], maxAgentCalls: [1, 500, true], maxPlanSteps: [1, 300, true], maxRepairs: [0, 99, true],
};
function numberDefault(value, fallback, key) {
  const n = Number(value), [min, max, integer] = numericRules[key];
  return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : fallback;
}
export function environmentSettings(env = process.env) {
  return {
    revision: 0, apiKey: env.LLM_API_KEY || '', baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
    model: env.LLM_MODEL || 'deepseek-chat', maxTokens: numberDefault(env.LLM_MAX_TOKENS, 8000, 'maxTokens'),
    temperature: numberDefault(env.LLM_TEMPERATURE, 0.2, 'temperature'), timeoutMs: numberDefault(env.LLM_TIMEOUT_MS, 90000, 'timeoutMs'),
    maxInputChars: numberDefault(env.LLM_MAX_INPUT_CHARS, 115000, 'maxInputChars'), prompts: { ...DEFAULT_PROMPTS },
    batchPages: 3, maxAgentCalls: 120, maxPlanSteps: 60, maxRepairs: 3,
  };
}
export function validateModelSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('模型配置格式无效。', 400);
  const allowed = ['revision', 'apiKey', 'clearApiKey', 'baseUrl', 'model', ...Object.keys(numericRules), 'prompts'];
  if (Object.keys(patch).some(k => !allowed.includes(k))) throw new AppError('模型配置包含未知字段。', 400);
  const next = { ...current, prompts: { ...current.prompts } };
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string' || patch.baseUrl.length > 2048) throw new AppError('API 基础地址无效。');
    let url;
    try { url = new URL(patch.baseUrl.trim()); } catch { throw new AppError('请输入完整的 HTTP 或 HTTPS API 基础地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError('API 地址须为 HTTP/HTTPS，不能包含账号、密码、查询参数或片段。');
    next.baseUrl = url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !patch.model.trim() || patch.model.length > 200 || /[\x00-\x1f\x7f]/.test(patch.model)) throw new AppError('模型名称为空或格式无效。');
    next.model = patch.model.trim();
  }
  if (patch.clearApiKey !== undefined && typeof patch.clearApiKey !== 'boolean') throw new AppError('清除密钥参数无效。');
  if (patch.apiKey !== undefined && (typeof patch.apiKey !== 'string' || patch.apiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(patch.apiKey))) throw new AppError('API Key 格式无效。');
  if (patch.clearApiKey && patch.apiKey?.trim()) throw new AppError('不能同时替换与清除 API Key。');
  if (patch.clearApiKey) next.apiKey = '';
  else if (patch.apiKey?.trim()) next.apiKey = patch.apiKey.trim(); // Blank means preserve, never a mask.
  for (const [key, [min, max, integer]] of Object.entries(numericRules)) if (patch[key] !== undefined) {
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new AppError(`${key} 须为 ${min}～${max} 范围内的${integer ? '整数' : '数字'}。`);
    next[key] = value;
  }
  if (patch.prompts !== undefined) {
    if (!patch.prompts || typeof patch.prompts !== 'object' || Array.isArray(patch.prompts) || Object.keys(patch.prompts).some(k => !Object.hasOwn(DEFAULT_PROMPTS, k))) throw new AppError('提示词配置格式无效。');
    for (const [key, value] of Object.entries(patch.prompts)) {
      if (typeof value !== 'string' || !value.trim() || value.length > 30000 || value.includes('\0')) throw new AppError('每份提示词须为非空文本，最多 30000 字符。');
      next.prompts[key] = value;
    }
  }
  return next;
}
export class ModelSettings {
  constructor(dataDir, env = process.env) { this.store = new Store(dataDir); this.env = env; }
  async read() {
    const defaults = environmentSettings(this.env), saved = await this.store.read('model-settings', { revision: 0 });
    return { ...defaults, ...saved, prompts: { ...defaults.prompts, ...saved.prompts } };
  }
  public(config) {
    const { apiKey, ...visible } = config;
    return { ...visible, apiKeyConfigured: typeof apiKey === 'string' && Boolean(apiKey.trim()), defaults: { prompts: { ...DEFAULT_PROMPTS } }, contracts: { preparation: CHAT_CONTRACT, classroom: CLASSROOM_CONTRACT } };
  }
  async save(patch) {
    if (!Number.isSafeInteger(patch?.revision) || patch.revision < 0) throw new AppError('模型配置版本参数无效，请刷新设置。', 400);
    return this.store.update('model-settings', patch.revision, environmentSettings(this.env), current => validateModelSettings(current, patch));
  }
}
