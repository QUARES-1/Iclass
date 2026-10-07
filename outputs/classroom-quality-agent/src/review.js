// 人工审核模块（Sprint 1 功能切片⑤）。
// 教师可以修改、删除或确认 AI 生成的 PPT 内容；
// 未经教师确认的内容不能直接用于正式授课（对应“人在回路”与 DoD 要求）。

// 幻灯片状态：pending=待确认，confirmed=已确认，deleted=已删除。
export const SLIDE_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DELETED: 'deleted',
};

// 更新单张幻灯片的状态。
export function setSlideStatus(slides, slideId, status) {
  return slides.map((slide) =>
    slide.id === slideId ? { ...slide, status } : slide,
  );
}

// 一次确认所有未删除幻灯片；已删除内容保持原状态，不会被意外恢复。
export function confirmAllSlides(slides) {
  return slides.map((slide) =>
    slide.status === SLIDE_STATUS.DELETED
      ? slide
      : { ...slide, status: SLIDE_STATUS.CONFIRMED },
  );
}

// 更新单张幻灯片的内容（标题或正文要点）。
export function updateSlide(slides, slideId, patch = {}) {
  return slides.map((slide) => (slide.id === slideId ? { ...slide, ...patch } : slide));
}

// 统计审核进度，返回已确认/待确认/已删除的数量。
export function summarizeReview(slides) {
  const stats = { total: slides.length, confirmed: 0, pending: 0, deleted: 0 };
  for (const slide of slides) {
    stats[slide.status] = (stats[slide.status] || 0) + 1;
  }
  return stats;
}

// 判断当前 PPT 是否已满足“人工审核完成”的验收标准：
// 所有未删除的幻灯片都必须已被教师确认。
export function isReviewComplete(slides) {
  return slides.every((slide) => slide.status === SLIDE_STATUS.DELETED || slide.status === SLIDE_STATUS.CONFIRMED);
}

// 过滤出尚未确认的幻灯片，用于在界面上给出“不可用于正式授课”的提示。
export function unconfirmedSlides(slides) {
  return slides.filter((slide) => slide.status === SLIDE_STATUS.PENDING);
}
