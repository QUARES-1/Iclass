import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setSlideStatus,
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
