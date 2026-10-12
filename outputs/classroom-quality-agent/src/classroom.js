// 课中课堂感知模块（Sprint 2）。
// 工作流：课堂设置 → 音视频采集 → 语音转写 → 文本分析 → 课堂分析报告。
// 文本分析维度：语速、语调、关键词、提问与互动。
// 说明：不再统计抬头率（需视频人脸识别，成本过高）；语音转写优先用 Whisper（Python），
// 未安装 Whisper 时回退到示意转写或人工粘贴。

// 把秒数格式化为 mm:ss 或 h:mm:ss。
export function formatTime(totalSec) {
  const sec = Math.max(0, Math.round(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 把 "mm:ss" 或 "h:mm:ss" 解析为秒数。
export function parseTime(text) {
  const parts = String(text || '').trim().split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

// 构建“两节课 + 课间休息”的课时结构。
export function buildSchedule(session1Min = 45, breakMin = 10, session2Min = 45) {
  return [
    { label: '第一节', type: 'class', minutes: Math.max(0, Number(session1Min) || 0) },
    { label: '课间休息', type: 'break', minutes: Math.max(0, Number(breakMin) || 0) },
    { label: '第二节', type: 'class', minutes: Math.max(0, Number(session2Min) || 0) },
  ];
}

// 计算课时结构总时长（分钟）。
export function scheduleTotalMinutes(schedule) {
  const segs = Array.isArray(schedule) ? schedule : [];
  return segs.reduce((n, s) => n + (Number(s.minutes) || 0), 0);
}

// 解析带时间戳的转写文本。支持两种格式：
//   [00:00-00:55] 文本
//   00:00-00:55 文本
export function parseTranscript(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  const timeRe = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~]\s*(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.*)$/;
  for (const line of lines) {
    const m = line.match(timeRe);
    if (m) {
      segments.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: m[3].trim() });
    } else {
      segments.push({ start: 0, end: 0, text: line });
    }
  }
  return segments;
}

// 分析语速：按转写文本字数与“实际语音时长”估算“字/分钟”，并给出节奏评价。
// 优先用带时间戳片段的起止时间计算实际时长；无时间戳时才退回课堂总时长。
export function analyzeSpeechRate(segments, durationMin = 45) {
  const list = (segments || []).filter((s) => s.text);
  const chars = list.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
  const timed = list.filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0
  );
  let minutes;
  let actualSpeechSeconds = 0;
  if (timed.length) {
    // 实际说话时长 = 各片段时长之和（排除静音/停顿空档），
    // 而不是“第一个片段起点到最后一个片段终点”的跨度（那会把静音也算进去，导致语速偏慢）。
    actualSpeechSeconds = timed.reduce((n, s) => n + (s.end - s.start), 0);
    minutes = Math.max(0.1, actualSpeechSeconds / 60);
  } else {
    minutes = Math.max(1, Number(durationMin) || 45);
  }
  const charsPerMin = Math.round(chars / minutes);
  const level = charsPerMin > 300 ? '偏快' : charsPerMin < 180 ? '偏慢' : '适中';
  const segmentCount = list.length;
  const avgCharsPerSegment = segmentCount ? Math.round(chars / segmentCount) : 0;
  return { chars, charsPerMin, level, segmentCount, avgCharsPerSegment, actualSpeechSeconds };
}

// 分析语调/节奏：基于句子数量、停顿词（嗯/啊/这个）做基础统计。
export function analyzeTone(segments) {
  const list = (segments || []).filter((s) => s.text);
  const joined = list.map((s) => s.text).join('');
  const pauses = (joined.match(/[嗯啊呃这个那个就是那么]/g) || []).length;
  const sentences = joined.split(/[。！？!?；;]/).filter((s) => s.trim()).length;
  const avgSentenceLen = sentences ? Math.round(joined.length / sentences) : 0;
  return { pauses, sentences, avgSentenceLen };
}

// 中文停用词（用于关键词提取时过滤常见虚词/口语词）。
const STOPWORDS = new Set([
  '的','了','在','是','我','你','他','她','它','我们','你们','他们','大家','同学们',
  '有','和','就','不','人','都','一','一个','上','下','也','很','到','说','要','去',
  '会','着','看','好','这','那','这个','那个','什么','怎么','为什么','可以','还有',
  '已经','比较','非常','一点','一些','一下','等等','进行','通过','然后','所以','因为',
  '但是','如果','以及','比如','就是','这样','那样','这里','那里','现在','今天','老师',
  '对于','关于','从','向','把','被','让','给','对','来','用','主要','重要','关键',
]);

