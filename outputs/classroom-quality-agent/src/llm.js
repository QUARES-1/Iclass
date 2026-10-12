// LLM 接入模块（Sprint 1 功能切片④增强）。
// 把“内容理解 + 前沿补充”交给大模型，按 presentations skill 的写作质量规范，
// 生成更贴近真实授课的 PPT 大纲；采用 OpenAI 兼容的 /chat/completions 协议，
// 通过后端环境变量连接 OpenAI 兼容接口。未配置 API Key 时自动回退本地模板。

import { generateOutline } from './pptGenerator.js';
import { analyzeMaterials } from './analyzer.js';

// 允许的幻灯片环节（与前端展示、导出模块保持一致）。
const SECTIONS = ['导入', '讲解', '案例', '互动', '总结'];

export const SLIDE_LENGTH_GUIDANCE = '课件篇幅：用讲清目标所需的精简页数，不按课时或批次额度凑页。每页承载一个完整教学单元，相关定义、条件、操作步骤和简短示例尽量合并；普通讲解页通常有3～5条实质要点，或一幅图表、一段完整代码配必要说明，不机械凑条数。除封面、章节过渡及必要互动外，避免一句话、一个术语或一个零碎步骤单独一页；合并重复铺垫、总结与续页。不为压页数堆满文字或缩小字号，代码仍优先按完整函数或完整部分分页。';
export const SLIDE_TITLE_GUIDANCE = '除教师指定固定标题外，每页标题命名本页具体知识点、函数或操作环节，简短且有区分度；章节名称只用于章节引入，不在一章所有页面反复用作大标题。不要添加“（续2）”“（代码2/3）”等标题标记。跨批次核对已有页面目录，不重复生成已经讲清的章节、同一验证与完整程序。';

// 从 presentations skill 提炼的写作规范，注入系统提示，避免“AI 味”和空泛表达。
const WRITING_RULES = [
  '标题直接命名本页主题，不使用“从X到Y”“开始讲X”等叙事式或口号式标题，不写无信息量的空泛标题。',
  '正文要点要具体、可落地，避免空话和 AI 味（如“赋能”“闭环”“价值最大化”等），能用事实、步骤、例子就说清楚。',
  '不要出现“本页将介绍”“下面我们来看”等讲解旁白，也不要写对制作 PPT 的自我说明。',
  SLIDE_LENGTH_GUIDANCE,
  SLIDE_TITLE_GUIDANCE,
  '讲解页标注重点/难点，并给出可执行的讲解建议；案例页给出真实可查的行业应用；互动页给出能引发思考的提问。',
  'notes 写给授课教师，说明讲解思路、来源或需核验之处，不直接当正文展示。',
].join('\n');

// 构造系统提示：说明任务、输出 JSON 结构与写作规范。
export function buildSystemPrompt() {
  return [
    '你是“课堂质量改进智能体”的备课助手，把给定的教学内容整理成可直接用于授课的 PPT 大纲。',
    '只输出 JSON，不要输出 Markdown 代码块或任何额外说明。',
    'JSON 顶层结构为 {"slides":[...]}，每个元素含：',
    '  "section"：只能是 导入/讲解/案例/互动/总结 之一；',
    '  "title"：本页标题（一句直接命名主题的话）；',
    '  "bullets"：正文要点字符串数组（普通讲解页通常 3~5 条，图表或代码页按需减少，总结页最多 6 条）；',
    '  "notes"：给教师的讲解备注字符串数组（可为空数组）；',
    '  "example"：概念或定义页的具体正例，其他页面可为空字符串；',
    '  "counterExample"：概念边界的反例或常见误解纠正，其他页面可为空字符串。',
    '整体按“导入 → 讲解 → 案例 → 互动 → 总结”组织；讲解环节按完整教学主题分组，相关知识点可以放在同一页。',
    '概念、定义和原理类讲解页必须根据教学内容生成一个简短具体的 example，并尽量生成 counterExample；不要只写“可补充示例”。',
    '互动页只生成一个主问题和 2~3 条思考提示，不生成“课堂记录”相关内容。',
    '总结内容优先集中在一页，用不超过 6 条短句归纳核心要点。',
    '写作规范如下：',
    WRITING_RULES,
  ].join('\n');
}

