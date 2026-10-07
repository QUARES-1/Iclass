import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeMaterials } from '../src/analyzer.js';
import { matchSupplements } from '../src/frontier.js';
import { generateOutline, toMarkdown } from '../src/pptGenerator.js';
import { deriveCoverContent, slidesToExportModel } from '../src/pptExport.js';
import {
  confirmAllSlides,
  isReviewComplete,
  setSlideStatus,
  updateSlide,
  SLIDE_STATUS,
} from '../src/review.js';

test('Sprint 1 主流程：资料解析到正式课件导出', () => {
  const materials = [{
    type: '教案',
    title: '线性表讲解',
    content: [
      '第2章 线性表',
      '教学目标：理解线性表的逻辑结构。',
      '教学重点：顺序表的插入与删除。',
      '教学难点：链表指针操作。',
      '知识点',
      '1. 线性表的定义',
      '2. 顺序表',
      '3. 链表',
    ].join('\n'),
  }];

  const analysis = analyzeMaterials(materials);
  assert.deepEqual(analysis.chapters, ['第2章 线性表']);
  assert.equal(analysis.knowledgePoints.length, 3);

  const supplements = matchSupplements(analysis.knowledgePoints);
  assert.ok(supplements.length > 0);
  assert.ok(supplements.some((item) => item.type === '技术' || item.type === '案例'));

  let slides = generateOutline(analysis, supplements);
  assert.equal(slides[0].section, '导入');
  assert.equal(slides.at(-1).section, '总结');
  assert.ok(slides.every((slide) => slide.status === SLIDE_STATUS.PENDING));

  const editedId = slides.find((slide) => slide.section === '讲解').id;
  const deletedId = slides.find((slide) => slide.section === '互动').id;
  slides = updateSlide(slides, editedId, { title: '线性表核心概念' });
  slides = setSlideStatus(slides, deletedId, SLIDE_STATUS.DELETED);
  slides = confirmAllSlides(slides);
  assert.equal(isReviewComplete(slides), true);

  const cover = deriveCoverContent(analysis, slides);
  const model = slidesToExportModel(slides, { ...cover, confirmedOnly: true });
  assert.equal(model[0].section, '封面');
  assert.equal(model[0].title, '第2章 线性表');
  assert.ok(model.some((slide) => slide.title === '线性表核心概念'));
  assert.ok(!model.some((slide) => slide.section === '互动'));

  const markdown = toMarkdown(slides, { confirmedOnly: true });
  assert.ok(markdown.includes('线性表核心概念'));
  assert.ok(!markdown.includes('课堂互动与讨论'));
});

test('重复资料不会在后续课件中制造重复知识页', () => {
  const materials = [
    { content: '第2章 线性表\n知识点：顺序表' },
    { content: '第2章 线性表\n知识点：顺序表' },
  ];
  const analysis = analyzeMaterials(materials);
  const slides = generateOutline(analysis, []);
  assert.equal(analysis.knowledgePoints.length, 1);
  assert.equal(slides.filter((slide) => slide.section === '讲解').length, 1);
});
