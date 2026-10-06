// PPT 导出模块：把审阅后的幻灯片转换为可下载的 PowerPoint（.pptx）。
// 排版使用 PptxGenJS（MIT 协议），浏览器端由 public/vendor/pptxgen.bundle.js 提供全局对象。
// 本模块不直接 import pptxgenjs，而是通过参数注入 PptxGenJS 构造器，
// 从而在浏览器（全局 PptxGenJS）与 Node（本地验证）中复用同一套排版逻辑。

function compactCoverText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)).trimEnd() + '…';
}

// 根据结构化教学内容生成封面文案，不再展示项目阶段名称。
export function deriveCoverContent(analysis = {}, slides = []) {
  const activeSlides = (slides || []).filter((slide) => slide.status !== 'deleted');
  const chapters = Array.isArray(analysis.chapters) ? analysis.chapters.filter(Boolean) : [];
  const objectives = Array.isArray(analysis.objectives) ? analysis.objectives.filter(Boolean) : [];
  const knowledgePoints = Array.isArray(analysis.knowledgePoints)
    ? analysis.knowledgePoints.filter(Boolean)
    : [];

  const firstContentSlide = activeSlides.find((slide) => slide.section === '讲解') || activeSlides[0];
  const rawTitle = chapters[0] || knowledgePoints[0] || (firstContentSlide && firstContentSlide.title) || '课程教学课件';
  const title = compactCoverText(rawTitle, 42);

  let rawSubtitle = objectives[0] || knowledgePoints
    .filter((point) => String(point).trim() !== String(rawTitle).trim())
    .slice(0, 3)
    .join(' · ');
  if (!rawSubtitle && firstContentSlide && firstContentSlide.title !== rawTitle) {
    rawSubtitle = firstContentSlide.title;
  }

  return {
    coverTitle: title,
    coverSubtitle: compactCoverText(rawSubtitle || '课程教学课件', 72),
  };
}

// 把内部幻灯片转换为导出用的内容模型，并过滤掉“已删除”的幻灯片。
export function slidesToExportModel(slides, options = {}) {
  const items = (slides || [])
    .filter((slide) => slide.status !== 'deleted')
    .map((slide) => ({
      section: slide.section,
      title: slide.title,
      bullets: slide.bullets || [],
      notes: slide.notes || [],
    }));

  // 可选封面：把课程章节作为封面主标题。
  if (options.coverTitle) {
    items.unshift({
      section: '封面',
      title: options.coverTitle,
      bullets: [options.coverSubtitle || '课程教学课件'],
      notes: [],
    });
  }
  return items;
}

// 各环节的主题色，让不同环节的幻灯片有视觉区分。
const SECTION_COLORS = {
  导入: '2563EB',
  讲解: '4F46E5',
  案例: '059669',
  互动: 'D97706',
  总结: 'DC2626',
};

// 构建 pptx 实例（不触发下载），返回 PptxGenJS 实例供调用方 write。
export function buildPresentation(model, PptxGenJS) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'SPRINT1_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'SPRINT1_16x9';
  pptx.author = '课堂质量改进智能体';
  const cover = model.find((item) => item.section === '封面');
  pptx.title = cover ? cover.title : '课程教学课件';

  for (const item of model) {
    if (item.section === '封面') {
      addCoverSlide(pptx, item);
    } else {
      addContentSlide(pptx, item);
    }
  }
  return pptx;
}

// 封面页：居中主标题 + 副标题，使用品牌色背景。
function addCoverSlide(pptx, item) {
  const slide = pptx.addSlide();
  slide.background = { color: '4F46E5' };
  slide.addText(item.title, {
    x: 0.8, y: 2.3, w: 11.7, h: 1.3, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center',
  });
  slide.addText(item.bullets[0] || '', {
    x: 0.8, y: 3.8, w: 11.7, h: 0.6, fontSize: 18, color: 'E0E7FF', align: 'center',
  });
}

// 内容页：环节标签 + 标题 + 分隔线 + 要点 + 演讲者备注。
function addContentSlide(pptx, item) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };
  const accent = SECTION_COLORS[item.section] || '4F46E5';

  slide.addText(item.section, {
    x: 0.5, y: 0.32, w: 12.33, h: 0.32, fontSize: 12, bold: true, color: accent,
  });
  slide.addText(item.title, {
    x: 0.5, y: 0.62, w: 12.33, h: 0.9, fontSize: 28, bold: true, color: '1F2937',
  });
  slide.addShape(pptx.ShapeType.line, {
    x: 0.52, y: 1.52, w: 12.3, h: 0, line: { color: 'E5E7EB', width: 1 },
  });

  const bullets = item.bullets.map((text) => ({
    text,
    options: { bullet: { code: '2022' }, breakLine: true, paraSpaceAfter: 8 },
  }));
  slide.addText(bullets, {
    x: 0.75, y: 1.7, w: 12, h: 5.4, fontSize: 18, color: '374151', valign: 'top', lineSpacingMultiple: 1.15,
  });

  if (item.notes.length) {
    slide.addNotes(item.notes.join('\n'));
  }
}
