// 前端交互入口：Sprint 2 课中课堂感知。
// 复用 src/classroom.js 的纯函数，串联“课堂设置 → 数据采集 → 感知分析 → 时间轴”。
// 支持上传课堂视频/录音（原型演示生成示意转写与抬头率），也可粘贴带时间戳的转写文本。

import {
  buildSchedule,
  scheduleTotalMinutes,
  generateSampleHeadUpRateForSchedule,
  analyzeHeadUpRate,
  parseTranscript,
  analyzeSpeechRate,
  analyzeTone,
  buildTimeline,
  buildClassroomRecord,
  formatTime,
} from '../src/classroom.js';

// 示例转写文本（模拟“两节课 + 课间休息”的排序算法课堂，带时间戳）。
const SAMPLE_TRANSCRIPT = [
  '[00:00-00:55] 同学们好，今天我们进入第五章排序算法，先讲冒泡排序和快速排序。',
  '[01:00-04:20] 冒泡排序通过相邻元素两两比较交换，把较大的元素逐步冒泡到末尾。',
  '[04:30-08:10] 冒泡排序的时间复杂度是 O(n²)，数据规模一大效率就明显下降。',
  '[08:20-13:30] 接下来看快速排序，核心是分治：选基准、划分子序列、递归处理。',
  '[13:40-18:20] 快速排序平均时间复杂度是 O(n log n)，最坏情况下退化为 O(n²)。',
  '[18:30-24:00] 看一个例子：用快速排序对这个数组划分，注意基准两侧的移动过程。',
  '[24:10-30:40] 请大家思考：当数组基本有序时，快速排序为什么会明显变慢？',
  '[30:50-37:20] 接下来讲归并排序，同样是分治，先递归拆分再合并有序子序列。',
  '[37:30-44:00] 归并排序时间复杂度稳定在 O(n log n)，代价是需要额外 O(n) 空间。',
  '[55:00-56:00] 好，我们继续。先回顾上一节三种排序的复杂度对比。',
  '[56:10-63:30] 快速排序在实际工程中最常用，原因在于缓存友好和常数项小。',
  '[63:40-70:20] 看一个真实案例：电商推荐列表如何用排序提升点击率。',
  '[70:30-78:00] 稳定性很重要，当排序键相同时要保持原始相对顺序。',
  '[78:10-85:40] 做一个课堂练习，请大家动手实现快速排序的划分函数。',
  '[85:50-93:20] 小结：重点是快速排序划分，难点是最坏情况复杂度分析。',
  '[93:30-99:00] 课后作业，思考快速排序为什么在实际中通常比归并排序更快。',
  '[99:00-100:00] 今天这节课就到这里，有问题的同学课后继续交流。',
].join('\n');

const state = {
  step: 1,
  course: '数据结构 · 第5章 排序算法',
  schedule: buildSchedule(45, 10, 45),
  durationMin: 100,
  startTime: '08:00',
  intervalSec: 30,
  headUpRateSamples: [],
  speechSegments: [],
  media: null,
  mediaDurationSec: 0,
  recognition: null,
  recording: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 从表单读取课堂元信息（两节课 + 课间休息）。
function readMeta() {
  state.course = $('#inp-course').value.trim() || '未命名课程';
  state.schedule = buildSchedule(
    Number($('#inp-session1').value) || 45,
    Number($('#inp-break').value) || 10,
    Number($('#inp-session2').value) || 45,
  );
  state.durationMin = scheduleTotalMinutes(state.schedule);
  state.startTime = $('#inp-start').value || '08:00';
  state.intervalSec = Math.max(10, Number($('#inp-interval').value) || 30);
  return {
    course: state.course,
    schedule: state.schedule,
    durationMin: state.durationMin,
    startTime: state.startTime,
    intervalSec: state.intervalSec,
  };
}

function goTo(step) {
  state.step = step;
  $$('.step').forEach((b) => b.classList.toggle('is-active', b.dataset.step === String(step)));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === String(step)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 载入示例：生成模拟抬头率 + 填充示例转写。
function loadSample() {
  const meta = readMeta();
  $('#transcript-input').value = SAMPLE_TRANSCRIPT;
  state.headUpRateSamples = generateSampleHeadUpRateForSchedule(meta.schedule, meta.intervalSec);
  state.speechSegments = parseTranscript(SAMPLE_TRANSCRIPT);
}

function clearAll() {
  $('#transcript-input').value = '';
  state.headUpRateSamples = [];
  state.speechSegments = [];
  state.media = null;
  state.mediaDurationSec = 0;
  $('#record-status').textContent = '';
  $('#upload-status').textContent = '';
  $('#media-preview').innerHTML = '';
  $('#media-file').value = '';
}

// 确保有可分析的数据（没有则用示例兜底）。
function ensureData() {
  const meta = readMeta();
  if (!state.headUpRateSamples.length) {
    state.headUpRateSamples = generateSampleHeadUpRateForSchedule(meta.schedule, meta.intervalSec);
  }
  state.speechSegments = parseTranscript($('#transcript-input').value);
}

// 计算分析结果。
function computeAnalysis() {
  const headUpRate = analyzeHeadUpRate(state.headUpRateSamples, 0.6);
  const speech = analyzeSpeechRate(state.speechSegments, state.durationMin);
  const tone = analyzeTone(state.speechSegments);
  return { headUpRate, speech, tone };
}

// —— 上传课堂视频 / 录音 ——
function setupUpload() {
  const zone = $('#upload-zone');
  const input = $('#media-file');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleMediaFile(input.files[0]);
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragging');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleMediaFile(file);
  });
}

