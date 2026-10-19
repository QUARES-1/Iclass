// 金数据 Webhook（数据推送）解析与校验。
// 官方格式：POST JSON，请求头 X-Requested-By: jinshuju。
// 参考：https://open.jinshuju.net/webhook/data_format

export class JinshujuWebhookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JinshujuWebhookError';
  }
}

export function verifyJinshujuWebhook(headers = {}) {
  const requestedBy = headers['x-requested-by'] ?? headers['X-Requested-By'];
  if (requestedBy !== 'jinshuju') {
    throw new JinshujuWebhookError('非金数据推送：缺少 X-Requested-By: jinshuju 请求头。');
  }
  return true;
}

export function parseWebhookBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new JinshujuWebhookError('Webhook body 必须是 JSON 对象。');
  }
  if (typeof body.form !== 'string' || !body.form) {
    throw new JinshujuWebhookError('Webhook body 缺少 form（表单 Token）。');
  }
  if (!body.entry || typeof body.entry !== 'object' || Array.isArray(body.entry)) {
    throw new JinshujuWebhookError('Webhook body 缺少 entry（数据详情）。');
  }
  return {
    formToken: body.form,
    formName: typeof body.form_name === 'string' ? body.form_name : '',
    entry: body.entry,
  };
}

// 接收原始请求体与请求头，返回 { formToken, formName, entry }。
// 建议在生产环境再叠加来源 IP 白名单（见 outbound_ip_list 文档）。
export function handleWebhook(rawBody, headers = {}) {
  let body = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new JinshujuWebhookError('Webhook body 不是合法 JSON。');
    }
  }
  verifyJinshujuWebhook(headers);
  return parseWebhookBody(body);
}
