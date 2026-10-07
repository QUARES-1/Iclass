// PPT 导出模块：使用 PowerPoint 原生文本、形状和表格生成可编辑课件。
// PptxGenJS 构造器通过参数注入，使同一套逻辑可同时用于浏览器下载与 Node 验证。

export const PPT_THEME = Object.freeze({
  layoutName: 'TEACHING_16X9',
  width: 13.333,
  height: 7.5,
  fontFace: 'Microsoft YaHei',
  latinFontFace: 'Arial',
  colors: Object.freeze({
    paper: 'F7F8FC',
    white: 'FFFFFF',
    ink: '172033',
    muted: '5F6B7A',
    line: 'D9DFEA',
    indigo: '4F46E5',
    indigoLight: 'EEF2FF',
    blue: '2563EB',
    blueLight: 'EFF6FF',
    teal: '059669',
    tealLight: 'ECFDF5',
    amber: 'D97706',
    amberLight: 'FFFBEB',
    red: 'DC2626',
    redLight: 'FEF2F2',
  }),
});

const ALLOWED_LAYOUTS = new Set([
  'cover', 'intro', 'concept', 'algorithm', 'comparison', 'case', 'interaction', 'summary',
]);

const SECTION_ACCENTS = {
  封面: PPT_THEME.colors.indigo,
  导入: PPT_THEME.colors.blue,
  讲解: PPT_THEME.colors.indigo,
  案例: PPT_THEME.colors.teal,
  互动: PPT_THEME.colors.amber,
  总结: PPT_THEME.colors.red,
};

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function compactCoverText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)).trimEnd() + '…';
}

function normalizeMathText(value) {
  return cleanText(value)
    .replace(/n\s*\^\s*2/gi, 'n²')
    .replace(/n\s*\^\s*3/gi, 'n³')
    .replace(/O\s*\(\s*n\s*log\s*n\s*\)/gi, 'O(n log n)')
    .replace(/O\s*\(\s*n\s*2\s*\)/gi, 'O(n²)');
}

function asTextList(value) {
  return Array.isArray(value) ? value.map(normalizeMathText).filter(Boolean) : [];
}

function textUnits(value) {
  return [...normalizeMathText(value)].reduce((total, char) => {
    if (/\s/.test(char)) return total + 0.3;
    if (/[\u0000-\u00ff]/.test(char)) return total + 0.55;
    return total + 1;
  }, 0);
}

function estimatedLineCount(value, width, fontSize) {
  const unitsPerLine = Math.max(1, (width * 72) / (fontSize * 1.04));
  return Math.max(1, Math.ceil(textUnits(value) / unitsPerLine));
}

function estimatedTextHeight(value, width, fontSize) {
  return estimatedLineCount(value, width, fontSize) * (fontSize / 72) * 1.23 + 0.04;
}

function fittingFontSize(value, width, height, preferred = 18, minimum = 14.5) {
  for (let fontSize = preferred; fontSize >= minimum; fontSize -= 0.5) {
    if (estimatedTextHeight(value, width, fontSize) <= height) return fontSize;
  }
  return minimum;
}

function stackedTextLayout(values, width, availableHeight, options = {}) {
  const preferred = options.preferred ?? 18.5;
  const minimum = options.minimum ?? 14.5;
  const gap = options.gap ?? 0.06;
  const minRowHeight = options.minRowHeight ?? 0.7;
  const padding = options.padding ?? 0.14;
  const texts = values.length ? values : [''];

  for (let fontSize = preferred; fontSize >= minimum; fontSize -= 0.5) {
    const heights = texts.map((text) => Math.max(
      minRowHeight,
      estimatedTextHeight(text, width, fontSize) + padding,
    ));
    const total = heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, heights.length - 1);
    if (total <= availableHeight) return { fontSize, heights, gap };
  }

  const naturalHeights = texts.map((text) => Math.max(
    minRowHeight,
    estimatedTextHeight(text, width, minimum) + padding,
  ));
  const gapsHeight = gap * Math.max(0, naturalHeights.length - 1);
  const scale = Math.max(0.01, (availableHeight - gapsHeight) / naturalHeights.reduce((sum, height) => sum + height, 0));
  return {
    fontSize: minimum,
    heights: naturalHeights.map((height) => height * scale),
    gap,
  };
}

