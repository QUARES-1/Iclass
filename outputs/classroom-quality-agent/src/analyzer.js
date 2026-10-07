// 内容理解模块（Sprint 1 功能切片②）。
// 对教师上传的教案、教学用书、教学大纲、往年 PPT 文本进行结构化解析，
// 提取章节、知识点、教学目标、重点与难点，供后续“前沿补充”和“PPT 生成”使用。
// 这里采用基于关键词与编号的规则式解析，作为原型阶段的“AI 内容理解”替代实现。

// 通过章节标题识别教材/大纲的章节结构。
const CHAPTER_RE = /^(第\s*[一二三四五六七八九十百\d]+\s*[章讲单元篇])/;

// 教学目标中的能力动词，用于在没有“教学目标”标题时兜底识别目标句。
const OBJECTIVE_VERBS = ['掌握', '理解', '了解', '熟悉', '运用', '能够', '学会', '认识'];

// 各内容区块可能出现的标题关键词。
const SECTION_LABELS = {
  objective: ['教学目标', '学习目标', '教学目的', '学习目的', '能力目标'],
  key: ['教学重点', '本章重点', '重点'],
  difficult: ['教学难点', '本章难点', '难点'],
  content: ['教学内容', '教学知识点', '知识点', '课程内容', '主要内容', '章节内容'],
};

// 去掉行首的中文/阿拉伯数字编号，例如“1.”、“一、”、“（三）”等。
function stripNumberPrefix(line) {
  return line
    .replace(/^[（(]?\d+[）)、.．、]\s*/, '')
    .replace(/^[（(]?[一二三四五六七八九十]+[）)、.．、]\s*/, '')
    .replace(/^[（(][一二三四五六七八九十]+[）)]\s*/, '')
    .replace(/^[-*•·●]\s*/, '')
    .trim();
}

// 把一段文本拆成去除空白的单行。
function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// 判断某行是否属于指定的内容区块标题。
function detectSection(line) {
  const normalized = stripNumberPrefix(line);
  for (const [section, labels] of Object.entries(SECTION_LABELS)) {
    if (labels.some((label) => normalized === label
      || normalized.startsWith(label + '：')
      || normalized.startsWith(label + ':'))) {
      return section;
    }
  }
  return null;
}

// 把解析出的内容写入对应结果桶。
function pushBucket(result, section, value) {
  const clean = value && value.trim();
  if (!clean) return;
  if (section === 'objective') result.objectives.push(clean);
  else if (section === 'key') result.keyPoints.push(clean);
  else if (section === 'difficult') result.difficultPoints.push(clean);
  else if (section === 'content') result.knowledgePoints.push(clean);
}

// 判断一行是否为带编号或项目符号的列表项（用于无标题文本时的知识点兜底）。
function isListItem(line) {
  return (
    /^[（(]?\d+[）)、.．、]/.test(line) ||
    /^[（(]?[一二三四五六七八九十]+[）)、.．、]/.test(line) ||
    /^[-*•·●]/.test(line)
  );
}

// 对单个材料文本做结构化解析，返回五类结构化结果。
export function analyzeMaterial(text) {
  const lines = splitLines(text);
  const result = {
    chapters: [],
    objectives: [],
    keyPoints: [],
    difficultPoints: [],
    knowledgePoints: [],
  };

  let currentSection = null;

  for (const raw of lines) {
    // 优先识别章节标题，例如“第5章 排序算法”。
    const chapterMatch = raw.match(CHAPTER_RE);
    if (chapterMatch) {
      result.chapters.push(raw);
      currentSection = null;
      continue;
    }

    // 识别内容区块标题。
    const section = detectSection(raw);
    if (section) {
      currentSection = section;
      // 兼容“教学目标：掌握……”这类行内内容写法。
      const inline = raw.split(/[:：]/, 2)[1];
      if (inline) pushBucket(result, section, stripNumberPrefix(inline));
      continue;
    }

    const clean = stripNumberPrefix(raw);
    if (!clean) continue;
    pushBucket(result, currentSection, clean);
  }

  // 兜底策略：如果文本没有使用显式标题，则用关键词从全文抽取。
  // 先统一去掉编号前缀，保证与显式标题场景下的输出格式一致。
  const stripped = lines.map(stripNumberPrefix).filter(Boolean);
  if (result.objectives.length === 0) {
    result.objectives = stripped.filter((line) =>
      OBJECTIVE_VERBS.some((verb) => line.includes(verb)),
    );
  }
  if (result.keyPoints.length === 0) {
    result.keyPoints = stripped.filter((line) => line.includes('重点'));
  }
  if (result.difficultPoints.length === 0) {
    result.difficultPoints = stripped.filter((line) => line.includes('难点'));
  }
  if (result.knowledgePoints.length === 0) {
    // 只把带编号/项目符号的列表项当作知识点兜底，避免把说明性段落误判为知识点。
    result.knowledgePoints = lines
      .filter(isListItem)
      .map(stripNumberPrefix)
      .filter(Boolean);
  }

  return result;
}

// 去重工具：保持原顺序，去除完全相同的项。
function unique(list) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

// 汇总多个材料（教案/教学用书/教学大纲/往年 PPT）的解析结果。
// materials 形如 [{ type, title, content }]。
export function analyzeMaterials(materials) {
  const merged = {
    chapters: [],
    objectives: [],
    keyPoints: [],
    difficultPoints: [],
    knowledgePoints: [],
  };

  for (const material of materials || []) {
    const parsed = analyzeMaterial(material?.content || '');
    merged.chapters.push(...parsed.chapters);
    merged.objectives.push(...parsed.objectives);
    merged.keyPoints.push(...parsed.keyPoints);
    merged.difficultPoints.push(...parsed.difficultPoints);
    merged.knowledgePoints.push(...parsed.knowledgePoints);
  }

  merged.chapters = unique(merged.chapters);
  merged.objectives = unique(merged.objectives);
  merged.keyPoints = unique(merged.keyPoints);
  merged.difficultPoints = unique(merged.difficultPoints);
  merged.knowledgePoints = unique(merged.knowledgePoints);

  return merged;
}
