// 前端交互入口：Sprint 2 课中课堂感知。
// 工作流：课堂设置 → 数据采集（上传/录音）→ 语音转写（Whisper/人工）→ 文本分析 → 课堂报告。
// 上传音频/视频后调用后端 /api/transcribe（Whisper），未安装 Whisper 时回退到示意转写。

import {
  buildSchedule,
  scheduleTotalMinutes,
  parseTranscript,
  analyzeSpeechRate,
  analyzeTone,
  analyzeKeywords,
  analyzeInteraction,
  buildTimeline,
  buildClassroomRecord,
  buildSummary,
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
  speechSegments: [],
  media: null,
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
  return { course: state.course, schedule: state.schedule, durationMin: state.durationMin, startTime: state.startTime };
}

function goTo(step) {
  state.step = step;
  $$('.step').forEach((b) => b.classList.toggle('is-active', b.dataset.step === String(step)));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === String(step)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 载入示例：填充示例转写。
function loadSample() {
  readMeta();
  $('#transcript-input').value = SAMPLE_TRANSCRIPT;
  state.speechSegments = parseTranscript(SAMPLE_TRANSCRIPT);
}

function clearAll() {
  $('#transcript-input').value = '';
  state.speechSegments = [];
  state.media = null;
  $('#record-status').textContent = '';
  $('#upload-status').textContent = '';
  $('#media-preview').innerHTML = '';
  $('#media-file').value = '';
}

// 确保有可分析的数据（没有则用示例兜底）。
function ensureData() {
  readMeta();
  if (!state.speechSegments.length) {
    $('#transcript-input').value = SAMPLE_TRANSCRIPT;
    state.speechSegments = parseTranscript(SAMPLE_TRANSCRIPT);
  }
}

// 计算分析结果（语速 / 语调 / 关键词 / 提问互动）。
function computeAnalysis() {
  const speech = analyzeSpeechRate(state.speechSegments, state.durationMin);
  const tone = analyzeTone(state.speechSegments);
  const keywords = analyzeKeywords(state.speechSegments, 15);
  const interaction = analyzeInteraction(state.speechSegments);
  return { speech, tone, keywords, interaction };
}

// —— 上传课堂录音 / 视频 ——
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

// 后端 Whisper 转写接口。
async function transcribeFile(file) {
  const resp = await fetch('/api/transcribe?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    body: file,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || data.error || '转写失败');
  }
  return data;
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
  $('#upload-status').textContent = '正在用 Whisper 转写，请稍候…';

  transcribeFile(file)
    .then((result) => {
      if (result && Array.isArray(result.segments) && result.segments.length) {
        const lines = result.segments
          .filter((s) => s.text && s.text.trim())
          .map((s) => `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.text.trim()}`);
        $('#transcript-input').value = lines.join('\n');
        state.speechSegments = parseTranscript($('#transcript-input').value);
        $('#upload-status').textContent = `Whisper 转写完成，共 ${result.segments.length} 段。可编辑下方文本后继续。`;
      } else if (result && result.error === 'whisper-not-installed') {
        buildFromMedia();
        $('#upload-status').textContent = '未安装 Whisper，已回退到示意转写：' + (result.message || '');
      } else {
        buildFromMedia();
        $('#upload-status').textContent = '未获取到转写结果，已回退到示意转写（可手动粘贴真实转写）。';
      }
    })
    .catch((err) => {
      buildFromMedia();
      $('#upload-status').textContent = '转写失败，已回退到示意转写：' + (err && err.message ? err.message : '网络错误');
    });
}

// 回退：填示例转写。
function buildFromMedia() {
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
      state.speechSegments = parseTranscript($('#transcript-input').value);
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

// —— 步骤3：课堂文本分析 ——
function renderAnalysis() {
  const host = $('#analysis-result2');
  const { speech, tone, keywords, interaction } = computeAnalysis();

  const keywordHtml = keywords.length
    ? keywords.map((k) => `<span class="tag is-keyword">${esc(k.word)} <em>${k.count}次</em></span>`).join('')
    : '<span class="muted">暂无关键词</span>';

  host.innerHTML = `
    <div class="cards stat-cards">
      <div class="card"><h3>语速估算</h3><div class="stat-num">${speech.charsPerMin}</div><div class="stat-label">字/分钟（${speech.level}）</div></div>
      <div class="card"><h3>转写字数</h3><div class="stat-num">${speech.chars}</div><div class="stat-label">共 ${speech.segmentCount} 段</div></div>
      <div class="card"><h3>提问次数</h3><div class="stat-num">${interaction.questions}</div></div>
      <div class="card"><h3>互动词频</h3><div class="stat-num">${interaction.interactionCount}</div></div>
    </div>

    <div class="cards">
      <div class="card">
        <h3>🎤 语速与语调</h3>
        <ul class="plain-list">
          <li>语速：约 ${speech.charsPerMin} 字/分钟（${speech.level}）</li>
          <li>平均句长：约 ${tone.avgSentenceLen} 字</li>
          <li>停顿/口头语：约 ${tone.pauses} 次</li>
        </ul>
        <p class="muted">语速为基于转写文本的估算，供教师调整讲解节奏参考。</p>
      </div>
      <div class="card">
        <h3>🔑 关键词提取</h3>
        <div class="tag-list">${keywordHtml}</div>
        <p class="muted">基于转写文本的高频词统计，帮助定位本课重点内容。</p>
      </div>
      <div class="card">
        <h3>💬 提问与互动</h3>
        <ul class="plain-list">
          <li>提问次数：${interaction.questions}</li>
          <li>互动相关词出现：约 ${interaction.interactionCount} 次</li>
          <li>提问片段：${interaction.questionSegments.length} 段</li>
        </ul>
        <p class="muted">互动越多通常说明课堂越活跃，供复盘参考。</p>
      </div>
    </div>
  `;
}

// —— 步骤4：课堂报告 ——
function renderTimeline() {
  const host = $('#timeline-result');
  const { speech, tone, keywords, interaction } = computeAnalysis();
  const summary = buildSummary({ speech, tone, keywords, interaction });
  const events = buildTimeline(state.schedule, state.speechSegments);

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

  const breakCount = events.filter((e) => e.type === 'break').length;
  const questionCount = events.filter((e) => e.type === 'question').length;

  host.innerHTML = `
    <div class="card">
      <h3>📋 课堂总结</h3>
      <p>${esc(summary.overview)}</p>
      ${summary.focus ? `<p>${esc(summary.focus)}</p>` : ''}
      <p><strong>${esc(summary.verdict)}</strong></p>
    </div>
    <div class="tl-summary">
      <div class="summary-item"><div class="num">${events.length}</div><div class="label">时间轴事件</div></div>
      <div class="summary-item"><div class="num">${speech.segmentCount}</div><div class="label">转写片段</div></div>
      <div class="summary-item"><div class="num">${questionCount}</div><div class="label">提问</div></div>
      <div class="summary-item"><div class="num">${breakCount}</div><div class="label">课间休息</div></div>
      <div class="summary-item"><div class="num">${keywords.length}</div><div class="label">关键词</div></div>
    </div>
    <div class="timeline-list">${items}</div>
    <div class="warn-banner">💡 已生成带时间戳的课堂分析报告。语音转写由 Whisper/人工完成，分析结果为统计参考，最终判断由教师/督导确认。</div>
  `;
}

// 导出课堂报告。
function exportRecord() {
  const { speech, tone, keywords, interaction } = computeAnalysis();
  const events = buildTimeline(state.schedule, state.speechSegments);
  const md = buildClassroomRecord({
    meta: { course: state.course, durationMin: state.durationMin, startTime: state.startTime, schedule: state.schedule },
    speech,
    tone,
    keywords,
    interaction,
    events,
  });
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '课堂报告-Sprint2.md';
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