function chunkByTextLoad(items, options = {}) {
  const maxItems = options.maxItems ?? 4;
  const maxLines = options.maxLines ?? 10;
  const width = options.width ?? 5.05;
  const fontSize = options.fontSize ?? 16.5;
  const pages = [];
  let page = [];
  let lineLoad = 0;

  items.forEach((item) => {
    const itemLines = estimatedLineCount(item, width, fontSize);
    if (page.length && (page.length >= maxItems || lineLoad + itemLines > maxLines)) {
      pages.push(page);
      page = [];
      lineLoad = 0;
    }
    page.push(item);
    lineLoad += itemLines;
  });
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function splitLongText(value, maxLength = 62) {
  const text = normalizeMathText(value);
  if (!text || text.length <= maxLength) return text ? [text] : [];
  const pieces = [];
  let rest = text;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const breaks = ['。', '；', '，', '、', ';', ',', '：', ':'];
    let cut = Math.max(...breaks.map((token) => window.lastIndexOf(token)));
    if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;
    else cut += 1;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function continuationTitle(title) {
  return title;
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result.length ? result : [[]];
}

function paginateItem(item) {
  const rawBullets = asTextList(item.bullets);
  const rawSteps = asTextList(item.steps);
  const layout = selectSlideLayout(item);
  const isSummary = layout === 'summary';
  const bullets = isSummary ? rawBullets : rawBullets.flatMap((text) => splitLongText(text));
  const steps = rawSteps;
  const rows = Array.isArray(item.comparisonRows) ? item.comparisonRows.filter(Boolean) : [];
  const hasSteps = Array.isArray(item.steps);
  const hasRows = Array.isArray(item.comparisonRows);

  let pages;
  let field;
  if (isSummary) {
    // 总结要点保留原始条目，不因长句拆成多个“伪要点”；8 条以内优先放在同一页。
    pages = chunk(rawBullets, 8);
    field = 'bullets';
  } else if (rows.length > 5) {
    pages = chunk(rows, 5);
    field = 'comparisonRows';
  } else if (hasSteps && steps.length) {
    pages = chunkByTextLoad(steps, { maxItems: 4, maxLines: 10 });
    field = 'steps';
  } else if (layout === 'algorithm' && !hasSteps) {
    pages = chunkByTextLoad(rawBullets, { maxItems: 4, maxLines: 10 });
    field = 'bullets';
  } else {
    pages = chunk(bullets, 4);
    field = 'bullets';
  }

  return pages.map((pageItems, index) => {
    const page = {
      ...item,
      title: continuationTitle(normalizeMathText(item.title) || '教学内容'),
      bullets: field === 'bullets' ? pageItems : bullets.slice(0, 4),
      notes: asTextList(item.notes),
    };
    if (hasSteps) page.steps = field === 'steps' ? pageItems : steps;
    if (hasRows) page.comparisonRows = field === 'comparisonRows' ? pageItems : rows;
    return page;
  });
}

// 根据结构化教学内容生成封面文案，不显示项目阶段名称。
export function deriveCoverContent(analysis = {}, slides = []) {
  const activeSlides = (slides || []).filter((slide) => slide.status !== 'deleted');
  const chapters = asTextList(analysis.chapters);
  const objectives = asTextList(analysis.objectives);
  const knowledgePoints = asTextList(analysis.knowledgePoints);
  const firstContentSlide = activeSlides.find((slide) => slide.section === '讲解') || activeSlides[0];
  const rawTitle = chapters[0] || knowledgePoints[0] || firstContentSlide?.title || '课程教学课件';
  const title = compactCoverText(rawTitle, 42);
  let rawSubtitle = objectives[0] || knowledgePoints
    .filter((point) => point !== normalizeMathText(rawTitle))
    .slice(0, 3)
    .join(' · ');
  if (!rawSubtitle && firstContentSlide?.title !== rawTitle) rawSubtitle = firstContentSlide.title;

  return {
    coverTitle: title,
    coverSubtitle: compactCoverText(rawSubtitle || '课程教学课件', 72),
    coverKeywords: knowledgePoints.filter((point) => point !== title).slice(0, 3),
  };
}

// 兼容旧数据：显式 layout 优先，否则从环节、标题与正文语义推断。
export function selectSlideLayout(item = {}) {
  if (ALLOWED_LAYOUTS.has(item.layout)) return item.layout;
  if (item.section === '封面') return 'cover';
  if (item.section === '导入') return 'intro';
  if (item.section === '案例') return 'case';
  if (item.section === '互动') return 'interaction';
  if (item.section === '总结') return 'summary';

  const corpus = [item.title, ...(item.bullets || [])].join(' ');
  if (/比较|对比|区别|选择矩阵|复杂度分析|优缺点/.test(corpus)) return 'comparison';
  if (/算法|排序|查找|遍历|递归|分治|动态规划|贪心|回溯|指针|交换/.test(corpus)) {
    return 'algorithm';
  }
  return 'concept';
}

// 保留原有规则：仅排除“已删除”，不改变待确认/已确认状态的业务含义。
export function slidesToExportModel(slides, options = {}) {
  const items = (slides || [])
    .filter((slide) => slide.status !== 'deleted')
    .flatMap((slide) => {
      const item = {
        section: slide.section,
        title: slide.title,
        bullets: slide.bullets || [],
        notes: slide.notes || [],
      };
      ['layout', 'visualType', 'steps', 'metrics', 'comparisonRows', 'emphasis', 'example', 'counterExample'].forEach((field) => {
        if (slide[field] !== undefined) item[field] = slide[field];
      });
      return paginateItem(item);
    });

  if (options.coverTitle) {
    items.unshift({
      section: '封面',
      title: options.coverTitle,
      bullets: [options.coverSubtitle || '课程教学课件'],
      coverKeywords: asTextList(options.coverKeywords),
      notes: [],
      layout: 'cover',
    });
  }
  return items;
}

function addText(slide, text, options = {}) {
  slide.addText(normalizeMathText(text), {
    fontFace: PPT_THEME.fontFace,
    color: PPT_THEME.colors.ink,
    margin: 0,
    breakLine: false,
    ...options,
  });
}

function addLine(pptx, slide, x, y, w, h, color = PPT_THEME.colors.line, width = 1) {
  const normalizedX = w < 0 ? x + w : x;
  const normalizedY = h < 0 ? y + h : y;
  slide.addShape(pptx.ShapeType.line, {
    x: normalizedX,
    y: normalizedY,
    w: Math.abs(w),
    h: Math.abs(h),
    flipH: (w < 0) !== (h < 0),
    line: { color, width },
  });
}

function accentFor(item) {
  return SECTION_ACCENTS[item.section] || PPT_THEME.colors.indigo;
}

function addFooter(pptx, slide, index, total) {
  addLine(pptx, slide, 0.55, 7.08, 12.23, 0, PPT_THEME.colors.line, 0.6);
  addText(slide, '课堂教学课件', {
    x: 0.58, y: 7.16, w: 2.3, h: 0.18, fontSize: 9, color: PPT_THEME.colors.muted,
  });
  addText(slide, `${index + 1} / ${total}`, {
    x: 11.7, y: 7.14, w: 1.05, h: 0.2, fontSize: 9, color: PPT_THEME.colors.muted, align: 'right',
  });
}

function addContentFrame(pptx, slide, item, index, total) {
  slide.background = { color: PPT_THEME.colors.white };
  const accent = accentFor(item);
  addText(slide, item.section || '讲解', {
    x: 0.62, y: 0.31, w: 1.25, h: 0.28, fontSize: 11.5, bold: true, color: accent,
    charSpacing: 1.2,
  });
  addText(slide, item.title || '教学内容', {
    x: 0.62, y: 0.67, w: 11.9, h: 0.62, fontSize: 31, bold: true, color: PPT_THEME.colors.ink,
    valign: 'mid', fit: 'shrink',
  });
  addLine(pptx, slide, 0.62, 1.43, 1.08, 0, accent, 3);
  addLine(pptx, slide, 1.7, 1.43, 11.02, 0, PPT_THEME.colors.line, 0.8);
  addFooter(pptx, slide, index, total);
}

function addBulletList(slide, bullets, x, y, w, h, accent, fontSize = 19) {
  const list = asTextList(bullets).slice(0, 4);
  if (!list.length) {
    addText(slide, '请补充本页教学内容', { x, y, w, h: 0.45, fontSize, color: PPT_THEME.colors.muted });
    return;
  }
  const layout = stackedTextLayout(list, w - 0.28, h, {
    preferred: fontSize,
    minimum: 14.5,
    minRowHeight: 0.68,
    padding: 0.12,
  });
  let cursorY = y;
  list.forEach((text, index) => {
    const rowH = layout.heights[index];
    slide.addShape('ellipse', {
      x, y: cursorY + Math.min(0.18, Math.max(0.1, rowH / 2 - 0.06)), w: 0.12, h: 0.12,
      fill: { color: accent }, line: { color: accent },
    });
    addText(slide, text, {
      x: x + 0.28, y: cursorY, w: w - 0.28, h: rowH,
      fontSize: layout.fontSize, color: PPT_THEME.colors.ink, breakLine: false, valign: 'mid', fit: 'shrink',
    });
    cursorY += rowH + layout.gap;
  });
}

function addCoverSlide(pptx, item) {
  const slide = pptx.addSlide();
  slide.background = { color: PPT_THEME.colors.paper };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.22, h: 7.5,
    fill: { color: PPT_THEME.colors.indigo }, line: { color: PPT_THEME.colors.indigo },
  });
  addText(slide, '课程教学课件', {
    x: 0.78, y: 0.66, w: 2.8, h: 0.3, fontSize: 12, bold: true,
    color: PPT_THEME.colors.indigo, charSpacing: 2,
  });
  addText(slide, item.title, {
    x: 0.78, y: 1.55, w: 7.3, h: 1.7, fontSize: 44, bold: true,
    color: PPT_THEME.colors.ink, breakLine: false, valign: 'mid', fit: 'shrink',
  });
  addLine(pptx, slide, 0.8, 3.52, 1.4, 0, PPT_THEME.colors.indigo, 4);
  addText(slide, item.bullets?.[0] || '课程教学课件', {
    x: 0.8, y: 3.83, w: 7.15, h: 1.0, fontSize: 20, color: PPT_THEME.colors.muted,
    breakLine: false, valign: 'top', fit: 'shrink',
  });

  const keywords = asTextList(item.coverKeywords).slice(0, 3);
  const visualItems = keywords.length ? keywords : ['理解核心概念', '掌握分析方法', '完成课堂实践'];
  addText(slide, '本课脉络', {
    x: 8.8, y: 1.23, w: 2.6, h: 0.36, fontSize: 14, bold: true, color: PPT_THEME.colors.muted,
  });
  addLine(pptx, slide, 8.82, 1.72, 3.55, 0, PPT_THEME.colors.line, 1);
  const visualTop = 1.93;
  const visualLayout = stackedTextLayout(visualItems, 2.7, 4.48, {
    preferred: 17.5,
    minimum: 14.5,
    minRowHeight: 0.82,
    padding: 0.16,
    gap: 0.08,
  });
  let visualY = visualTop;
  visualItems.forEach((text, index) => {
    const rowH = visualLayout.heights[index];
    addText(slide, `0${index + 1}`, {
      x: 8.82, y: visualY + 0.08, w: 0.72, h: 0.48, fontSize: 23, bold: true,
      color: PPT_THEME.colors.indigo,
    });
    addText(slide, text, {
      x: 9.65, y: visualY, w: 2.7, h: rowH, fontSize: visualLayout.fontSize,
      color: PPT_THEME.colors.ink, valign: 'mid', fit: 'shrink',
    });
    visualY += rowH + visualLayout.gap;
  });
  addText(slide, '可编辑 · 可复用 · 面向课堂讲授', {
    x: 0.8, y: 6.72, w: 4.1, h: 0.25, fontSize: 10.5, color: PPT_THEME.colors.muted,
  });
  return slide;
}

function addIntroSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const accent = PPT_THEME.colors.blue;
  const bullets = asTextList(item.bullets).slice(0, 4);
  const positions = [
    [0.72, 1.87], [6.77, 1.87], [0.72, 4.36], [6.77, 4.36],
  ];
  addLine(pptx, slide, 6.55, 1.8, 0, 4.92, PPT_THEME.colors.line, 1);
  addLine(pptx, slide, 0.68, 4.12, 12.02, 0, PPT_THEME.colors.line, 1);
  positions.forEach(([x, y], i) => {
    const text = bullets[i] || (i === 0 ? '从一个真实问题开始本课' : '');
    if (!text) return;
    addText(slide, `0${i + 1}`, { x, y, w: 0.65, h: 0.42, fontSize: 19, bold: true, color: accent });
    addText(slide, text, {
      x: x + 0.85, y: y - 0.02, w: 4.95, h: 1.58, fontSize: 19.5, color: PPT_THEME.colors.ink,
      valign: 'top', fit: 'shrink',
    });
  });
  return slide;
}

function addConceptSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const bullets = asTextList(item.bullets);
  const accent = PPT_THEME.colors.indigo;
  addText(slide, '核心定义', {
    x: 0.72, y: 1.86, w: 2, h: 0.35, fontSize: 14, bold: true, color: accent,
  });
  addText(slide, bullets[0] || item.title, {
    x: 0.72, y: 2.33, w: 5.35, h: 2.75, fontSize: 25, bold: true,
    color: PPT_THEME.colors.ink, valign: 'mid', fit: 'shrink',
  });
  addLine(pptx, slide, 6.45, 1.86, 0, 4.86, PPT_THEME.colors.line, 1);
  const example = normalizeMathText(item.example);
  const counterExample = normalizeMathText(item.counterExample);
  const hasAiExamples = Boolean(example || counterExample);
  addText(slide, hasAiExamples ? '示例与反例' : '关键理解与辨析', {
    x: 6.82, y: 1.86, w: 3, h: 0.35, fontSize: 14, bold: true, color: accent,
  });
  if (hasAiExamples) {
    if (example) {
      addText(slide, '示例', { x: 6.84, y: 2.36, w: 0.85, h: 0.3, fontSize: 13, bold: true, color: accent });
      addText(slide, example, {
        x: 7.72, y: 2.31, w: 4.7, h: 1.35,
        fontSize: fittingFontSize(example, 4.7, 1.35, 18.5, 14.5), valign: 'top', fit: 'shrink',
      });
    }
    if (counterExample) {
      addLine(pptx, slide, 6.84, 4.14, 5.56, 0, PPT_THEME.colors.line, 0.8);
      addText(slide, '反例', { x: 6.84, y: 4.5, w: 0.85, h: 0.3, fontSize: 13, bold: true, color: accent });
      addText(slide, counterExample, {
        x: 7.72, y: 4.43, w: 4.7, h: 1.48,
        fontSize: fittingFontSize(counterExample, 4.7, 1.48, 18.5, 14.5), valign: 'top', fit: 'shrink',
      });
    }
  } else {
    addBulletList(slide, bullets.slice(1), 6.84, 2.33, 5.7, 3.95, accent, 18.5);
  }
  return slide;
}

