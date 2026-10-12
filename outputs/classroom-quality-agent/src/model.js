import { extractJson } from './llm.js';
import { AppError } from './store.js';
import { currentVersion } from './workspace.js';
import { DEFAULT_PROMPTS, CHAT_CONTRACT } from './prompts.js';
export { ACTIVITY_SCHEMA } from './prompts.js';

export async function requestJSON(system, input, config = {}) {
  const key = config.apiKey ?? process.env.LLM_API_KEY;
  if (!key) throw new AppError('尚未配置文本模型。请打开“模型与提示词设置”填写 API Key；已有成果保留，可稍后重试。', 503);
  const user = JSON.stringify(input);
  const maxInputChars = config.maxInputChars ?? 115000;
  const inputChars = user.length + system.length;
  if (inputChars > maxInputChars) throw new AppError(`本次上下文为 ${inputChars} 字符，超过设置中的 ${maxInputChars} 字符输入额度。可调整模型设置或分章节处理；未截断资料。`, 413);
  try {
    const response = await (config.fetch || fetch)((config.baseUrl || process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(Number(config.timeoutMs ?? process.env.LLM_TIMEOUT_MS) || 90000)]) : AbortSignal.timeout(Number(config.timeoutMs ?? process.env.LLM_TIMEOUT_MS) || 90000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: config.model || process.env.LLM_MODEL || 'deepseek-chat', temperature: config.temperature ?? 0.2, max_tokens: config.maxTokens ?? 8000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!response.ok) { const error = new AppError('文本模型请求失败（HTTP ' + response.status + '）。', 502); error.code = 'MODEL_HTTP_' + response.status; throw error; }
    const result = await response.json();
    if (result.choices?.[0]?.finish_reason === 'length') { const error = new AppError('模型本次输出未完整返回，智能体将缩小生成批次。', 502); error.code = 'MODEL_LENGTH'; throw error; }
    const choice = result.choices?.[0], content = choice?.message?.content;
    const value = extractJson(content);
    if (!value) {
      const reason = typeof content !== 'string' || !content.trim() ? 'empty' : content.trim().startsWith('[') ? 'array' : 'invalid-json';
      const error = new AppError('模型未返回有效结构，未修改原成果。请返回完整 JSON 对象，正确转义字符串中的换行、双引号和反斜杠；不要使用 Markdown 代码围栏，也不要截断或省略字段。', 502);
      error.code = 'MODEL_FORMAT'; error.details = {reason,responseCharacters:typeof content==='string'?content.length:0,finishReason:choice?.finish_reason??null}; throw error;
    }
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (config.signal?.aborted) { const paused = new AppError('任务已暂停，已完成的草稿保留。', 499); paused.code = 'AGENT_PAUSED'; throw paused; }
    throw new AppError(['TimeoutError', 'AbortError'].includes(error.name) ? '文本模型超时，请重试。' : '文本模型无法连接，请检查模型设置与网络。', 503);
  }
}
export async function generateChatCandidate(state, request, resourceId, pageId, call = requestJSON, config = {}) {
  const resource = state.resources.find(r => r.id === resourceId), v = currentVersion(resource);
  const match = request.match(/第\s*(\d+)\s*页/);
  let scopeIds = null;
  if (resource?.type === 'ppt' && match) {
    const slide = v.content.slides[Number(match[1]) - 1];
    if (!slide) return { action: 'clarify', reply: '指定页码不存在，请选择有效页面。' };
    scopeIds = [slide.id];
  } else if (resource?.type === 'ppt' && pageId) scopeIds = [pageId];
  const result = await call((config.prompts?.preparation ?? DEFAULT_PROMPTS.preparation) + '\n\n' + CHAT_CONTRACT, {
    request, requirements: state.requirements, materials: state.materials.filter(m => m.status === 'parsed'), failedMaterials: state.materials.filter(m => m.status === 'failed').map(m => ({title:m.title,error:m.error})), analysis: state.analysis, analysisSource: state.analysisSource || null, supplements: state.supplements,
    recentConversation: state.messages.slice(-30).map(m => ({ role: m.role, text: m.text, status: m.status })),
    resource: resource ? { id: resource.id, type: resource.type, name: resource.name, versionId: v.id, content: v.content } : null,
    resources: state.resources.map(r => ({ id: r.id, name: r.name, type: r.type, pages: r.type === 'ppt' ? currentVersion(r).content.slides.map((s, i) => ({ id: s.id, page: i + 1, title: s.title })) : undefined })), scopeIds,
  }, config);
  if (!result || !['clarify', 'advice', 'create', 'update', 'attach'].includes(result.action) || typeof result.reply !== 'string') throw new AppError('AI 操作结构无效，原成果保留。', 502);
  if (result.action === 'update' && !resource) throw new AppError('没有选中的资源，请先选择或新建。');
  return { ...result, scopeIds };
}