// 关键词提取：对中文转写做 2~6 字 n-gram 词频统计，过滤停用词后取高频词。
export function analyzeKeywords(segments, topN = 15) {
  const text = (segments || []).filter((s) => s.text).map((s) => s.text).join('');
  const cleaned = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const freq = new Map();
  for (let len = 6; len >= 2; len--) {
    for (let i = 0; i + len <= cleaned.length; i++) {
      const gram = cleaned.slice(i, i + len);
      if (STOPWORDS.has(gram)) continue;
      if (!/[\u4e00-\u9fa5]/.test(gram)) continue;
      freq.set(gram, (freq.get(gram) || 0) + 1);
    }
  }
  const candidates = Array.from(freq.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const result = [];
  for (const [word, count] of candidates) {
    if (result.length >= topN) break;
    if (result.some((r) => r.word.includes(word))) continue;
    result.push({ word, count });
  }
  return result;
}

// 提问与互动分析：统计提问次数、互动相关词出现次数、以及提问片段。
const INTERACTION_WORDS = ['提问', '回答', '讨论', '思考', '练习', '互动', '举例', '大家', '谁', '为什么', '请', '想一想', '说说看'];

export function analyzeInteraction(segments) {
  const list = (segments || []).filter((s) => s.text);
  const joined = list.map((s) => s.text).join('');
  const questionSegments = list.filter((s) => /[？?]/.test(s.text));
  const questions = (joined.match(/[？?]/g) || []).length;
  const interactionCount = (joined.match(new RegExp(INTERACTION_WORDS.join('|'), 'g')) || []).length;
  return { questions, questionSegments, interactionCount };
}

// 生成课堂时间轴事件：合并课间休息、讲解片段与提问片段。
export function buildTimeline(schedule, speechSegments) {
  const events = [];
  let clock = 0;
  for (const seg of (Array.isArray(schedule) ? schedule : [])) {
    const minutes = Number(seg.minutes) || 0;
    if (seg.type === 'break' && minutes > 0) {
      events.push({ t: clock, end: clock + minutes * 60, type: 'break', label: '课间休息', detail: `课间休息约 ${minutes} 分钟` });
    }
    clock += minutes * 60;
  }
  for (const seg of (speechSegments || [])) {
    if (!seg.text) continue;
    const isQuestion = /[？?]/.test(seg.text);
    events.push({
      t: seg.start,
      end: seg.end,
      type: isQuestion ? 'question' : 'speech',
      label: isQuestion ? '提问' : '讲解',
      detail: seg.text,
    });
  }
  return events.sort((a, b) => a.t - b.t);
}

// 生成课堂分析报告（Markdown）。
export function buildClassroomRecord({ meta, speech, tone, keywords, interaction, events }) {
  const lines = ['# 课堂分析报告（Sprint 2 课中课堂感知）', ''];
  if (meta) {
    lines.push(`- 课程：${meta.course || '未命名'}`);
    lines.push(`- 总时长：${meta.durationMin || 45} 分钟`);
    if (Array.isArray(meta.schedule) && meta.schedule.length) {
      lines.push(`- 课时结构：${meta.schedule.map((s) => `${s.label} ${s.minutes} 分钟`).join(' → ')}`);
    }
    lines.push(`- 开始时间：${meta.startTime || '—'}`);
    lines.push('');
  }
  lines.push('## 语速分析');
  lines.push(`- 语速：约 ${speech.charsPerMin} 字/分钟（${speech.level}）`);
  lines.push(`- 转写总字数：${speech.chars} 字，共 ${speech.segmentCount} 段`);
  lines.push('');
  lines.push('## 语调分析');
  lines.push(`- 平均句长：约 ${tone.avgSentenceLen} 字`);
  lines.push(`- 停顿/口头语：约 ${tone.pauses} 次`);
  lines.push('');
  lines.push('## 提问与互动');
  lines.push(`- 提问次数：${interaction.questions}`);
  lines.push(`- 互动相关词出现：约 ${interaction.interactionCount} 次`);
  lines.push('');
  lines.push('## 关键词');
  for (const k of keywords) {
    lines.push(`- ${k.word}（${k.count} 次）`);
  }
  lines.push('');
  lines.push('## 带时间戳的课堂时间轴');
  for (const e of events) {
    const timeLabel = e.end ? `${formatTime(e.t)}~${formatTime(e.end)}` : formatTime(e.t);
    lines.push(`- **${timeLabel}** [${e.label}] ${e.detail}`);
  }
  lines.push('');
  lines.push('> 说明：语音转写由 Whisper 或人工完成；语速、语调、关键词与互动均为基于转写文本的统计，供教师复盘参考。');
  return lines.join('\n');
}