function parseMetrics(item) {
  const result = [];
  const provided = item.metrics;
  if (Array.isArray(provided)) {
    provided.forEach((entry) => {
      if (typeof entry === 'string') result.push({ label: '指标', value: normalizeMathText(entry) });
      else if (entry && typeof entry === 'object') {
        result.push({ label: cleanText(entry.label || entry.name || '指标'), value: normalizeMathText(entry.value || entry.text) });
      }
    });
  } else if (provided && typeof provided === 'object') {
    Object.entries(provided).forEach(([label, value]) => result.push({ label, value: normalizeMathText(value) }));
  }
  asTextList(item.bullets).forEach((text) => {
    const match = text.match(/^(时间复杂度|空间复杂度|稳定性|适用场景|特点)[：:]\s*(.+)$/);
    if (match && !result.some((entry) => entry.label === match[1])) result.push({ label: match[1], value: match[2] });
  });
  return result.filter((entry) => entry.value).slice(0, 4);
}

function algorithmSteps(item) {
  const metricsPattern = /^(时间复杂度|空间复杂度|稳定性|适用场景|特点)[：:]/;
  const explicit = asTextList(item.steps);
  return (explicit.length ? explicit : asTextList(item.bullets).filter((text) => !metricsPattern.test(text))).slice(0, 4);
}

function addAlgorithmSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const accent = PPT_THEME.colors.indigo;
  const steps = algorithmSteps(item);
  const metrics = parseMetrics(item);
  const showsArrayDemo = item.visualType === 'array'
    || /排序|划分|交换/.test(normalizeMathText(item.title));

  addText(slide, '步骤演示', { x: 0.72, y: 1.82, w: 2, h: 0.34, fontSize: 14, bold: true, color: accent });
  if (showsArrayDemo) {
    addText(slide, '示例输入', { x: 0.72, y: 2.22, w: 1.05, h: 0.3, fontSize: 12, color: PPT_THEME.colors.muted });
    [5, 2, 4, 1].forEach((value, i) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: 1.75 + i * 0.69, y: 2.14, w: 0.55, h: 0.55,
        fill: { color: i === 1 ? PPT_THEME.colors.indigoLight : PPT_THEME.colors.white },
        line: { color: i === 1 ? accent : PPT_THEME.colors.line, width: 1.2 },
      });
      addText(slide, String(value), {
        x: 1.75 + i * 0.69, y: 2.25, w: 0.55, h: 0.22, fontSize: 17, bold: true, align: 'center',
      });
    });
  }
  const startY = showsArrayDemo ? 2.95 : 2.25;
  const visibleSteps = steps.length ? steps : ['识别输入与目标', '按规则执行关键操作', '检查结果并解释复杂度'];
  const stepTextWidth = metrics.length ? 5.05 : 10.72;
  const stepLayout = stackedTextLayout(visibleSteps, stepTextWidth, 6.58 - startY, {
    preferred: 18.5,
    minimum: 15,
    minRowHeight: 0.72,
    padding: 0.14,
    gap: 0.06,
  });
  let stepY = startY;
  const stepPositions = stepLayout.heights.map((rowH) => {
    const position = { y: stepY, h: rowH };
    stepY += rowH + stepLayout.gap;
    return position;
  });
  visibleSteps.forEach((text, i) => {
    const position = stepPositions[i];
    const circleY = position.y + Math.max(0.04, Math.min(0.14, (position.h - 0.45) / 2));
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 0.78, y: circleY, w: 0.45, h: 0.45,
      fill: { color: accent }, line: { color: accent },
    });
    addText(slide, String(i + 1), {
      x: 0.78, y: circleY + 0.09, w: 0.45, h: 0.18,
      fontSize: 12.5, bold: true, color: PPT_THEME.colors.white, align: 'center',
    });
    if (i < visibleSteps.length - 1) {
      const nextCircleY = stepPositions[i + 1].y + Math.max(0.04, Math.min(0.14, (stepPositions[i + 1].h - 0.45) / 2));
      addLine(pptx, slide, 1.0, circleY + 0.47, 0, nextCircleY - circleY - 0.49, PPT_THEME.colors.line, 1.4);
    }
    addText(slide, text, {
      x: 1.48, y: position.y, w: stepTextWidth, h: position.h,
      fontSize: stepLayout.fontSize, valign: 'mid', fit: 'shrink',
    });
  });

  if (!metrics.length) return slide;

  addLine(pptx, slide, 6.85, 1.82, 0, 4.88, PPT_THEME.colors.line, 1);
  addText(slide, '算法画像', {
    x: 7.2, y: 1.82, w: 2.2, h: 0.34, fontSize: 14, bold: true, color: accent,
  });
  const info = metrics;
  const infoLayout = stackedTextLayout(info.map((entry) => entry.value), 3.85, 4.15, {
    preferred: 17.5,
    minimum: 14.5,
    minRowHeight: 0.78,
    padding: 0.16,
    gap: 0.06,
  });
  let infoY = 2.34;
  info.forEach((entry, i) => {
    const rowH = infoLayout.heights[i];
    const y = infoY;
    addText(slide, entry.label, { x: 7.2, y, w: 1.32, h: 0.3, fontSize: 12.5, bold: true, color: accent });
    addText(slide, entry.value, {
      x: 8.65, y: y - 0.03, w: 3.85, h: rowH,
      fontSize: infoLayout.fontSize, valign: 'top', fit: 'shrink',
    });
    addLine(pptx, slide, 7.2, y + rowH + 0.05, 5.3, 0, PPT_THEME.colors.line, 0.7);
    infoY += rowH + infoLayout.gap;
  });
  return slide;
}

