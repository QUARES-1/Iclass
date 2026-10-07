import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOutline, toMarkdown } from '../src/pptGenerator.js';

const ANALYSIS = {
  chapters: ['第5章 排序算法'],
  objectives: ['掌握冒泡排序的基本思想。', '理解快速排序的分治思想。'],
  keyPoints: ['快速排序的划分过程。'],
  difficultPoints: ['快速排序最坏情况复杂度分析。'],
  knowledgePoints: ['排序的基本概念。', '快速排序。', '归并排序。'],
};

const SUPPLEMENTS = [
  {
    id: 'f-03',
    type: '案例',
    title: '推荐与搜索系统中的排序层',
    description: '电商平台用排序模型决定内容展示顺序。',
    source: '行业博客',
    needsVerify: true,
    matchedBy: '快速排序',
  },
  {
    id: 'f-04',
    type: '技术',
    title: '算法复杂度分析工具',
    description: '大 O 分析配合基准测试。',
    source: '《算法导论》',
    needsVerify: false,
    matchedBy: '快速排序',
  },
];

test('生成的大纲遵循“导入—讲解—案例—互动—总结”结构', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  const sections = slides.map((slide) => slide.section);

  assert.equal(slides[0].section, '导入');
  assert.equal(slides[slides.length - 1].section, '总结');
  assert.equal(sections.filter((s) => s === '讲解').length, ANALYSIS.knowledgePoints.length);
  assert.ok(sections.includes('案例'));
  assert.ok(sections.includes('互动'));
});

test('重点与难点知识点会打上标签', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  const fastSort = slides.find((slide) => slide.title === '快速排序。');
  assert.ok(fastSort.bullets.some((bullet) => bullet.includes('重点')));
  assert.ok(fastSort.bullets.some((bullet) => bullet.includes('难点')));
});

test('生成的幻灯片初始状态均为待确认', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  assert.ok(slides.every((slide) => slide.status === 'pending'));
});

test('能够导出 Markdown 大纲', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  const markdown = toMarkdown(slides);
  assert.ok(markdown.includes('## 导入'));
  assert.ok(markdown.includes('## 总结'));
  assert.ok(markdown.includes('快速排序。'));
});


test('导出 Markdown 会过滤已删除的幻灯片', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  const withDeleted = slides.map((slide) =>
    slide.title === '快速排序。' ? { ...slide, status: 'deleted' } : slide,
  );
  const markdown = toMarkdown(withDeleted);
  assert.ok(!markdown.includes('快速排序。'));
  assert.ok(markdown.includes('## 导入'));
  assert.ok(markdown.includes('## 总结'));
});

test('正式 Markdown 只包含已确认内容', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS).map((slide, index) => ({
    ...slide,
    status: index === 0 ? 'confirmed' : index === 1 ? 'deleted' : 'pending',
  }));
  const markdown = toMarkdown(slides, { confirmedOnly: true });
  assert.ok(markdown.includes('课程导入'));
  assert.ok(!markdown.includes(slides[1].title));
  assert.ok(!markdown.includes('课堂互动与讨论'));
});

test('生成页包含可供视觉导出的布局字段', () => {
  const slides = generateOutline(ANALYSIS, SUPPLEMENTS);
  assert.equal(slides[0].layout, 'intro');
  assert.equal(slides.at(-1).layout, 'summary');
  assert.equal(slides.find((slide) => slide.section === '互动').layout, 'interaction');
  assert.ok(slides.filter((slide) => slide.section === '讲解').every((slide) => slide.layout));
});

test('没有行业案例补充时仍保留完整的导入讲解互动总结流程', () => {
  const slides = generateOutline(ANALYSIS, []);
  const sections = slides.map((slide) => slide.section);
  assert.equal(sections[0], '导入');
  assert.equal(sections.at(-1), '总结');
  assert.ok(sections.includes('讲解'));
  assert.ok(sections.includes('互动'));
  assert.ok(!sections.includes('案例'));
});
