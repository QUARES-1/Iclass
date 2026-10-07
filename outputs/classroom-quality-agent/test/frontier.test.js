import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSupplements, groupSupplements, FRONTIER_KB } from '../src/frontier.js';

test('知识点能够命中对应的前沿补充', () => {
  const result = matchSupplements(['快速排序', '归并排序']);
  const ids = result.map((item) => item.id);

  // 快速排序与归并排序都应命中至少一条，且“排序”类通用补充也会被匹配。
  assert.ok(ids.includes('f-01'));
  assert.ok(ids.includes('f-02'));
  assert.ok(ids.includes('f-03'));
});

test('同一补充不会被重复返回', () => {
  const result = matchSupplements(['快速排序', '冒泡排序']);
  const ids = result.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('空知识点列表返回空结果', () => {
  assert.deepEqual(matchSupplements([]), []);
});

test('按类型分组正确', () => {
  const grouped = groupSupplements(matchSupplements(['快速排序', '归并排序']));
  assert.ok(grouped.tech.length > 0);
  assert.ok(grouped.cases.length > 0);
  assert.ok(grouped.tech.every((item) => item.type === '技术'));
  assert.ok(grouped.cases.every((item) => item.type === '案例'));
});


test('知识库能匹配排序之外的主题', () => {
  const result = matchSupplements(['二叉树的基本操作', '哈希表的实现']);
  const ids = result.map((item) => item.id);
  assert.ok(ids.includes('f-12'));
  assert.ok(ids.includes('f-20'));
});

test('知识库已扩充到覆盖多种主题', () => {
  assert.ok(FRONTIER_KB.length >= 20);
});

test('英文关键词匹配不区分大小写', () => {
  const result = matchSupplements(['使用 QUICKSORT 完成排序']);
  assert.ok(result.some((item) => item.id === 'f-01'));
});

test('支持注入自定义知识库且返回命中的原始知识点', () => {
  const custom = [{
    id: 'custom-1',
    keywords: ['线性表'],
    title: '自定义案例',
    type: '案例',
    description: '测试',
    source: '测试来源',
  }];
  const result = matchSupplements(['线性表的定义'], custom);
  assert.equal(result.length, 1);
  assert.equal(result[0].matchedBy, '线性表的定义');
});
