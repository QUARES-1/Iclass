// 金数据（Jinshuju）API v1 客户端。
// 官方文档：https://open.jinshuju.net/api_v1
// 鉴权：Authorization: Bearer ACCESS_TOKEN；请求头 Content-Type / Accept 均为 application/json。

const DEFAULT_BASE_URL = 'https://jinshuju.net/api/v1';

export class JinshujuError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JinshujuError';
    this.status = options.status ?? null;
    this.body = options.body ?? null;
    this.method = options.method ?? null;
    this.url = options.url ?? null;
    this.cause = options.cause;
  }
}

function encodeQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // filters / sort / fields 支持 JSON 数组；数组统一序列化为 JSON 字符串。
    params.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

export class JinshujuClient {
  constructor(options = {}) {
    const accessToken = options.accessToken ?? process.env.JINSHUJU_ACCESS_TOKEN ?? '';
    if (!accessToken) {
      throw new JinshujuError('缺少金数据 Access Token：请设置 JINSHUJU_ACCESS_TOKEN 或传入 accessToken。');
    }
    this.accessToken = accessToken;
    this.baseUrl = (options.baseUrl ?? process.env.JINSHUJU_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20000;
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async request(method, path, { query, body } = {}) {
    const qs = encodeQuery(query);
    const url = new URL(this.baseUrl + path + (qs ? `?${qs}` : ''));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new JinshujuError(`请求超时（${this.timeoutMs}ms）`, { method, url: url.toString(), cause: error });
      }
      throw new JinshujuError(`网络请求失败：${error.message}`, { method, url: url.toString(), cause: error });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const description = data?.error_description || data?.error || (data ? JSON.stringify(data) : text);
      throw new JinshujuError(`金数据 API 返回 ${response.status}：${description}`, {
        status: response.status,
        body: data,
        method,
        url: url.toString(),
      });
    }

    return { status: response.status, data, headers: response.headers };
  }

  async getMe() {
    return (await this.request('GET', '/me')).data;
  }

  async listForms(params = {}) {
    return (await this.request('GET', '/forms', { query: params })).data;
  }

  async listAllForms(params = {}) {
    const results = [];
    let next = params.next;
    for (;;) {
      const page = await this.listForms({ ...params, next });
      results.push(...(page.data || []));
      if (!page.next || (page.data || []).length === 0) break;
      next = page.next;
    }
    return results;
  }

  async getForm(formToken, params = {}) {
    return (await this.request('GET', `/forms/${formToken}`, { query: params })).data;
  }

  async getFormFieldRules(formToken) {
    return (await this.request('GET', `/forms/${formToken}/field_rules`)).data;
  }

  async createForm(payload) {
    return (await this.request('POST', '/forms', { body: payload })).data;
  }

  async updateForm(formToken, patch) {
    return (await this.request('PATCH', `/forms/${formToken}`, { body: patch })).data;
  }

  async listEntries(formToken, params = {}) {
    return (await this.request('GET', `/forms/${formToken}/entries`, { query: params })).data;
  }

  async listAllEntries(formToken, params = {}) {
    const results = [];
    let next = params.next;
    for (;;) {
      const page = await this.listEntries(formToken, { ...params, next });
      results.push(...(page.data || []));
      if (page.next === null || page.next === undefined || (page.data || []).length === 0) break;
      next = page.next;
    }
    return results;
  }

  async getEntry(formToken, serialNumber) {
    return (await this.request('GET', `/forms/${formToken}/entries/${serialNumber}`)).data;
  }

  async createEntry(formToken, entry) {
    return (await this.request('POST', `/forms/${formToken}/entries`, { body: entry })).data;
  }

  async batchCreateEntries(formToken, entries) {
    return (await this.request('POST', `/forms/${formToken}/entries/batch`, { body: { entries } })).data;
  }

  async updateEntry(formToken, serialNumber, patch, { replaceAll = false } = {}) {
    const method = replaceAll ? 'PUT' : 'PATCH';
    return (await this.request(method, `/forms/${formToken}/entries/${serialNumber}`, { body: patch })).data;
  }

  async deleteEntry(formToken, serialNumber) {
    return (await this.request('DELETE', `/forms/${formToken}/entries/${serialNumber}`)).data;
  }
}
