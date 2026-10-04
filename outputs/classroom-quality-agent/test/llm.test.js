import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildUserPrompt,
  extractJson,
  normalizeSlides,
  generateOutlineWithLLM,
} from '../src/llm.js';

const ANALYSIS = {
  chapters: ['第5章 排序算法'],
  objectives: ['掌握快速排序的分治思想。'],
  keyPoints: ['快速排序的划分过程。'],
  difficultPoints: ['快速排序最坏情况复杂度分析。'],
  knowledgePoints: ['快速排序。', '归并排序。'],
};

const SUPPLEMENTS = [
  { id: 'f-01', type: '案例', title: '搜索与推荐排序', description: '电商平台用排序决定展示顺序。', source: '行业博客', needsVerify: false, matchedBy: '快速排序' },
];

test('系统提示包含输出结构与写作规范', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('slides'));
  assert.ok(prompt.includes('导入'));
  assert.ok(prompt.includes('写作规范'));
});

test('用户提示包含章节、知识点与补充', () => {
  const prompt = buildUserPrompt(ANALYSIS, SUPPLEMENTS);
  assert.ok(prompt.includes('第5章 排序算法'));
  assert.ok(prompt.includes('快速排序'));
  assert.ok(prompt.includes('搜索与推荐排序'));
});

test('能从带 Markdown 代码块的文本中提取 JSON', () => {
  const text = '好的，以下是结果：\n```json\n{"slides":[{"section":"导入","title":"课程导入","bullets":["目标"],"notes":[]}]}\n```';
  const parsed = extractJson(text);
  assert.ok(parsed && parsed.slides.length === 1);
  assert.equal(parsed.slides[0].title, '课程导入');
});

test('normalizeSlides 补齐 id/status 并过滤非法项', () => {
  const slides = normalizeSlides([
    { section: '导入', title: '课程导入', bullets: ['a'], notes: [] },
    { section: '其他', title: '', bullets: [] },
  ]);
  assert.equal(slides.length, 1);
  assert.equal(slides[0].id, 'slide-001');
  assert.equal(slides[0].status, 'pending');
});

test('未配置 Key 时回退本地模板', async () => {
  const result = await generateOutlineWithLLM(ANALYSIS, [], {});
  assert.equal(result.source, 'local');
  assert.ok(result.slides.length > 0);
});

test('配置 Key 后调用成功返回 llm 结果', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ slides: [{ section: '导入', title: '课程导入', bullets: ['目标'], notes: [] }] }) } }] }),
  });
  try {
    const result = await generateOutlineWithLLM(ANALYSIS, [], { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'test-model' });
    assert.equal(result.source, 'llm');
    assert.equal(result.slides[0].title, '课程导入');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('调用失败时回退本地模板并带 warning', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await generateOutlineWithLLM(ANALYSIS, [], { apiKey: 'sk-test' });
    assert.equal(result.source, 'local');
    assert.ok(result.warning);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