// 构造用户提示：注入内容理解结果与前沿补充。
export function buildUserPrompt(analysis, supplements) {
  const lines = ['请基于以下备课材料生成 PPT 大纲。'];
  if (analysis && analysis.chapters && analysis.chapters.length) lines.push('章节：' + analysis.chapters.join('、'));
  if (analysis && analysis.objectives && analysis.objectives.length) lines.push('教学目标：' + analysis.objectives.join('；'));
  if (analysis && analysis.knowledgePoints && analysis.knowledgePoints.length) lines.push('知识点：' + analysis.knowledgePoints.join('；'));
  if (analysis && analysis.keyPoints && analysis.keyPoints.length) lines.push('教学重点：' + analysis.keyPoints.join('；'));
  if (analysis && analysis.difficultPoints && analysis.difficultPoints.length) lines.push('教学难点：' + analysis.difficultPoints.join('；'));
  if (supplements && supplements.length) {
    lines.push('前沿补充（尽量融入“案例”与“讲解”备注）：');
    for (const item of supplements) {
      lines.push('- [' + item.type + '] ' + item.title + '：' + item.description + '（来源：' + item.source + (item.needsVerify ? '，待核验' : '') + '）');
    }
  }
  return lines.join('\n');
}

// 从大模型文本中稳健提取 JSON（容忍偶发的 Markdown 代码块或前后说明）。
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim();
  const parse = value => {
    try {
      const result = JSON.parse(value);
      return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
    } catch { return null; }
  };
  // Parse the response before inspecting Markdown: fences inside a JSON string
  // are teaching content, not wrappers around the response.
  const direct = parse(cleaned);
  if (direct) return direct;
  if (cleaned.startsWith('[')) return null;
  const fence = cleaned.match(/^```(?:json)?[ \t]*(?:\r?\n|(?=\{))([\s\S]*?)\s*```$/i);
  if (cleaned.startsWith('```') && !fence) return null;
  const candidate = fence ? fence[1].trim() : cleaned;
  if (candidate.startsWith('[')) return null;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const prefix = candidate.slice(0, start);
  if (prefix.includes('```') && !/```(?:json)?\s*$/i.test(prefix)) return null;
  const object = candidate.slice(start, end + 1);
  const parsed = parse(object);
  if (parsed) return parsed;
  // Some providers emit literal line breaks inside code.source. Escape only
  // control characters within strings; never invent fields or close a fragment.
  let quoted = false, escaped = false, normalized = '';
  for (const char of object) {
    if (quoted && !escaped && char.charCodeAt(0) < 32) {
      normalized += JSON.stringify(char).slice(1, -1); continue;
    }
    normalized += char;
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return parse(normalized);
}

// 内容理解提示：要求模型根据资料语义归纳，而不是依赖“教学重点”等固定标题。
export function buildAnalysisSystemPrompt() {
  return [
    '你是课程教学资料分析助手。请从教师提供的原始资料中提取结构化教学信息。',
    '只输出 JSON，不要输出 Markdown 代码块或额外说明。',
    'JSON 格式必须为：',
    '{"analysis":{"chapters":[],"objectives":[],"knowledgePoints":[],"keyPoints":[],"difficultPoints":[]}}',
    '字段要求：',
    'chapters：课程主题、章标题或主要章节。即使资料使用“1. 标题”而不是“第1章”，也要结合文档标题和一级内容标题识别。',
    'objectives：学生完成学习后应达到的能力，使用“理解、掌握、能够”等可观察表述。',
    'knowledgePoints：资料中实际讲解的核心概念、结构、算法或操作。',
    'keyPoints：根据内容重要性归纳教学重点，不要求原文必须出现“教学重点”标签。',
    'difficultPoints：根据概念抽象程度、易错点、复杂步骤和复杂度分析归纳教学难点。',
    '所有内容必须来自资料，不得虚构未出现的知识、案例、数据或结论。',
    '删除重复项和阅读建议等非教学目标内容。章节建议 1~10 条，目标 2~8 条，知识点 3~20 条，重点 1~8 条，难点 1~8 条。',
    '五个数组都必须填写且不得为空。资料没有显式“重点/难点”标签时，必须根据反复讲解的核心内容、易错点、边界条件和操作复杂度进行归纳。',
    '输出前检查 knowledgePoints、keyPoints、difficultPoints，禁止把这三个字段留空。',
  ].join('\n');
}

function truncateMaterialContent(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  const marker='\n[中间内容因长度限制省略]\n';
  if(maxLength<=marker.length)return text.slice(0,maxLength);
  const headLength = Math.floor((maxLength-marker.length) * 0.7);
  const tailLength = maxLength-marker.length - headLength;
  return text.slice(0, headLength) + marker + (tailLength?text.slice(-tailLength):'');
}

export function buildAnalysisUserPrompt(materials = []) {
  const lines = ['请分析以下教学资料：'];
  let remaining = 100000;
  (materials || []).forEach((item, index) => {
    if (remaining <= 0) return;
    const title = String(item?.title || `资料${index + 1}`).trim().slice(0, 200);
    const type = String(item?.type || '教学资料').trim().slice(0, 100);
    const content = truncateMaterialContent(item?.content, Math.min(remaining, 50000));
    if (!content) return;
    lines.push(`\n### 资料 ${index + 1}：${title}（${type}）`);
    lines.push(content);
    remaining -= content.length;
  });
  return lines.join('\n');
}

