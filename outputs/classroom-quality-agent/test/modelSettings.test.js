import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelSettings, environmentSettings, validateModelSettings } from '../src/modelSettings.js';
import { DEFAULT_PROMPTS, CHAT_CONTRACT } from '../src/prompts.js';
import { requestJSON, generateChatCandidate } from '../src/model.js';
import { analyzeClassroom } from '../src/analysis.js';
import { analyzeMaterialsWithLLM, generateOutlineWithLLM } from '../src/llm.js';
import { emptyWorkspace } from '../src/workspace.js';

test('设置保存后重建服务可恢复，密钥不回显，留空保留、替换与显式清除生效', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-settings-'));
  const env = { LLM_API_KEY: 'environment-secret', LLM_BASE_URL: 'https://old.example/v1', LLM_MODEL: 'old-model' };
  try {
    const settings = new ModelSettings(root, env), first = await settings.read();
    assert.equal(first.apiKey, env.LLM_API_KEY); assert.ok(!JSON.stringify(settings.public(first)).includes(env.LLM_API_KEY));
    let saved = await settings.save({ revision: 0, model: 'new-model', baseUrl: 'https://new.example/v1/chat/completions/', apiKey: '', prompts: { preparation: '教师自定义：300分钟课程，详讲原理与实操。' } });
    assert.equal(saved.apiKey, env.LLM_API_KEY); assert.equal(saved.baseUrl, 'https://new.example/v1');
    assert.deepEqual(await new ModelSettings(root, env).read(), saved);
    // Windows uses ACLs; Node's POSIX mode bits cannot assert owner-only access.
    if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'model-settings.json'))).mode & 0o777, 0o600);
    saved = await settings.save({ revision: saved.revision, apiKey: 'replacement-secret' });
    assert.equal(saved.apiKey, 'replacement-secret'); assert.equal(saved.model, 'new-model');
    assert.equal(saved.prompts.preparation, '教师自定义：300分钟课程，详讲原理与实操。');
    const file = await readFile(path.join(root, 'model-settings.json'), 'utf8');
    await assert.rejects(settings.save({ revision: 0, model: 'conflicting-model' }), /其他操作/);
    assert.equal(await readFile(path.join(root, 'model-settings.json'), 'utf8'), file);
    saved = await settings.save({ revision: saved.revision, clearApiKey: true });
    assert.equal((await new ModelSettings(root, env).read()).apiKey, '');
    assert.equal(settings.public(saved).apiKeyConfigured, false);
    await assert.rejects(requestJSON('test', {}, { ...saved, fetch: () => assert.fail('不能回退环境变量密钥') }), /尚未配置/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('配置校验拒绝非法地址、空模型、越界数字、异常密钥与空提示词', () => {
  const current = environmentSettings({});
  for (const patch of [
    { baseUrl: 'not-a-url' }, { baseUrl: 'file:///tmp/a' }, { baseUrl: 'https://name:secret@example.com' }, { baseUrl: 'https://example.com?key=secret' },
    { model: '' }, { model: 'a\nb' }, { maxTokens: 0 }, { maxTokens: 1.5 }, { temperature: -1 }, { timeoutMs: 4999 }, { maxInputChars: Infinity },
    { apiKey: 'bad\nkey' }, { clearApiKey: 'yes' }, { clearApiKey: true, apiKey: 'conflict' }, { prompts: { preparation: '' } },
    { prompts: { preparation: 'x'.repeat(30001) } }, { prompts: { constructor: 'unexpected' } }, { unknown: 'unexpected' },
  ]) assert.throws(() => validateModelSettings(current, patch), undefined, JSON.stringify(patch));
  const saved = validateModelSettings(current, { temperature: 0, timeoutMs: 600000, maxTokens: 32000, maxInputChars: 2000000 });
  assert.equal(saved.temperature, 0); assert.equal(saved.maxTokens, 32000);
});

test('真实模型请求使用全部配置参数，超出额度时明确提示且不发送截断资料', async () => {
  let body, endpoint, authorization, calls = 0;
  const config = { apiKey: 'test-secret', baseUrl: 'https://compatible.example/v1/', model: 'custom-model', temperature: 0, maxTokens: 24000, timeoutMs: 60000, maxInputChars: 3000,
    fetch: async (url, options) => { calls++; endpoint = url; body = JSON.parse(options.body); authorization = options.headers.Authorization; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) }; } };
  await requestJSON('custom system', { text: '完整教学输入' }, config);
  assert.equal(endpoint, 'https://compatible.example/v1/chat/completions'); assert.equal(authorization, 'Bearer test-secret');
  assert.equal(body.model, 'custom-model'); assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 24000);
  assert.equal(body.messages[0].content, 'custom system'); assert.equal(body.messages[1].content, JSON.stringify({ text: '完整教学输入' }));
  await assert.rejects(requestJSON('test', { text: '文'.repeat(3001) }, config), /输入额度/); assert.equal(calls, 1);
});

