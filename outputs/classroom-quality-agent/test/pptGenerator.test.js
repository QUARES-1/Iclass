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
