import http from 'node:http';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Set isolation before importing the app, which constructs its API handler.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'classroom-server-test-'));
process.env.DATA_DIR = dataDir;
const { server } = await import('../server.js');

let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataDir, { recursive:true, force:true });
});

async function readJson(response) {
  const body = await response.json();
  return { response, body };
}

test('根路径和旧入口会跳转到正确页面', async () => {
  const home = await fetch(baseUrl + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/public/home.html');

  const legacy = await fetch(baseUrl + '/index.html', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/public/index.html');
});

test('静态页面支持 GET 与 HEAD', async () => {
  const get = await fetch(baseUrl + '/public/index.html');
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type'), /text\/html/);
  assert.ok((await get.text()).includes('课前智能备课'));

  const head = await fetch(baseUrl + '/public/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('不存在的静态资源返回 404', async () => {
  const response = await fetch(baseUrl + '/public/not-found.js');
  assert.equal(response.status, 404);
});

test('静态服务拒绝配置、后端代码、测试及持久化数据', async () => {
  for (const target of ['/.env', '/server.js', '/package.json', '/src/store.js', '/src/api.js', '/data/workspace.json', '/data/model-settings.json', '/src/modelSettings.js', '/src/prompts.js', '/test/server.test.js', '/public/../server.js']) {
    assert.equal((await fetch(baseUrl + target)).status, 403, target);
  }
  assert.equal((await fetch(baseUrl + '/src/interactive.js')).status, 200);
  assert.equal((await fetch(baseUrl + '/src/codeBlock.js')).status, 200);
});

test('非法 URL 编码不会导致服务器崩溃', async () => {
  const response = await fetch(baseUrl + '/%E0%A4%A');
  assert.equal(response.status, 403);
});

test('内容理解接口拒绝非法 JSON 和空材料', async () => {
  const invalidJson = await readJson(await fetch(baseUrl + '/api/analyze-materials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  }));
  assert.equal(invalidJson.response.status, 400);
  assert.match(invalidJson.body.error, /有效的 JSON/);

  const empty = await readJson(await fetch(baseUrl + '/api/analyze-materials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ materials: [] }),
  }));
  assert.equal(empty.response.status, 400);
  assert.match(empty.body.error, /教学资料参数格式/);
});

test('PPT 生成接口拒绝结构不完整的分析结果', async () => {
  const { response, body } = await readJson(await fetch(baseUrl + '/api/generate-outline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis: { chapters: [] }, supplements: [] }),
  }));
  assert.equal(response.status, 400);
  assert.match(body.error, /教学内容参数格式/);
});

test('文件解析接口校验文件名、空文件和类型', async () => {
  const missingName = await readJson(await fetch(baseUrl + '/api/extract-file', {
    method: 'POST',
    body: Buffer.from('x'),
  }));
  assert.equal(missingName.response.status, 400);

  const empty = await readJson(await fetch(baseUrl + '/api/extract-file?name=empty.pptx', {
    method: 'POST',
    body: Buffer.alloc(0),
  }));
  assert.equal(empty.response.status, 400);
  assert.equal(empty.body.code, 'EMPTY_FILE');

  const unsupported = await readJson(await fetch(baseUrl + '/api/extract-file?name=material.pdf', {
    method: 'POST',
    body: Buffer.from('pdf'),
  }));
  assert.equal(unsupported.response.status, 415);
  assert.equal(unsupported.body.code, 'UNSUPPORTED_FILE_TYPE');
});


test('中文 JSON 跨网络分片不损坏，25万字符资料可进入本地理解',async()=>{
  const previous=process.env.LLM_API_KEY;delete process.env.LLM_API_KEY;
  try{
    const content='知识点：'+'课'.repeat(249996),body=Buffer.from(JSON.stringify({materials:[{type:'txt',title:'长资料',content}]})),index=body.indexOf(Buffer.from('课'))+1;
    const result=await new Promise((resolve,reject)=>{const req=http.request(baseUrl+'/api/analyze-materials',{method:'POST',headers:{'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.write(body.subarray(0,index));setTimeout(()=>req.end(body.subarray(index)),20);});
    assert.equal(result.status,200);assert.equal(result.body.source,'local');assert.ok(result.body.analysis.knowledgePoints.length);assert.ok(Object.values(result.body.analysis).flat().every(s=>s.length<=5000));assert.match(result.body.warning,/缩略/);assert.ok(!result.body.analysis.knowledgePoints[0].includes('�'));
  }finally{if(previous!==undefined)process.env.LLM_API_KEY=previous;}
});
