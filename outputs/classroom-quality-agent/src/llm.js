// LLM 接入模块（Sprint 1 功能切片④增强）。
// 把“内容理解 + 前沿补充”交给大模型，按 presentations skill 的写作质量规范，
// 生成更贴近真实授课的 PPT 大纲；采用 OpenAI 兼容的 /chat/completions 协议，
// 通过后端环境变量连接 OpenAI 兼容接口。未配置 API Key 时自动回退本地模板。

import { generateOutline } from './pptGenerator.js';

// 允许的幻灯片环节（与前端展示、导出模块保持一致）。
const SECTIONS = ['导入', '讲解', '案例', '互动', '总结'];

// 从 presentations skill 提炼的写作规范，注入系统提示，避免“AI 味”和空泛表达。
const WRITING_RULES = [
  '标题直接命名本页主题，不使用“从X到Y”“开始讲X”等叙事式或口号式标题，不写无信息量的空泛标题。',
  '正文要点要具体、可落地，避免空话和 AI 味（如“赋能”“闭环”“价值最大化”等），能用事实、步骤、例子就说清楚。',
  '不要出现“本页将介绍”“下面我们来看”等讲解旁白，也不要写对制作 PPT 的自我说明。',
  '每页聚焦一个主题，要点 3~6 条，每条一句话，避免重复和堆砌。',
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
    '  "bullets"：正文要点字符串数组（3~6 条）；',
    '  "notes"：给教师的讲解备注字符串数组（可为空数组）。',
    '整体按“导入 → 讲解 → 案例 → 互动 → 总结”组织；讲解环节为每个知识点各出一页。',
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
  const cleaned = String(text || '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
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
      status: 'pending',
    }));
}

// 读取环境变量（兼容 Node 环境，避免浏览器环境报错）。
function env(name) {
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

// 调用大模型生成大纲；应用运行时的连接信息只允许来自后端环境变量。
// trustedConfig 仅用于服务器内部调用或单元测试，绝不能直接传入 HTTP 请求数据。
// 无 Key 或调用失败时回退本地模板，保证主流程不中断。
export async function generateOutlineWithLLM(analysis, supplements = [], trustedConfig = {}) {
  const apiKey = trustedConfig.apiKey || env('LLM_API_KEY');
  if (!apiKey) {
    return { source: 'local', slides: generateOutline(analysis, supplements) };
  }

  const baseUrl = (trustedConfig.baseUrl || env('LLM_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = trustedConfig.model || env('LLM_MODEL') || 'deepseek-chat';
  const configuredTimeout = Number(trustedConfig.timeoutMs || env('LLM_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 5000), 120000)
    : 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(analysis, supplements) },
        ],
      }),
    });

    if (!resp.ok) {
      throw new Error('LLM 请求失败（HTTP ' + resp.status + '）');
    }

    const data = await resp.json();
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
