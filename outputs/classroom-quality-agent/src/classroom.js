// 课中课堂感知模块（Sprint 2）。
// 把课堂过程的抬头率、语音转写、语速语调等数据组织与分析，
// 最终生成带时间戳的课堂记录与“状态变化时间段”，供课后复盘使用。
// 说明：抬头率只统计整体趋势、不做人脸识别；语音转写依赖浏览器 Web Speech API 或人工导入。

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

// 生成模拟抬头率采样，支持课时结构（上课段 + 课间休息段）。
export function generateSampleHeadUpRateForSchedule(schedule, intervalSec = 30) {
  const segs = Array.isArray(schedule) && schedule.length
    ? schedule
    : [{ label: '课堂', type: 'class', minutes: 45 }];
  const step = Number(intervalSec) || 30;
  const samples = [];
  let clock = 0;
  for (const seg of segs) {
    const total = Math.max(0, Number(seg.minutes) || 0) * 60;
    const isBreak = seg.type === 'break';
    for (let t = 0; t <= total; t += step) {
      let rate;
      if (isBreak) {
        rate = 0.04 + Math.sin(t * 0.5) * 0.02;
      } else {
        const x = total > 0 ? t / total : 0;
        const base = 0.86 - 0.34 * Math.sin(Math.PI * Math.min(x * 1.2, 1));
        const interactionBoost = Math.exp(-Math.pow((x - 0.62) / 0.12, 2)) * 0.13;
        const noise = (Math.sin(t * 0.7) + Math.sin(t * 0.23)) * 0.02;
        rate = base + interactionBoost + noise;
      }
      rate = Math.min(0.98, Math.max(0.02, rate));
      samples.push({ t: clock + t, rate: Math.round(rate * 1000) / 1000, phase: isBreak ? 'break' : 'class' });
    }
    clock += total;
  }
  return samples;
}

// 向后兼容：单节课（无课间休息）。
export function generateSampleHeadUpRate(durationMin = 45, intervalSec = 30) {
  return generateSampleHeadUpRateForSchedule([{ label: '课堂', type: 'class', minutes: durationMin }], intervalSec);
}

// 分析抬头率：只在“上课”阶段计算均值/最低值和注意力回落，课间休息单独标记。
export function analyzeHeadUpRate(samples, threshold = 0.6) {
  const list = (samples || []).slice().sort((a, b) => a.t - b.t);
  if (!list.length) {
    return { samples: list, classSamples: [], average: 0, min: 1, max: 0, lowSegments: [], breakSegments: [] };
  }

  const classSamples = list.filter((s) => s.phase !== 'break');

  let sum = 0;
  let min = 1;
  let max = 0;
  for (const s of classSamples) {
    sum += s.rate;
    if (s.rate < min) min = s.rate;
    if (s.rate > max) max = s.rate;
  }
  const average = classSamples.length ? sum / classSamples.length : 0;

  const lowSegments = [];
  let lowStart = null;
  let lowPrev = null;
  for (const s of classSamples) {
    const low = s.rate < threshold;
    if (low && lowStart === null) lowStart = s.t;
    if (!low && lowStart !== null && lowPrev !== null) {
      lowSegments.push({ start: lowStart, end: lowPrev.t });
      lowStart = null;
    }
    lowPrev = s;
  }
  if (lowStart !== null && lowPrev !== null) lowSegments.push({ start: lowStart, end: lowPrev.t });

  const breakSegments = [];
  let bStart = null;
  let bPrev = null;
  for (const s of list) {
    const isBreak = s.phase === 'break';
    if (isBreak && bStart === null) bStart = s.t;
    if (!isBreak && bStart !== null && bPrev !== null) {
      breakSegments.push({ start: bStart, end: bPrev.t });
      bStart = null;
    }
    bPrev = s;
  }
  if (bStart !== null && bPrev !== null) breakSegments.push({ start: bStart, end: bPrev.t });

  return { samples: list, classSamples, average, min, max, lowSegments, breakSegments };
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

// 分析语速：按转写文本字数与课堂时长估算“字/分钟”，并给出节奏评价。
export function analyzeSpeechRate(segments, durationMin = 45) {
  const list = (segments || []).filter((s) => s.text);
  const chars = list.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
  const minutes = Math.max(1, Number(durationMin) || 45);
  const charsPerMin = Math.round(chars / minutes);
  const level = charsPerMin > 300 ? '偏快' : charsPerMin < 180 ? '偏慢' : '适中';
  const segmentCount = list.length;
  const avgCharsPerSegment = segmentCount ? Math.round(chars / segmentCount) : 0;
  return { chars, charsPerMin, level, segmentCount, avgCharsPerSegment };
}

// 分析语调/节奏：基于问句数量、停顿词（嗯/啊/这个）做基础统计。
export function analyzeTone(segments) {
  const list = (segments || []).filter((s) => s.text);
  const joined = list.map((s) => s.text).join('');
  const questions = (joined.match(/[？?]/g) || []).length;
  const pauses = (joined.match(/[嗯啊呃这个那个]/g) || []).length;
  const sentences = joined.split(/[。！？!?；;]/).filter((s) => s.trim()).length;
  const avgSentenceLen = sentences ? Math.round(joined.length / sentences) : 0;
  return { questions, pauses, sentences, avgSentenceLen };
}

// 找出抬头率的局部峰值（用于标记互动/投入回升点）。
function findPeaks(samples, minProminence = 0.06) {
  const peaks = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1].rate;
    const cur = samples[i].rate;
    const next = samples[i + 1].rate;
    if (cur > prev && cur >= next && cur - Math.min(prev, next) >= minProminence) {
      peaks.push(samples[i]);
    }
  }
  return peaks.slice(0, 6);
}