function normalizeStringArray(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => {const text=String(item).replace(/\s+/g, ' ').trim();return text.length>5000?text.slice(0,4970)+'…（原句较长，已缩略）':text;})
    .filter(Boolean))]
    .slice(0, maxItems);
}

export function normalizeAnalysis(raw, { limitItems = true } = {}) {
  const value = raw && raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : raw;
  if (!value || typeof value !== 'object') return null;
  const analysis = {
    chapters: normalizeStringArray(value.chapters || value.chapter || value['章节'], limitItems ? 10 : Infinity),
    objectives: normalizeStringArray(value.objectives || value.learningObjectives || value['教学目标'], limitItems ? 8 : Infinity),
    knowledgePoints: normalizeStringArray(
      value.knowledgePoints || value.knowledge_points || value.knowledge || value['知识点'],
      limitItems ? 20 : Infinity,
    ),
    keyPoints: normalizeStringArray(
      value.keyPoints || value.key_points || value.teachingFocus || value['教学重点'] || value['重点'],
      limitItems ? 8 : Infinity,
    ),
    difficultPoints: normalizeStringArray(
      value.difficultPoints || value.difficult_points || value.teachingDifficulties || value['教学难点'] || value['难点'],
      limitItems ? 8 : Infinity,
    ),
  };
  return Object.values(analysis).some((items) => items.length) ? analysis : null;
}

// 使用服务端教师配置执行内容理解；没有配置对象的旧调用仍兼容环境变量。
// API 不可用时返回现有规则解析结果，保证上传与后续流程仍可继续。
export async function analyzeMaterialsWithLLM(materials = [], trustedConfig = {}) {
  const rawFallback=analyzeMaterials(materials), fallback=normalizeAnalysis(rawFallback)||rawFallback;
  const fallbackWarning=Object.keys(rawFallback).some(k=>JSON.stringify(rawFallback[k])!==JSON.stringify(fallback[k]))?'本地理解中的长条目或过多条目已缩略；完整解析资料仍保留，请核对原文。':'';
  const inputWarning=!trustedConfig.maxInputChars && (materials.some(m=>m.content?.length>50000)||materials.reduce((n,m)=>n+(m.content?.length||0),0)>100000)?'AI 理解单份最多选取 50000、合计 100000 字符，超出正文未交给 AI；完整资料仍保留，请精简或选用所需章节。':'';
  const apiKey = trustedConfig.apiKey ?? env('LLM_API_KEY');
  if (!apiKey) return { source: 'local', analysis: fallback, ...(fallbackWarning?{warning:fallbackWarning}:{}) };

  const baseUrl = (trustedConfig.baseUrl || env('LLM_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = trustedConfig.model || env('LLM_MODEL') || 'deepseek-chat';
  const configuredTimeout = Number(trustedConfig.timeoutMs || env('LLM_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 5000), 600000)
    : 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const system = (trustedConfig.prompts?.materials ?? buildAnalysisSystemPrompt()) + '\n应用数据协议：仅返回 JSON {analysis:{chapters:[],objectives:[],knowledgePoints:[],keyPoints:[],difficultPoints:[]}}，数组条目为字符串。';
    const user = trustedConfig.maxInputChars ? ['请分析以下教学资料：', ...materials.map((item, index) => `\n### 资料 ${index + 1}：${item.title}（${item.type || '教学资料'}）\n${item.content}`)].join('\n') : buildAnalysisUserPrompt(materials);
    if (trustedConfig.maxInputChars && system.length + user.length > trustedConfig.maxInputChars) throw new Error('资料理解输入超过设置中的字符额度，未向模型发送截断资料；请调整输入额度或分章节理解。');
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        temperature: trustedConfig.temperature ?? 0.1,
        response_format: { type: 'json_object' },
        max_tokens: trustedConfig.maxTokens ?? 3000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!resp.ok) throw new Error('LLM 请求失败（HTTP ' + resp.status + '）');

    const data = await resp.json();
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('模型达到设置中的最大输出 token 额度，未采用不完整输出。请调整输出额度或分章节处理。');
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    const analysis = normalizeAnalysis(extractJson(content), { limitItems: !trustedConfig.prompts?.materials });
    if (!analysis) throw new Error('LLM 未返回有效的内容理解结果');
    if (!analysis.knowledgePoints.length || !analysis.keyPoints.length || !analysis.difficultPoints.length) {
      throw new Error('LLM 返回的知识点、重点或难点不完整');
    }
    return { source: 'llm', analysis, ...(inputWarning?{warning:inputWarning}:{}) };
  } catch (error) {
    const warning = error && error.name === 'AbortError'
      ? 'AI 内容理解请求超时，已改用本地规则解析'
      : (error && error.message ? error.message : String(error));
    return { source: 'local', analysis: fallback, warning:[warning,fallbackWarning].filter(Boolean).join('；') };
  } finally {
    clearTimeout(timeoutId);
  }
}

// 归一化大模型返回的幻灯片，补齐 id 与 status 字段，并过滤非法项。
export function normalizeSlides(raw) {
  const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.slides) ? raw.slides : [];
  return arr
    .filter((slide) => slide && slide.title)
    .map((slide, index) => ({
      id: 'slide-' + String(index + 1).padStart(3, '0'),
      section: SECTIONS.includes(slide.section) ? slide.section : '讲解',
      title: String(slide.title).trim(),
      bullets: (Array.isArray(slide.bullets) ? slide.bullets : [])
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => String(item).trim())
        .filter(Boolean),
      notes: (Array.isArray(slide.notes) ? slide.notes : [])
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => String(item).trim())
        .filter(Boolean),
      example: typeof slide.example === 'string' || typeof slide.example === 'number'
        ? String(slide.example).trim()
        : '',
      counterExample: typeof slide.counterExample === 'string' || typeof slide.counterExample === 'number'
        ? String(slide.counterExample).trim()
        : '',
      status: 'pending',
    }));
}