test('教师备课提示词替代默认策略并传递配置，结构协议仍可供校验', async () => {
  const config = { prompts: { preparation: '自定义策略：生成80页实操课件，允许长课时。' }, model: 'my-model' };
  let system;
  await generateChatCandidate(emptyWorkspace(), '制作课程', null, null, async (prompt, input, received) => { system = prompt; assert.equal(received, config); return { action: 'advice', reply: '测试建议' }; }, config);
  assert.ok(system.startsWith(config.prompts.preparation)); assert.ok(system.endsWith(CHAT_CONTRACT)); assert.ok(!system.includes(DEFAULT_PROMPTS.preparation));
  assert.ok(!DEFAULT_PROMPTS.preparation.includes('不超过15页'));
});

test('课堂分析每次分段与汇总使用同一份教师配置快照', async () => {
  const segments = [1, 2].map(i => ({ id: 'seg-' + i, start: i * 10, end: i * 10 + 8, text: '课堂'.repeat(3000) }));
  const config = { model: 'classroom-model', prompts: { classroom: '教师自定义课堂分析重点。' } }; let calls = 0;
  await analyzeClassroom({ title: '课堂' }, { segments }, async (system, input, received) => {
    calls++; assert.equal(received, config); assert.ok(system.startsWith(config.prompts.classroom));
    const ids = input.segments?.map(s => s.id) || input.partials.flatMap(p => p.ids);
    return { sections: Object.fromEntries(['summary', 'knowledge', 'emphasis', 'difficulties', 'observations', 'suggestions'].map(k => [k, [{ text: '依据课堂内容', kind: k === 'difficulties' ? 'hypothesis' : k === 'emphasis' ? 'ai-inference' : 'transcript', evidenceIds: ids }]])) };
  }, async () => {}, config);
  assert.equal(calls, 3);
});

test('资料理解与旧版大纲同样使用教师设置，不再直接绕过配置读取环境变量', async () => {
  const original = globalThis.fetch, calls = [];
  const config = { apiKey: 'test-key', model: 'configured-model', baseUrl: 'https://configured.example/v1', temperature: 0, maxTokens: 16000,
    prompts: { materials: '教师自定义资料理解', outline: '教师自定义大纲' } };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    const content = body.messages[0].content.startsWith(config.prompts.materials)
      ? { analysis: { chapters: ['排序'], objectives: ['掌握排序'], knowledgePoints: ['稳定性'], keyPoints: ['相同元素顺序'], difficultPoints: ['边界判断'] } }
      : { slides: [{ section: '讲解', title: '原理', bullets: ['具体原理'], notes: [] }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  try {
    assert.equal((await analyzeMaterialsWithLLM([{ title: '排序', content: '排序原理' }], config)).source, 'llm');
    assert.equal((await generateOutlineWithLLM({}, [], config)).source, 'llm');
    assert.equal(calls.length, 2);
    for (const { url, body } of calls) { assert.equal(url, config.baseUrl + '/chat/completions'); assert.equal(body.model, config.model); assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 16000); }
    assert.ok(calls[1].body.messages[0].content.startsWith(config.prompts.outline));
    assert.equal((await analyzeMaterialsWithLLM([{ title: '材料', content: '排序' }], { ...config, apiKey: '' })).source, 'local');
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test('可配置的资料理解使用完整长正文、保留教师要求的条目数量，超额不会悄悄截断',async()=>{
  const original=globalThis.fetch,calls=[];
  const config={apiKey:'test-key',baseUrl:'https://test.example',model:'test-model',maxInputChars:100000,prompts:{materials:'提取全部25个知识点，不省略。'}};
  globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({analysis:{chapters:['主题'],objectives:['理解原理'],knowledgePoints:Array.from({length:25},(_,i)=>'知识点 '+i),keyPoints:['教学重点'],difficultPoints:['教学难点']}})}}]})};};
  try{
    const content='正文'.repeat(30000)+'不能丢失的结尾';
    const result=await analyzeMaterialsWithLLM([{title:'完整资料',content}],config);
    assert.equal(result.source,'llm');assert.equal(result.analysis.knowledgePoints.length,25);assert.ok(calls[0].messages[1].content.includes(content));assert.ok(!result.warning);
    const failed=await analyzeMaterialsWithLLM([{title:'过量资料',content}],{...config,maxInputChars:1000});
    assert.equal(failed.source,'local');assert.match(failed.warning,/字符额度/);assert.equal(calls.length,1);
  }finally{globalThis.fetch=original;}
});