// 生成课堂时间轴事件：合并课间休息、注意力回落、互动回升与转写片段。
export function buildTimeline(analysis, speechSegments) {
  const events = [];

  for (const seg of analysis.breakSegments || []) {
    events.push({
      t: seg.start,
      end: seg.end,
      type: 'break',
      label: '课间休息',
      detail: `课间休息，学生离座放松，抬头率统计暂停（约 ${Math.round((seg.end - seg.start) / 60)} 分钟）`,
    });
  }

  for (const seg of analysis.lowSegments) {
    events.push({
      t: seg.start,
      end: seg.end,
      type: 'attention-low',
      label: '注意力回落',
      detail: `抬头率连续低于阈值，持续约 ${Math.round((seg.end - seg.start) / 60)} 分钟`,
    });
  }

  for (const seg of speechSegments) {
    if (!seg.text) continue;
    events.push({ t: seg.start, end: seg.end, type: 'speech', label: '语音', detail: seg.text });
  }

  for (const p of findPeaks(analysis.samples || [])) {
    if (p.phase === 'break') continue;
    events.push({ t: p.t, type: 'interaction', label: '互动/投入回升', detail: `抬头率回升至 ${Math.round(p.rate * 100)}%` });
  }

  return events.sort((a, b) => a.t - b.t);
}

// 生成带时间戳的课堂记录（Markdown）。
export function buildClassroomRecord({ meta, headUpRate, speech, tone, events }) {
  const lines = ['# 课堂记录（Sprint 2 课中课堂感知）', ''];
  if (meta) {
    lines.push(`- 课程：${meta.course || '未命名'}`);
    lines.push(`- 总时长：${meta.durationMin || 45} 分钟`);
    if (Array.isArray(meta.schedule) && meta.schedule.length) {
      lines.push(`- 课时结构：${meta.schedule.map((s) => `${s.label} ${s.minutes} 分钟`).join(' → ')}`);
    }
    lines.push(`- 开始时间：${meta.startTime || '—'}`);
    lines.push('');
  }
  lines.push('## 抬头率统计');
  lines.push(`- 上课阶段平均抬头率：${Math.round(headUpRate.average * 100)}%`);
  lines.push(`- 最低抬头率：${Math.round(headUpRate.min * 100)}%`);
  if (Array.isArray(headUpRate.breakSegments) && headUpRate.breakSegments.length) {
    lines.push('- 课间休息：');
    for (const seg of headUpRate.breakSegments) {
      lines.push(`  - ${formatTime(seg.start)} ~ ${formatTime(seg.end)}`);
    }
  }
  if (headUpRate.lowSegments.length) {
    lines.push('- 注意力回落时间段：');
    for (const seg of headUpRate.lowSegments) {
      lines.push(`  - ${formatTime(seg.start)} ~ ${formatTime(seg.end)}`);
    }
  } else {
    lines.push('- 未发现明显注意力回落时间段');
  }
  lines.push('');

  lines.push('## 语速与语调');
  lines.push(`- 语速：约 ${speech.charsPerMin} 字/分钟（${speech.level}）`);
  lines.push(`- 转写片段：${speech.segmentCount} 段`);
  if (tone) {
    lines.push(`- 提问次数：${tone.questions}`);
    lines.push(`- 停顿/口头语：约 ${tone.pauses} 次`);
    lines.push(`- 平均句长：约 ${tone.avgSentenceLen} 字`);
  }
  lines.push('');

  lines.push('## 带时间戳的课堂时间轴');
  for (const e of events) {
    const timeLabel = e.end ? `${formatTime(e.t)}~${formatTime(e.end)}` : formatTime(e.t);
    lines.push(`- **${timeLabel}** [${e.label}] ${e.detail}`);
  }
  lines.push('');
  lines.push('> 说明：抬头率仅统计整体趋势，不做人脸识别；语音转写建议人工抽样校对。');
  return lines.join('\n');
}