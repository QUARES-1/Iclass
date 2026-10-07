import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  extractJson,
  normalizeAnalysis,
  normalizeSlides,
  analyzeMaterialsWithLLM,
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

test('内容理解提示要求五类字段完整且不得虚构', () => {
  const prompt = buildAnalysisSystemPrompt();
  assert.ok(prompt.includes('chapters'));
  assert.ok(prompt.includes('knowledgePoints'));
  assert.ok(prompt.includes('不得虚构'));
  assert.ok(prompt.includes('不得为空'));
});

test('内容理解用户提示包含资料标题、类型和正文', () => {
  const prompt = buildAnalysisUserPrompt([
    { title: '线性表讲义', type: '教案', content: '线性表由有限个数据元素组成。' },
  ]);
  assert.ok(prompt.includes('线性表讲义'));
  assert.ok(prompt.includes('教案'));
  assert.ok(prompt.includes('有限个数据元素'));
});

test('过长教学资料会截断且保留首尾内容', () => {
  const content = 'A'.repeat(40000) + '中间' + 'B'.repeat(40000);
  const prompt = buildAnalysisUserPrompt([{ title: '长资料', type: '教材', content }]);
  assert.ok(prompt.includes('[中间内容因长度限制省略]'));
  assert.ok(prompt.includes('A'.repeat(100)));
  assert.ok(prompt.includes('B'.repeat(100)));
  assert.ok(prompt.length < content.length);
});

test('normalizeAnalysis 支持别名、去重、清理空白和数量限制', () => {
  const result = normalizeAnalysis({
    章节: [' 第一章 线性表 ', '第一章 线性表'],
    教学目标: ['理解  线性表'],
    knowledge_points: Array.from({ length: 25 }, (_, index) => `知识点 ${index + 1}`),
    重点: ['顺序表'],
    难点: ['链表指针'],
  });
  assert.deepEqual(result.chapters, ['第一章 线性表']);
  assert.deepEqual(result.objectives, ['理解 线性表']);
  assert.equal(result.knowledgePoints.length, 20);
  assert.deepEqual(result.keyPoints, ['顺序表']);
  assert.deepEqual(result.difficultPoints, ['链表指针']);
  assert.equal(normalizeAnalysis({}), null);
});

test('AI 内容理解成功时返回完整结构并使用后端配置', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          analysis: {
            chapters: ['第2章 线性表'],
            objectives: ['理解线性表'],
            knowledgePoints: ['顺序表', '链表'],
            keyPoints: ['顺序表'],
            difficultPoints: ['链表指针'],
          },
        }) } }],
      }),
    };
  };
  try {
    const result = await analyzeMaterialsWithLLM(
      [{ title: '线性表', type: '教案', content: '线性表与链表指针' }],
      { apiKey: 'test-key', baseUrl: 'https://api.example.com/v1/', model: 'test-model' },
    );
    assert.equal(result.source, 'llm');
    assert.deepEqual(result.analysis.keyPoints, ['顺序表']);
    assert.equal(request.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.response_format.type, 'json_object');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI 内容理解结果缺少重点或难点时回退本地解析', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      analysis: {
        chapters: ['第2章 线性表'],
        objectives: ['理解线性表'],
        knowledgePoints: ['顺序表'],
        keyPoints: [],
        difficultPoints: [],
      },
    }) } }] }),
  });
  try {
    const result = await analyzeMaterialsWithLLM(
      [{ title: '线性表', type: '教案', content: '教学目标：理解线性表。\n教学重点：顺序表。\n教学难点：链表指针。' }],
      { apiKey: 'test-key' },
    );
    assert.equal(result.source, 'local');
    assert.match(result.warning, /不完整/);
    assert.deepEqual(result.analysis.keyPoints, ['顺序表。']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractJson 对空文本和损坏 JSON 返回 null', () => {
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('```json\n{"slides": [}\n```'), null);
});

test('normalizeSlides 清理正文并保留 AI 示例与反例', () => {
  const slides = normalizeSlides({ slides: [{
    section: '未知环节',
    title: ' 线性表定义 ',
    bullets: [' 要点 ', 2, null],
    notes: [' 备注 '],
    example: ' 顺序表 ',
    counterExample: ' 无限序列 ',
  }] });
  assert.equal(slides[0].section, '讲解');
  assert.deepEqual(slides[0].bullets, ['要点', '2']);
  assert.deepEqual(slides[0].notes, ['备注']);
  assert.equal(slides[0].example, '顺序表');
  assert.equal(slides[0].counterExample, '无限序列');
});
