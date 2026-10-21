import test from 'node:test';
import assert from 'node:assert/strict';
import { JinshujuClient, JinshujuError } from '../src/jinshuju.js';

function mockFetch(handler) {
  return async (url, options) => {
    const result = handler(url, options);
    const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? null);
    return {
      ok: result.ok !== false,
      status: result.status ?? 200,
      headers: result.headers ?? {},
      text: async () => text,
    };
  };
}

test('缺少 Access Token 时构造失败', () => {
  const previous = process.env.JINSHUJU_ACCESS_TOKEN;
  delete process.env.JINSHUJU_ACCESS_TOKEN;
  assert.throws(() => new JinshujuClient({ accessToken: '', fetchImpl: mockFetch(() => ({})) }), /JINSHUJU_ACCESS_TOKEN/);
  if (previous !== undefined) process.env.JINSHUJU_ACCESS_TOKEN = previous;
});
test('成功响应不是完整JSON对象时拒绝，DELETE 204允许空响应',async()=>{
  for(const body of ['{','', 'null']){
    const client=new JinshujuClient({accessToken:'fixture',fetchImpl:mockFetch(()=>({body}))});await assert.rejects(client.createForm({}),JinshujuError);
  }
  const client=new JinshujuClient({accessToken:'fixture',fetchImpl:mockFetch(()=>({status:204,body:''}))});assert.equal(await client.deleteEntry('form',1),null);
});
test('响应头已到达但正文停滞时超时仍然有效',async()=>{
  const client=new JinshujuClient({accessToken:'fixture',timeoutMs:10,fetchImpl:async(url,{signal})=>({ok:true,status:200,headers:{},text:()=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})})});
  await assert.rejects(client.getMe(),/超时或取消/);
});
test('重复分页游标被拒绝，不无限读取同一页',async()=>{
  let calls=0;const client=new JinshujuClient({accessToken:'fixture',fetchImpl:mockFetch(()=>{calls++;return {body:{data:[{serial_number:1}],next:'same'}};})});
  await assert.rejects(client.listAllEntries('form'),/分页游标重复/);assert.equal(calls,2);
});

test('getMe 使用 Bearer 鉴权并返回数据', async () => {
  const calls = [];
  const client = new JinshujuClient({
    accessToken: 'tok123',
    fetchImpl: mockFetch((url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, body: { name: '金老师' } };
    }),
  });
  const data = await client.getMe();
  assert.deepEqual(data, { name: '金老师' });
  assert.equal(calls[0].url, 'https://jinshuju.net/api/v1/me');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok123');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('listForms 将 filters 数组序列化为 JSON 字符串', async () => {
  const calls = [];
  const client = new JinshujuClient({
    accessToken: 't',
    fetchImpl: mockFetch((url) => {
      calls.push(url);
      return { ok: true, status: 200, body: { total: 0, count: 0, data: [], next: null } };
    }),
  });
  const filters = [{ field: 'entries_count', operator: 'gte', value: 1 }];
  await client.listForms({ q: '报名', filters, limit: 20 });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('q'), '报名');
  assert.equal(parsed.searchParams.get('filters'), JSON.stringify(filters));
  assert.equal(parsed.searchParams.get('limit'), '20');
});

test('createForm 发送 JSON 请求体', async () => {
  const calls = [];
  const client = new JinshujuClient({
    accessToken: 't',
    fetchImpl: mockFetch((url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, body: { token: 'ABC', name: '问卷', fields: [] } };
    }),
  });
  const payload = { name: '问卷', fields: [{ type: 'TextField', label: '姓名' }] };
  const created = await client.createForm(payload);
  assert.equal(created.token, 'ABC');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].url, 'https://jinshuju.net/api/v1/forms');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('非 2xx 抛出带状态与错误描述的 JinshujuError', async () => {
  const client = new JinshujuClient({
    accessToken: 't',
    fetchImpl: mockFetch(() => ({ ok: false, status: 401, body: { error_description: 'Access token 无效' } })),
  });
  await assert.rejects(() => client.getMe(), (error) => {
    assert.ok(error instanceof JinshujuError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Access token 无效/);
    return true;
  });
});

test('listAllEntries 沿 next 游标翻页', async () => {
  const pages = [
    { total: 2, count: 1, data: [{ serial_number: 1 }], next: 2 },
    { total: 2, count: 1, data: [{ serial_number: 2 }], next: null },
  ];
  let index = 0;
  const client = new JinshujuClient({
    accessToken: 't',
    fetchImpl: mockFetch(() => ({ ok: true, status: 200, body: pages[index++] })),
  });
  const all = await client.listAllEntries('ABC');
  assert.deepEqual(all, [{ serial_number: 1 }, { serial_number: 2 }]);
  assert.equal(index, 2);
});

test('updateEntry 默认合并修改，replaceAll 时使用 PUT', async () => {
  const calls = [];
  const client = new JinshujuClient({
    accessToken: 't',
    fetchImpl: mockFetch((url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, body: {} };
    }),
  });
  await client.updateEntry('ABC', 5, { field_1: 'a' });
  assert.equal(calls[0].options.method, 'PATCH');
  await client.updateEntry('ABC', 5, { field_1: 'a' }, { replaceAll: true });
  assert.equal(calls[1].options.method, 'PUT');
});
