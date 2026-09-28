import test from 'node:test';
import assert from 'node:assert/strict';
import { slidesToExportModel } from '../src/pptExport.js';

const SLIDES = [
  { id: 's1', section: '导入', title: '课程导入', bullets: ['目标1'], notes: ['备注'], status: 'confirmed' },
  { id: 's2', section: '讲解', title: '知识点', bullets: ['要点'], notes: [], status: 'pending' },
  { id: 's3', section: '总结', title: '本章总结', bullets: ['回顾'], notes: [], status: 'deleted' },
];

test('导出模型会过滤已删除的幻灯片', () => {
  const model = slidesToExportModel(SLIDES);
  assert.equal(model.length, 2);
  assert.ok(model.every((item) => item.section !== '总结'));
});

test('导出模型正确映射字段', () => {
  const model = slidesToExportModel(SLIDES);
  assert.deepEqual(model[0], {
    section: '导入',
    title: '课程导入',
    bullets: ['目标1'],
    notes: ['备注'],
  });
});

test('可生成封面页', () => {
  const model = slidesToExportModel(SLIDES, { coverTitle: '第5章 排序算法' });
  assert.equal(model[0].section, '封面');
  assert.equal(model[0].title, '第5章 排序算法');
  assert.equal(model.length, 3);
});