function handleMediaFile(file) {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(file.name);
  if (!isVideo && !isAudio) {
    $('#upload-status').textContent = '仅支持音频或视频文件，请重新选择。';
    return;
  }
  const kind = isVideo ? '视频' : '音频';
  const url = URL.createObjectURL(file);
  state.media = { file, kind, url };
  $('#media-preview').innerHTML = isVideo
    ? `<video controls class="media-player" src="${url}"></video>`
    : `<audio controls class="media-player" src="${url}"></audio>`;

  const el = $('#media-preview').querySelector('video, audio');
  el.addEventListener('loadedmetadata', () => {
    state.mediaDurationSec = Math.round(Number(el.duration) || 0);
    buildFromMedia(kind);
    $('#upload-status').textContent = `已载入${kind}「${esc(file.name)}」，时长约 ${formatTime(state.mediaDurationSec)}。已生成示意转写与抬头率（原型演示，可编辑下方文本替换为真实转写）。`;
  });
  el.addEventListener('error', () => {
    $('#upload-status').textContent = '无法读取该文件时长（格式可能不受浏览器支持），请改用粘贴转写文本。';
  });
}

// 上传媒体后：生成示意转写 + 抬头率（真实“视频→音频→转写”需接入 ASR 服务）。
function buildFromMedia(kind) {
  const meta = readMeta();
  state.headUpRateSamples = generateSampleHeadUpRateForSchedule(meta.schedule, meta.intervalSec);
  $('#transcript-input').value = SAMPLE_TRANSCRIPT;
  state.speechSegments = parseTranscript(SAMPLE_TRANSCRIPT);
}

// —— 语音识别（Web Speech API，可选）——
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = false;
  return rec;
}

const SPEECH_ERRORS = {
  'not-allowed': '未获得麦克风权限，请在浏览器设置中允许后重试，或直接上传录音/粘贴转写文本。',
  'service-not-allowed': '当前浏览器禁止使用语音服务，请上传录音文件或粘贴转写文本。',
  'audio-capture': '未检测到可用麦克风，请上传录音文件或粘贴转写文本。',
  network: '语音服务网络异常，请上传录音文件或粘贴转写文本。',
  'no-speech': '未检测到语音，请确认麦克风正常后再试。',
  'language-not-supported': '当前浏览器不支持中文语音识别，请粘贴转写文本。',
};

function startRecording() {
  const rec = initRecognition();
  if (!rec) {
    $('#record-status').textContent = '当前浏览器不支持语音识别，请上传录音文件或粘贴转写文本。';
    return;
  }
  const startAt = Date.now();
  const utterances = [];
  let lastSec = 0;

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const text = (result[0].transcript || '').trim();
      if (!text) continue;
      const t = Math.round((Date.now() - startAt) / 1000);
      utterances.push({ start: lastSec, end: t, text });
      lastSec = t;
    }
  };
  rec.onerror = (event) => {
    $('#record-status').textContent = '识别出错：' + (SPEECH_ERRORS[event.error] || event.error || '未知错误');
    stopRecordingUI();
  };
  rec.onend = () => {
    stopRecordingUI();
    if (utterances.length) {
      const lines = utterances.map((u) => `[${formatTime(u.start)}-${formatTime(u.end)}] ${u.text}`);
      $('#transcript-input').value = lines.join('\n');
      $('#record-status').textContent = '识别结束，共 ' + utterances.length + ' 段。';
    }
  };

  try {
    rec.start();
  } catch (error) {
    $('#record-status').textContent = '无法启动录音：' + (error && error.message ? error.message : '未知错误') + '，请上传录音文件或粘贴转写文本。';
    stopRecordingUI();
    return;
  }
  state.recognition = rec;
  state.recording = true;
  $('#btn-record').disabled = true;
  $('#btn-stop-record').disabled = false;
  $('#record-status').textContent = '录音中…请开始讲课';
}