// 读取环境变量（兼容 Node 环境，避免浏览器环境报错）。
function env(name) {
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

// 调用大模型生成大纲；应用运行时使用服务端已验证的教师配置。
// trustedConfig 仅用于服务器内部调用或单元测试，绝不能直接传入 HTTP 请求数据。
// 无 Key 或调用失败时回退本地模板，保证主流程不中断。
export async function generateOutlineWithLLM(analysis, supplements = [], trustedConfig = {}) {
  const apiKey = trustedConfig.apiKey ?? env('LLM_API_KEY');
  if (!apiKey) {
    return { source: 'local', slides: generateOutline(analysis, supplements) };
  }

  const baseUrl = (trustedConfig.baseUrl || env('LLM_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = trustedConfig.model || env('LLM_MODEL') || 'deepseek-chat';
  const configuredTimeout = Number(trustedConfig.timeoutMs || env('LLM_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 5000), 600000)
    : 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const system = (trustedConfig.prompts?.outline ?? buildSystemPrompt()) + '\n应用数据协议：仅返回 JSON {slides:[{section,title,bullets:[],notes:[],example,counterExample}]}。';
    const user = buildUserPrompt(analysis, supplements);
    if (trustedConfig.maxInputChars && system.length + user.length > trustedConfig.maxInputChars) throw new Error('大纲输入超过设置中的字符额度，请调整输入额度或分章节生成。');
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        temperature: trustedConfig.temperature ?? 0.3,
        ...(trustedConfig.maxTokens ? { max_tokens: trustedConfig.maxTokens } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!resp.ok) {
      throw new Error('LLM 请求失败（HTTP ' + resp.status + '）');
    }

    const data = await resp.json();
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('模型达到设置中的最大输出 token 额度，未采用不完整输出。请调整输出额度或分章节处理。');
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    const slides = normalizeSlides(extractJson(content));
    if (!slides.length) throw new Error('LLM 未返回有效幻灯片');

    return { source: 'llm', slides };
  } catch (error) {
    const warning = error && error.name === 'AbortError'
      ? 'LLM 请求超时，请稍后重试'
      : error && error.message ? error.message : String(error);
    return {
      source: 'local',
      slides: generateOutline(analysis, supplements),
      warning,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
