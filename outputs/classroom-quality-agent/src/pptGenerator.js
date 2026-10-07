// PPT 生成模块（Sprint 1 功能切片④）。
// 按照“导入 → 讲解 → 案例 → 互动 → 总结”的教学结构，
// 把内容理解与前沿补充的结果组织成一份可编辑的 PPT 大纲与初稿。

// 生成不重复的幻灯片 ID。
function createIdFactory() {
  let n = 1;
  return () => `slide-${String(n++).padStart(3, '0')}`;
}

// 归一化文本：去掉空白与常见中英文标点，便于做容错的包含判断。
function normalize(text) {
  return String(text || '').replace(/[\s，。、；：！？（）()《》〈〉,.!?;:'"“”‘’]/g, '');
}

// 判断知识点是否命中重点/难点列表（用于给幻灯片打标签）。
function containsAny(text, list) {
  return (list || []).some((item) => {
    const a = normalize(text);
    const b = normalize(item);
    return a && b && (a.includes(b) || b.includes(a));
  });
}

// 构造一张幻灯片。bullets 为正文要点，notes 为讲解备注，status 初始为待审核。
function makeSlide(nextId, section, title, bullets, notes = [], options = {}) {
  return {
    id: nextId(),
    section,
    title,
    bullets: (bullets || []).filter(Boolean),
    notes: (notes || []).filter(Boolean),
    ...options,
    status: 'pending',
  };
}

// 只提供可选的视觉语义，不改变教学内容与审核状态。
function inferKnowledgeLayout(point) {
  const text = String(point || '');
  if (/比较|对比|区别|选择|复杂度/.test(text)) return 'comparison';
  if (/算法|排序|查找|遍历|递归|分治|动态规划|贪心|回溯/.test(text)) return 'algorithm';
  return 'concept';
}

// 生成互动提问：把教学目标转化为课堂提问，引导学生思考。
function buildInteractionQuestions(analysis) {
  const base = analysis.objectives.length
    ? analysis.objectives.slice(0, 3)
    : analysis.knowledgePoints.slice(0, 3);
  const questions = base.map((item) => `请思考：${item}，结合一个生活/工程实例说明你的理解。`);
  questions.push('小组讨论：本章核心算法在真实产品中可能遇到哪些性能瓶颈？');
  return questions;
}

// 主入口：根据解析结果与前沿补充生成 PPT 大纲。
export function generateOutline(analysis, supplements = []) {
  const nextId = createIdFactory();
  const slides = [];

  // 1) 导入：用教学目标 + 问题驱动引入本章主题。
  const introBullets = [
    ...analysis.objectives.slice(0, 3).map((o) => `学习目标：${o}`),
    '以一个贴近实际的工程问题引入本章核心主题',
  ];
  slides.push(makeSlide(
    nextId,
    '导入',
    '课程导入',
    introBullets,
    ['通过问题驱动，激活学生的已有认知。'],
    { layout: 'intro' },
  ));

  // 2) 讲解：每个知识点一张幻灯片，并标注重点/难点。
  for (const point of analysis.knowledgePoints) {
    const tags = [];
    if (containsAny(point, analysis.keyPoints)) tags.push('重点');
    if (containsAny(point, analysis.difficultPoints)) tags.push('难点');

    const bullets = [tags.length ? `${point}（${tags.join('、')}）` : point];
    if (tags.includes('重点')) {
      bullets.push('讲解要点：结合步骤拆解与示例讲清核心思想');
    }
    if (tags.includes('难点')) {
      bullets.push('讲解要点：补充反例与复杂度分析，帮助学生突破难点');
    }

    // 把命中该知识点的前沿补充作为备注，供教师讲解时参考。
    const related = supplements.filter((item) =>
      containsAny(item.matchedBy || '', [point]),
    );
    const notes = related.map((item) =>
      `[${item.type}·${item.needsVerify ? '待核验' : '已核验'}] ${item.title}：${item.description}（来源：${item.source}）`,
    );

    slides.push(makeSlide(nextId, '讲解', point, bullets, notes, {
      layout: inferKnowledgeLayout(point),
      emphasis: tags,
    }));
  }

  // 3) 案例：来自前沿补充中的行业案例。
  const cases = supplements.filter((item) => item.type === '案例');
  if (cases.length) {
    slides.push(
      makeSlide(
        nextId,
        '案例',
        '行业案例与应用',
        cases.map((item) => `${item.title}：${item.description}`),
        cases.map((item) => `来源：${item.source}（${item.needsVerify ? '待核验' : '已核验'}）`),
        { layout: 'case' },
      ),
    );
  }

  // 4) 互动：由教学目标转化为课堂提问。
  slides.push(makeSlide(
    nextId,
    '互动',
    '课堂互动与讨论',
    buildInteractionQuestions(analysis),
    [],
    { layout: 'interaction' },
  ));

  // 5) 总结：归纳重点，给出复习与下一步建议。
  const summaryBullets = [
    ...analysis.keyPoints.map((item) => `重点回顾：${item}`),
    ...(analysis.difficultPoints.length ? ['难点提示：' + analysis.difficultPoints.join('；')] : []),
    '课后复习：整理知识点并完成思考题',
  ];
  slides.push(makeSlide(
    nextId,
    '总结',
    '本章总结',
    summaryBullets,
    ['下一节课将结合学生反馈进行针对性复习与优化。'],
    { layout: 'summary' },
  ));

  return slides;
}

// 把 PPT 大纲序列化为 Markdown 文本，便于教师导出与进一步编辑。
export function toMarkdown(slides) {
  const sections = ['导入', '讲解', '案例', '互动', '总结'];
  const lines = ['# PPT 初稿（Sprint 1 课前智能备课）', ''];
  // 过滤掉“已删除”的幻灯片，确保人工审核中删除的内容不会出现在导出的大纲里。
  const active = (slides || []).filter((slide) => slide.status !== 'deleted');

  for (const section of sections) {
    const group = active.filter((slide) => slide.section === section);
    if (!group.length) continue;
    lines.push(`## ${section}`);
    for (const slide of group) {
      lines.push(`### ${slide.title}`);
      for (const bullet of slide.bullets) lines.push(`- ${bullet}`);
      for (const note of slide.notes) lines.push(`> 备注：${note}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