function stopRecording() {
  if (state.recognition) {
    try { state.recognition.stop(); } catch (error) { /* 忽略 */ }
  }
  stopRecordingUI();
}

function stopRecordingUI() {
  state.recording = false;
  $('#btn-record').disabled = false;
  $('#btn-stop-record').disabled = true;
}

// —— 步骤3：课堂感知分析 ——
function renderAnalysis() {
  const host = $('#analysis-result2');
  const { headUpRate, speech, tone } = computeAnalysis();

  const lowHtml = headUpRate.lowSegments.length
    ? headUpRate.lowSegments
        .map((s) => `<span class="tag is-difficult">${formatTime(s.start)} ~ ${formatTime(s.end)}</span>`)
        .join('')
    : '<span class="muted">未发现明显回落</span>';

  const breakHtml = headUpRate.breakSegments.length
    ? headUpRate.breakSegments
        .map((s) => `<span class="tag is-break">${formatTime(s.start)} ~ ${formatTime(s.end)}</span>`)
        .join('')
    : '<span class="muted">无课间休息</span>';

  host.innerHTML = `
    <div class="cards stat-cards">
      <div class="card"><h3>平均抬头率（上课）</h3><div class="stat-num">${Math.round(headUpRate.average * 100)}%</div></div>
      <div class="card"><h3>最低抬头率</h3><div class="stat-num">${Math.round(headUpRate.min * 100)}%</div></div>
      <div class="card"><h3>语速估算</h3><div class="stat-num">${speech.charsPerMin}</div><div class="stat-label">字/分钟（${speech.level}）</div></div>
      <div class="card"><h3>提问次数</h3><div class="stat-num">${tone.questions}</div></div>
    </div>

    <div class="chart-box">
      <h3>抬头率整体趋势（总时长 ${state.durationMin} 分钟，含课间休息）</h3>
      <canvas id="headup-chart" width="720" height="260"></canvas>
      <div class="chart-legend">
        <span class="legend-item"><i class="legend-dot dot-low"></i>注意力回落</span>
        <span class="legend-item"><i class="legend-dot dot-break"></i>课间休息</span>
        <span class="legend-item"><i class="legend-dot dot-curve"></i>抬头率曲线</span>
      </div>
    </div>

    <div class="cards">
      <div class="card">
        <h3>⚠️ 注意力回落时间段</h3>
        <div class="tag-list">${lowHtml}</div>
        <p class="muted">低于阈值说明该时段学生注意力可能下降，建议结合转写与互动情况综合判断。</p>
      </div>
      <div class="card">
        <h3>⏸️ 课间休息</h3>
        <div class="tag-list">${breakHtml}</div>
        <p class="muted">课间休息阶段学生离座放松，抬头率统计暂停，不计入平均抬头率。</p>
      </div>
      <div class="card">
        <h3>🎤 语速与语调</h3>
        <ul class="plain-list">
          <li>转写文本：共 ${speech.chars} 字，${speech.segmentCount} 段</li>
          <li>平均句长：约 ${tone.avgSentenceLen} 字</li>
          <li>停顿/口头语：约 ${tone.pauses} 次</li>
        </ul>
        <p class="muted">说明：语速为基于转写文本的估算；抬头率只统计整体趋势、不做人脸识别。</p>
      </div>
    </div>
  `;

  drawChart($('#headup-chart'), headUpRate, state.durationMin);
}

