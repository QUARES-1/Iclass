import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMaterial, analyzeMaterials } from '../src/analyzer.js';

const SAMPLE = [
  '第5章 排序算法',
  '一、教学目标',
  '1. 掌握冒泡排序的基本思想。',
  '2. 理解快速排序的分治思想。',
  '二、教学重点',
  '1. 快速排序的划分过程。',
  '三、教学难点',
  '1. 快速排序最坏情况复杂度分析。',
  '四、教学内容',
  '1. 排序的基本概念。',
  '2. 快速排序。',
  '3. 归并排序。',
].join('\n');

test('解析章节、教学目标、重点、难点与知识点', () => {
  const result = analyzeMaterial(SAMPLE);

  assert.deepEqual(result.chapters, ['第5章 排序算法']);
  assert.deepEqual(result.objectives, ['掌握冒泡排序的基本思想。', '理解快速排序的分治思想。']);
  assert.deepEqual(result.keyPoints, ['快速排序的划分过程。']);
  assert.deepEqual(result.difficultPoints, ['快速排序最坏情况复杂度分析。']);
  assert.deepEqual(result.knowledgePoints, ['排序的基本概念。', '快速排序。', '归并排序。']);
});

test('在没有显式标题时也能通过关键词兜底抽取目标', () => {
  const loose = '学生应掌握链表的基本操作。\n学生应理解递归思想。';
  const result = analyzeMaterial(loose);

  assert.equal(result.chapters.length, 0);
  assert.equal(result.objectives.length, 2);
});

test('汇总多个材料时会去重', () => {
  const result = analyzeMaterials([
    { type: '大纲', title: 'a', content: SAMPLE },
    { type: '教案', title: 'b', content: '第5章 排序算法\n1. 掌握冒泡排序的基本思想。' },
  ]);

  // 相同章节与知识点不应重复出现。
  assert.equal(result.chapters.length, 1);
  assert.equal(result.objectives.length, 2);
});

test('支持“教学目标：……”这类行内写法', () => {
  const text = [
    '教学目标：掌握链表的基本操作。',
    '教学重点：链表的插入与删除。',
    '教学难点：指针与内存管理。',
  ].join('\n');
  const result = analyzeMaterial(text);

  assert.deepEqual(result.objectives, ['掌握链表的基本操作。']);
  assert.deepEqual(result.keyPoints, ['链表的插入与删除。']);
  assert.deepEqual(result.difficultPoints, ['指针与内存管理。']);
});

test('空输入返回完整但为空的结构', () => {
  assert.deepEqual(analyzeMaterial(''), {
    chapters: [],
    objectives: [],
    keyPoints: [],
    difficultPoints: [],
    knowledgePoints: [],
  });
  assert.deepEqual(analyzeMaterials([]), {
    chapters: [],
    objectives: [],
    keyPoints: [],
    difficultPoints: [],
    knowledgePoints: [],
  });
});

test('无区块标题时只把编号项作为知识点兜底', () => {
  const result = analyzeMaterial([
    '这是课程背景说明，不应自动成为知识点。',
    '1. 线性表的定义',
    '- 顺序表的存储结构',
    '普通说明段落。',
  ].join('\n'));
  assert.deepEqual(result.knowledgePoints, ['线性表的定义', '顺序表的存储结构']);
  assert.ok(!result.knowledgePoints.includes('普通说明段落。'));
});

test('支持中文章节编号并清理列表前缀', () => {
  const result = analyzeMaterial([
    '第十章 图',
    '知识点',
    '（一）图的存储结构',
    '2．图的遍历',
  ].join('\n'));
  assert.deepEqual(result.chapters, ['第十章 图']);
  assert.deepEqual(result.knowledgePoints, ['图的存储结构', '图的遍历']);
});

test('多材料合并会清理空内容且保持首次出现顺序', () => {
  const result = analyzeMaterials([
    { content: '教学目标：理解线性表。\n知识点：顺序表' },
    { content: '教学目标：理解线性表。\n知识点：链表' },
    null,
  ]);
  assert.deepEqual(result.objectives, ['理解线性表。']);
  assert.deepEqual(result.knowledgePoints, ['顺序表', '链表']);
});
