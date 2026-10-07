import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setSlideStatus,
  confirmAllSlides,
  updateSlide,
  summarizeReview,
  isReviewComplete,
  unconfirmedSlides,
  SLIDE_STATUS,
} from '../src/review.js';

const SLIDES = [
  { id: 's1', title: 'A', status: 'pending' },
  { id: 's2', title: 'B', status: 'pending' },
  { id: 's3', title: 'C', status: 'pending' },
];

test('可以确认一张幻灯片', () => {
  const next = setSlideStatus(SLIDES, 's1', SLIDE_STATUS.CONFIRMED);
  assert.equal(next[0].status, SLIDE_STATUS.CONFIRMED);
  // 不应修改其它幻灯片。
  assert.equal(next[1].status, SLIDE_STATUS.PENDING);
});

test('可以编辑幻灯片内容', () => {
  const next = updateSlide(SLIDES, 's2', { title: '新标题', bullets: ['要点'] });
  assert.equal(next[1].title, '新标题');
  assert.deepEqual(next[1].bullets, ['要点']);
});

test('统计审核进度', () => {
  let next = setSlideStatus(SLIDES, 's1', SLIDE_STATUS.CONFIRMED);
  next = setSlideStatus(next, 's3', SLIDE_STATUS.DELETED);
  const stats = summarizeReview(next);
  assert.equal(stats.total, 3);
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.deleted, 1);
});

test('只有全部幻灯片确认或删除后才算审核完成', () => {
  let next = setSlideStatus(SLIDES, 's1', SLIDE_STATUS.CONFIRMED);
  next = setSlideStatus(next, 's2', SLIDE_STATUS.CONFIRMED);
  next = setSlideStatus(next, 's3', SLIDE_STATUS.DELETED);
  assert.equal(isReviewComplete(next), true);

  const incomplete = setSlideStatus(SLIDES, 's1', SLIDE_STATUS.CONFIRMED);
  assert.equal(isReviewComplete(incomplete), false);
  assert.equal(unconfirmedSlides(incomplete).length, 2);
});

test('全部确认会确认所有未删除页面并保留已删除状态', () => {
  const input = [
    { id: 's1', title: 'A', status: SLIDE_STATUS.PENDING },
    { id: 's2', title: 'B', status: SLIDE_STATUS.CONFIRMED },
    { id: 's3', title: 'C', status: SLIDE_STATUS.DELETED },
  ];
  const next = confirmAllSlides(input);
  assert.deepEqual(next.map((slide) => slide.status), [
    SLIDE_STATUS.CONFIRMED,
    SLIDE_STATUS.CONFIRMED,
    SLIDE_STATUS.DELETED,
  ]);
  assert.equal(isReviewComplete(next), true);
});

test('状态和内容更新不会修改原数组', () => {
  const original = structuredClone(SLIDES);
  setSlideStatus(SLIDES, 's1', SLIDE_STATUS.CONFIRMED);
  updateSlide(SLIDES, 's2', { title: '修改后' });
  confirmAllSlides(SLIDES);
  assert.deepEqual(SLIDES, original);
});

test('更新不存在的幻灯片不会改变任何内容', () => {
  assert.deepEqual(setSlideStatus(SLIDES, 'missing', SLIDE_STATUS.DELETED), SLIDES);
  assert.deepEqual(updateSlide(SLIDES, 'missing', { title: 'X' }), SLIDES);
});