function normalizeComparisonRows(item) {
  if (Array.isArray(item.comparisonRows) && item.comparisonRows.length) {
    return item.comparisonRows.slice(0, 5).map((row, index) => {
      if (Array.isArray(row)) return [normalizeMathText(row[0] || `维度 ${index + 1}`), normalizeMathText(row[1] || '')];
      if (row && typeof row === 'object') {
        return [normalizeMathText(row.label || row.name || row.dimension || `维度 ${index + 1}`), normalizeMathText(row.value || row.text || row.conclusion || '')];
      }
      return [`维度 ${index + 1}`, normalizeMathText(row)];
    });
  }
  return asTextList(item.bullets).slice(0, 5).map((text, index) => {
    const parts = text.split(/[：:]/, 2);
    return parts.length === 2 ? [parts[0], parts[1]] : [`要点 ${index + 1}`, text];
  });
}

function addComparisonSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const rows = normalizeComparisonRows(item);
  const bodyRows = rows.length ? rows : [['比较维度', '请补充比较对象与结论']];
  const x = 0.75;
  const y = 1.87;
  const leftW = 2.65;
  const rightW = 9.17;
  const rowH = 0.76;
  const drawCell = (cellX, cellY, cellW, text, fill, color, bold = false) => {
    slide.addShape(pptx.ShapeType.rect, {
      x: cellX, y: cellY, w: cellW, h: rowH,
      fill: { color: fill }, line: { color: PPT_THEME.colors.line, width: 0.8 },
    });
    addText(slide, text, {
      x: cellX + 0.16, y: cellY + 0.08, w: cellW - 0.32, h: rowH - 0.16,
      fontSize: fittingFontSize(text, cellW - 0.32, rowH - 0.16, 17.5, 14.5),
      bold, color, valign: 'mid', fit: 'shrink',
    });
  };
  drawCell(x, y, leftW, '比较维度', PPT_THEME.colors.indigo, PPT_THEME.colors.white, true);
  drawCell(x + leftW, y, rightW, '教学结论', PPT_THEME.colors.indigo, PPT_THEME.colors.white, true);
  bodyRows.forEach(([label, conclusion], rowIndex) => {
    const rowY = y + (rowIndex + 1) * rowH;
    const fill = rowIndex % 2 ? PPT_THEME.colors.white : PPT_THEME.colors.indigoLight;
    drawCell(x, rowY, leftW, label, fill, PPT_THEME.colors.ink, true);
    drawCell(x + leftW, rowY, rightW, conclusion, fill, PPT_THEME.colors.ink);
  });
  return slide;
}

function splitLabel(text, fallback) {
  const match = normalizeMathText(text).match(/^([^：:]{1,12})[：:]\s*(.+)$/);
  return match ? [match[1], match[2]] : [fallback, normalizeMathText(text)];
}

function addCaseSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const accent = PPT_THEME.colors.teal;
  const defaults = ['业务场景', '排序依据', '技术选择', '实际价值'];
  const bullets = asTextList(item.bullets).slice(0, 4);
  const entries = (bullets.length ? bullets : ['请补充案例事实']).map((text, i) => splitLabel(text, defaults[i] || `环节 ${i + 1}`));
  addLine(pptx, slide, 1.22, 2.14, 0, Math.max(0.2, (entries.length - 1) * 1.08), PPT_THEME.colors.line, 2);
  entries.forEach(([label, description], i) => {
    const y = 1.93 + i * 1.08;
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 0.94, y, w: 0.56, h: 0.56, fill: { color: accent }, line: { color: accent },
    });
    addText(slide, String(i + 1), {
      x: 0.94, y: y + 0.11, w: 0.56, h: 0.2, fontSize: 13, bold: true,
      color: PPT_THEME.colors.white, align: 'center',
    });
    addText(slide, label, { x: 1.82, y: y + 0.01, w: 1.9, h: 0.36, fontSize: 14, bold: true, color: accent });
    addText(slide, description, {
      x: 3.65, y: y - 0.04, w: 8.55, h: 0.67,
      fontSize: fittingFontSize(description, 8.55, 0.67, 18.5, 14.5), valign: 'mid', fit: 'shrink',
    });
  });
  return slide;
}

function addInteractionSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const accent = PPT_THEME.colors.amber;
  const bullets = asTextList(item.bullets);
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.72, y: 1.86, w: 11.88, h: 2.05,
    fill: { color: PPT_THEME.colors.amberLight }, line: { color: accent, width: 1.2 }, radius: 0.06,
  });
  addText(slide, '主问题', { x: 1.0, y: 2.12, w: 1.2, h: 0.3, fontSize: 13, bold: true, color: accent });
  addText(slide, bullets[0] || '请围绕本课核心内容提出一个可讨论的问题。', {
    x: 1.0, y: 2.55, w: 11.28, h: 1.02, fontSize: 24, bold: true, valign: 'mid', fit: 'shrink',
  });
  addText(slide, '思考提示', { x: 0.78, y: 4.29, w: 1.4, h: 0.32, fontSize: 14, bold: true, color: accent });
  const prompts = bullets.slice(1, 4);
  (prompts.length ? prompts : ['明确条件和目标', '说明判断依据', '给出结论并解释原因']).forEach((text, i) => {
    const x = 0.82 + i * 4.02;
    addText(slide, `0${i + 1}`, { x, y: 4.84, w: 0.6, h: 0.38, fontSize: 17, bold: true, color: accent });
    addText(slide, text, {
      x: x + 0.72, y: 4.77, w: 3.02, h: 1.18,
      fontSize: fittingFontSize(text, 3.02, 1.18, 17.5, 14.5), valign: 'top', fit: 'shrink',
    });
    if (i < 2) addLine(pptx, slide, x + 3.82, 4.75, 0, 1.45, PPT_THEME.colors.line, 0.8);
  });
  return slide;
}

function addSummarySlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const accent = PPT_THEME.colors.red;
  const bullets = asTextList(item.bullets).slice(0, 8);
  if (bullets.length > 4) {
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 5.05, y: 1.72, w: 3.25, h: 0.78,
      fill: { color: PPT_THEME.colors.redLight }, line: { color: accent, width: 1.3 },
    });
    addText(slide, '核心要点', { x: 5.25, y: 1.96, w: 2.85, h: 0.28, fontSize: 20, bold: true, color: accent, align: 'center' });
    const columnWidth = 5.68;
    const rows = Math.ceil(bullets.length / 2);
    const gridTop = 2.7;
    const gridBottom = 6.68;
    const rowGap = 0.12;
    const rowH = (gridBottom - gridTop - rowGap * (rows - 1)) / rows;
    const contentH = rowH - 0.2;
    const gridFontSize = bullets.reduce((fontSize, text) => Math.min(
      fontSize,
      fittingFontSize(text, columnWidth - 0.4, contentH, 17, 14.5),
    ), 17);
    bullets.forEach((text, i) => {
      const column = i % 2;
      const row = Math.floor(i / 2);
      const pos = {
        x: column === 0 ? 0.78 : 6.88,
        y: gridTop + row * (rowH + rowGap),
      };
      slide.addShape(pptx.ShapeType.rect, {
        x: pos.x, y: pos.y, w: columnWidth, h: rowH,
        fill: { color: PPT_THEME.colors.white }, line: { color: PPT_THEME.colors.line, width: 1 },
      });
      addText(slide, text, {
        x: pos.x + 0.2, y: pos.y + 0.1, w: columnWidth - 0.4, h: contentH,
        fontSize: gridFontSize, bold: i === 0, align: 'center', valign: 'mid', fit: 'shrink',
      });
    });
    return slide;
  }
  const positions = [
    { x: 0.75, y: 2.05, w: 3.4, h: 1.15 },
    { x: 9.18, y: 2.05, w: 3.4, h: 1.15 },
    { x: 0.75, y: 5.08, w: 3.4, h: 1.15 },
    { x: 9.18, y: 5.08, w: 3.4, h: 1.15 },
  ];
  const center = { x: 6.68, y: 3.88 };
  positions.forEach((pos, i) => {
    if (!bullets[i]) return;
    const endX = i % 2 === 0 ? pos.x + pos.w : pos.x;
    const endY = pos.y + pos.h / 2;
    addLine(pptx, slide, center.x, center.y, endX - center.x, endY - center.y, PPT_THEME.colors.line, 1.2);
  });
  positions.forEach((pos, i) => {
    if (!bullets[i]) return;
    slide.addShape(pptx.ShapeType.rect, {
      ...pos, fill: { color: PPT_THEME.colors.white }, line: { color: PPT_THEME.colors.line, width: 1 },
    });
    addText(slide, bullets[i], {
      x: pos.x + 0.18, y: pos.y + 0.13, w: pos.w - 0.36, h: pos.h - 0.26,
      fontSize: fittingFontSize(bullets[i], pos.w - 0.36, pos.h - 0.26, 17.5, 14.5),
      bold: i === 0, align: 'center', valign: 'mid', fit: 'shrink',
    });
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 5.1, y: 3.15, w: 3.15, h: 1.45,
    fill: { color: PPT_THEME.colors.redLight }, line: { color: accent, width: 1.5 },
  });
  addText(slide, '核心要点', { x: 5.3, y: 3.65, w: 2.75, h: 0.35, fontSize: 23, bold: true, color: accent, align: 'center' });
  if (!bullets.length) addText(slide, '请补充本课关键结论', { x: 0.8, y: 2.1, w: 3.4, h: 0.5, fontSize: 18, color: PPT_THEME.colors.muted });
  return slide;
}

function addFallbackSlide(pptx, item, index, total) {
  const slide = pptx.addSlide();
  addContentFrame(pptx, slide, item, index, total);
  const bullets = asTextList(item.bullets);
  addText(slide, '核心内容', { x: 0.72, y: 1.86, w: 2, h: 0.34, fontSize: 14, bold: true, color: accentFor(item) });
  addBulletList(slide, bullets.slice(0, 2), 0.76, 2.33, 5.55, 3.8, accentFor(item), 19);
  addLine(pptx, slide, 6.55, 1.86, 0, 4.82, PPT_THEME.colors.line, 1);
  addText(slide, '补充说明', { x: 6.88, y: 1.86, w: 2, h: 0.34, fontSize: 14, bold: true, color: accentFor(item) });
  addBulletList(slide, bullets.slice(2), 6.9, 2.33, 5.55, 3.8, accentFor(item), 19);
  return slide;
}

// 构建 pptx 实例（不触发下载），由调用方决定 writeFile 或浏览器下载。
export function buildPresentation(model, PptxGenJS) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: PPT_THEME.layoutName, width: PPT_THEME.width, height: PPT_THEME.height });
  pptx.layout = PPT_THEME.layoutName;
  pptx.author = '课堂质量改进智能体';
  pptx.subject = 'Sprint 1 课前智能备课';
  pptx.lang = 'zh-CN';
  pptx.theme = {
    headFontFace: PPT_THEME.fontFace,
    bodyFontFace: PPT_THEME.fontFace,
    lang: 'zh-CN',
  };
  const items = Array.isArray(model) ? model : [];
  const cover = items.find((item) => selectSlideLayout(item) === 'cover');
  pptx.title = cover?.title || items[0]?.title || '课程教学课件';

  items.forEach((item, index) => {
    const layout = selectSlideLayout(item);
    let slide;
    if (layout === 'cover') slide = addCoverSlide(pptx, item);
    else if (layout === 'intro') slide = addIntroSlide(pptx, item, index, items.length);
    else if (layout === 'concept') slide = addConceptSlide(pptx, item, index, items.length);
    else if (layout === 'algorithm') slide = addAlgorithmSlide(pptx, item, index, items.length);
    else if (layout === 'comparison') slide = addComparisonSlide(pptx, item, index, items.length);
    else if (layout === 'case') slide = addCaseSlide(pptx, item, index, items.length);
    else if (layout === 'interaction') slide = addInteractionSlide(pptx, item, index, items.length);
    else if (layout === 'summary') slide = addSummarySlide(pptx, item, index, items.length);
    else slide = addFallbackSlide(pptx, item, index, items.length);

    if (asTextList(item.notes).length) slide.addNotes(asTextList(item.notes).join('\n'));
  });
  return pptx;
}