function drawChart(canvas, analysis, totalMin) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 720;
  const cssH = 260;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 18, right: 18, bottom: 28, left: 40 };
  const w = cssW - pad.left - pad.right;
  const h = cssH - pad.top - pad.bottom;
  const totalSec = totalMin * 60;

  ctx.clearRect(0, 0, cssW, cssH);

  const x = (t) => pad.left + (t / totalSec) * w;
  const y = (rate) => pad.top + (1 - rate) * h;

  // 背景网格与 y 轴刻度
  ctx.strokeStyle = '#eef2f6';
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px sans-serif';
  ctx.lineWidth = 1;
  for (let r = 0; r <= 1; r += 0.2) {
    const yy = y(r);
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(pad.left + w, yy);
    ctx.stroke();
    ctx.fillText(Math.round(r * 100) + '%', 6, yy + 4);
  }

  // 课间休息背景
  ctx.fillStyle = 'rgba(107, 114, 128, 0.14)';
  for (const seg of analysis.breakSegments || []) {
    ctx.fillRect(x(seg.start), pad.top, x(seg.end) - x(seg.start), h);
  }

  // 低注意力区间背景
  ctx.fillStyle = 'rgba(220, 38, 38, 0.08)';
  for (const seg of analysis.lowSegments) {
    ctx.fillRect(x(seg.start), pad.top, x(seg.end) - x(seg.start), h);
  }

  // x 轴刻度（每 10 分钟）
  for (let m = 0; m <= totalMin; m += 10) {
    const xx = x(m * 60);
    ctx.beginPath();
    ctx.moveTo(xx, pad.top);
    ctx.lineTo(xx, pad.top + h);
    ctx.stroke();
    ctx.fillText(m + '分', xx - 8, pad.top + h + 16);
  }

  // 阈值线
  ctx.strokeStyle = '#f59e0b';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, y(0.6));
  ctx.lineTo(pad.left + w, y(0.6));
  ctx.stroke();
  ctx.setLineDash([]);

  // 抬头率曲线
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  analysis.samples.forEach((s, i) => {
    const xx = x(s.t);
    const yy = y(s.rate);
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.stroke();
}

// —— 步骤4：课堂时间轴 ——
function renderTimeline() {
  const host = $('#timeline-result');
  const { headUpRate, speech, tone } = computeAnalysis();
  const events = buildTimeline(headUpRate, state.speechSegments);

  const items = events
    .map((e) => {
      const timeLabel = e.end ? `${formatTime(e.t)} ~ ${formatTime(e.end)}` : formatTime(e.t);
      const cls = `tl-item tl-${e.type}`;
      return `
        <div class="${cls}">
          <div class="tl-time">${timeLabel}</div>
          <div class="tl-badge">${e.label}</div>
          <div class="tl-detail">${esc(e.detail)}</div>
        </div>`;
    })
    .join('');

  const lowCount = headUpRate.lowSegments.length;
  const breakCount = headUpRate.breakSegments.length;
  host.innerHTML = `
    <div class="tl-summary">
      <div class="summary-item"><div class="num">${events.length}</div><div class="label">时间轴事件</div></div>
      <div class="summary-item"><div class="num">${lowCount}</div><div class="label">注意力回落段</div></div>
      <div class="summary-item"><div class="num">${breakCount}</div><div class="label">课间休息</div></div>
      <div class="summary-item"><div class="num">${speech.segmentCount}</div><div class="label">转写片段</div></div>
      <div class="summary-item"><div class="num">${tone.questions}</div><div class="label">提问</div></div>
    </div>
    <div class="timeline-list">${items}</div>
    <div class="warn-banner">💡 已生成带时间戳的课堂记录。抬头率仅作整体趋势参考，最终判断由教师/督导人工确认。</div>
  `;
}

// 导出课堂记录。
function exportRecord() {
  const { headUpRate, speech, tone } = computeAnalysis();
  const events = buildTimeline(headUpRate, state.speechSegments);
  const md = buildClassroomRecord({
    meta: { course: state.course, durationMin: state.durationMin, startTime: state.startTime, schedule: state.schedule },
    headUpRate,
    speech,
    tone,
    events,
  });
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '课堂记录-Sprint2.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 绑定事件。
function bindEvents() {
  setupUpload();

  $('#btn-sample2').addEventListener('click', loadSample);
  $('#btn-clear2').addEventListener('click', clearAll);

  $('#btn-to-transcript').addEventListener('click', () => {
    readMeta();
    goTo(2);
  });
  $('#btn-to-analysis').addEventListener('click', () => {
    readMeta();
    ensureData();
    goTo(3);
    renderAnalysis();
  });
  $('#btn-to-timeline').addEventListener('click', () => {
    ensureData();
    goTo(4);
    renderTimeline();
  });

  $('#btn-record').addEventListener('click', startRecording);
  $('#btn-stop-record').addEventListener('click', stopRecording);

  $('#btn-export-record').addEventListener('click', exportRecord);

  $$('.step').forEach((btn) =>
    btn.addEventListener('click', () => {
      const step = Number(btn.dataset.step);
      if (step >= 3) ensureData();
      goTo(step);
      if (step === 3) renderAnalysis();
      if (step === 4) renderTimeline();
    }),
  );
  $$('[data-prev]').forEach((btn) =>
    btn.addEventListener('click', () => goTo(Math.max(1, state.step - 1))),
  );
}

// 启动。
bindEvents();