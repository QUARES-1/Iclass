// 前端交互入口：把“资料上传 → 内容理解 → 前沿补充 → PPT 生成 → 人工审核”
// 五个功能切片串联成一条完整的课前智能备课流程。
// 核心解析、匹配、生成、审核逻辑复用 src/ 下的纯函数模块，保证浏览器与单元测试一致。

import { analyzeMaterials } from '../src/analyzer.js';
import { matchSupplements } from '../src/frontier.js';
import { generateOutline, toMarkdown } from '../src/pptGenerator.js';
import {
  slidesToExportModel,
  buildPresentation,
  deriveCoverContent,
  selectSlideLayout,
} from '../src/pptExport.js';
import {
  setSlideStatus,
  confirmAllSlides,
  updateSlide,
  summarizeReview,
  isReviewComplete,
  SLIDE_STATUS,
} from '../src/review.js';
import { SAMPLE_MATERIALS } from './sample.js';
import { readDocxText } from '../src/docxReader.js';

// 全局状态：保存当前步骤、解析结果、用户选择与生成的幻灯片。
const state = {
  step: 1,
  uploads: [],            // 通过文件上传额外导入的资料
  analysis: null,         // 内容理解结果
  analysisSource: null,   // llm 或 local，用于向教师说明解析来源
  analysisWarning: '',    // AI 失败并回退本地规则时的提示
  supplements: [],        // 匹配到的前沿补充
  selectedPoints: new Set(),     // 纳入 PPT 的知识点
  selectedSupplements: new Set(),// 纳入 PPT 的补充 id
  slides: [],             // 生成的 PPT 幻灯片
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown']);

// 转义 HTML，防止把资料中的特殊字符渲染成标签。
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把四个文本域中的资料收集为统一结构；内容为空的不参与解析。
function collectTextareaMaterials() {
  const fields = [
    ['历史教案', '#mat-lesson-plan'],
    ['教学用书', '#mat-textbook'],
    ['教学大纲', '#mat-syllabus'],
    ['往年PPT', '#mat-past-ppt'],
  ];
  return fields
    .map(([type, selector]) => ({ type, title: type, content: $(selector).value }))
    .filter((item) => item.content.trim());
}

// 收集全部资料（文本域 + 已上传文件）。
function collectMaterials() {
  return [...collectTextareaMaterials(), ...state.uploads];
}

function showFileStatus(text, isError = false) {
  const host = $('#file-status');
  if (!host) return;
  host.textContent = text || '';
  host.style.color = isError ? '#b91c1c' : '';
}

// PPTX 交给后端解析，避免在浏览器中误读二进制文件。
async function readServerParsedFile(file) {
  const response = await fetch('/api/extract-file?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `文件解析失败（${response.status}）`);
  return data;
}

async function readUploadedFile(file) {
  const extension = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('文件超过 15 MB 上传限制');

  if (extension === 'docx') {
    return { content: await readDocxText(file), type: '补充资料', truncated: false };
  }
  if (extension === 'pptx' || extension === 'ppt') {
    const result = await readServerParsedFile(file);
    return {
      content: result.content,
      type: extension === 'pptx' || extension === 'ppt' ? '往年PPT' : '补充资料',
      truncated: Boolean(result.truncated),
    };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { content: await file.text(), type: '补充资料', truncated: false };
  }
  throw new Error('不支持该文件类型');
}

async function requestMaterialAnalysis(materials) {
  const response = await fetch('/api/analyze-materials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ materials }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `内容理解请求失败（${response.status}）`);
  if (!data.analysis || typeof data.analysis !== 'object') throw new Error('后端未返回有效的内容理解结果');
  return data;
}

// 步骤①→②：优先使用后端 AI 解析；网络或服务异常时回退现有本地规则。
async function ensureAnalysis() {
  if (state.analysis) return state.analysis;
  const materials = collectMaterials();
  let result;
  try {
    result = await requestMaterialAnalysis(materials);
  } catch (error) {
    result = {
      source: 'local',
      analysis: analyzeMaterials(materials),
      warning: error && error.message ? error.message : String(error),
    };
  }
  state.analysis = result.analysis;
  state.analysisSource = result.source || 'local';
  state.analysisWarning = result.warning || '';
  state.supplements = matchSupplements(state.analysis.knowledgePoints);
  state.selectedPoints = new Set(state.analysis.knowledgePoints);
  state.selectedSupplements = new Set(state.supplements.map((item) => item.id));
  state.slides = [];
  return state.analysis;
}

// 步骤③→④：根据用户勾选的知识点与补充生成 PPT 大纲。
function ensureSlides() {
  if (state.slides.length) return;
  const knowledgePoints = state.analysis.knowledgePoints.filter((point) =>
    state.selectedPoints.has(point),
  );
  const supplements = state.supplements.filter((item) =>
    state.selectedSupplements.has(item.id),
  );
  const filteredAnalysis = { ...state.analysis, knowledgePoints };
  state.slides = generateOutline(filteredAnalysis, supplements);
}

// 切换步骤，并更新步骤条与面板的激活态。
function goTo(step) {
  state.step = step;
  $$('.step').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.step === String(step)));
  $$('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === String(step)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 带前置依赖校验的导航：进入后续步骤前自动补齐缺失的计算结果。
async function navigateTo(step) {
  if (step >= 2) await ensureAnalysis();
  if (step >= 4) ensureSlides();
  goTo(step);
  render();
}

// 渲染“内容理解”面板。
function renderAnalysis() {
  const host = $('#analysis-result');
  if (!state.analysis) {
    host.innerHTML = '<div class="empty">请先在步骤①上传或粘贴教学资料。</div>';
    return;
  }
  const a = state.analysis;
  const sourceBanner = state.analysisSource === 'llm'
    ? '<div class="success-banner">✓ AI 内容理解完成，已根据资料语义提取章节、目标、知识点、重点和难点。</div>'
    : `<div class="warn-banner">已使用本地规则完成解析${state.analysisWarning ? `：${esc(state.analysisWarning)}` : '。如需语义识别，请检查后端 AI 配置。'}</div>`;

  const tags = (items, extraClass = '') =>
    items.length
      ? `<div class="tag-list">${items.map((item) => `<span class="tag ${extraClass}">${esc(item)}</span>`).join('')}</div>`
      : '<span class="muted">暂无</span>';

  const points = a.knowledgePoints
    .map(
      (point) => `
      <label class="check-item">
        <input type="checkbox" data-point="${esc(point)}" ${state.selectedPoints.has(point) ? 'checked' : ''} />
        <span>${esc(point)}</span>
      </label>`,
    )
    .join('');

  host.innerHTML = `${sourceBanner}
    <div class="cards">
      <div class="card"><h3>📚 章节</h3>${tags(a.chapters)}</div>
      <div class="card"><h3>🎯 教学目标</h3>${tags(a.objectives)}</div>
      <div class="card"><h3>⭐ 教学重点</h3>${tags(a.keyPoints, 'is-key')}</div>
      <div class="card"><h3>⚠️ 教学难点</h3>${tags(a.difficultPoints, 'is-difficult')}</div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>🧩 知识点（勾选要纳入 PPT 的内容）</h3>
      ${points || '<span class="muted">未识别到知识点，请检查资料格式。</span>'}
    </div>`;

  host.querySelectorAll('input[data-point]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selectedPoints.add(input.dataset.point);
      else state.selectedPoints.delete(input.dataset.point);
      state.slides = []; // 选择变化后，旧的幻灯片作废。
    });
  });
}

// 渲染“前沿补充”面板。
function renderSupplements() {
  const host = $('#supplement-result');
  if (!state.supplements.length) {
    host.innerHTML = '<div class="empty">未匹配到前沿补充，可返回上一步调整知识点。</div>';
    return;
  }
  const cards = state.supplements
    .map(
      (item) => `
      <div class="supplement-card">
        <input class="check" type="checkbox" data-supp="${item.id}" ${state.selectedSupplements.has(item.id) ? 'checked' : ''} />
        <div class="supplement-body">
          <div class="supplement-title">${esc(item.title)}</div>
          <div class="supplement-desc">${esc(item.description)}</div>
          <div class="supplement-meta">
            <span class="pill ${item.type === '技术' ? 'pill-tech' : 'pill-case'}">${item.type}</span>
            <span>来源：${esc(item.source)}</span>
            <span>匹配自：${esc(item.matchedBy)}</span>
          </div>
        </div>
      </div>`,
    )
    .join('');

  host.innerHTML = cards;
  host.querySelectorAll('input[data-supp]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selectedSupplements.add(input.dataset.supp);
      else state.selectedSupplements.delete(input.dataset.supp);
      state.slides = [];
    });
  });
}

const PREVIEW_LAYOUT_LABELS = {
  intro: '情境导入',
  concept: '概念辨析',
  algorithm: '步骤讲解',
  comparison: '比较矩阵',
  case: '案例路径',
  interaction: '课堂互动',
  summary: '知识地图',
};

function splitPreviewLabel(text, fallback) {
  const match = String(text || '').match(/^([^：:]{1,12})[：:]\s*(.+)$/);
  return match ? [match[1], match[2]] : [fallback, String(text || '')];
}

function renderPreviewBody(slide, layout) {
  const bullets = Array.isArray(slide.bullets)
    ? slide.bullets.slice(0, layout === 'summary' ? 6 : 4)
    : [];
  if (layout === 'intro') {
    return `<div class="preview-grid">${bullets.map((text, index) => `
      <div class="preview-grid-item"><b>0${index + 1}</b><span>${esc(text)}</span></div>`).join('')}</div>`;
  }
  if (layout === 'algorithm') {
    const metricPattern = /^(时间复杂度|空间复杂度|稳定性|适用场景|特点)[：:]/;
    const steps = (slide.steps || bullets.filter((text) => !metricPattern.test(text))).slice(0, 4);
    const structuredMetrics = Array.isArray(slide.metrics)
      ? slide.metrics.map((entry) => typeof entry === 'string'
        ? entry
        : `${entry.label || entry.name || '指标'}：${entry.value || entry.text || ''}`)
      : slide.metrics && typeof slide.metrics === 'object'
        ? Object.entries(slide.metrics).map(([label, value]) => `${label}：${value}`)
        : [];
    const metrics = (structuredMetrics.length
      ? structuredMetrics
      : bullets.filter((text) => metricPattern.test(text))).slice(0, 4);
    if (!metrics.length) {
      return `<ol class="preview-steps preview-steps-wide">${steps.map((text) => `<li>${esc(text)}</li>`).join('')}</ol>`;
    }
    return `<div class="preview-split">
      <ol class="preview-steps">${steps.map((text) => `<li>${esc(text)}</li>`).join('')}</ol>
      <div class="preview-metrics">${metrics.map((text) => `<span>${esc(text)}</span>`).join('')}</div>
    </div>`;
  }
  if (layout === 'comparison') {
    const rows = Array.isArray(slide.comparisonRows) && slide.comparisonRows.length
      ? slide.comparisonRows.slice(0, 5).map((row, index) => Array.isArray(row)
        ? row : [row.label || row.name || `维度 ${index + 1}`, row.value || row.text || ''])
      : bullets.map((text, index) => splitPreviewLabel(text, `要点 ${index + 1}`));
    return `<table class="preview-table"><thead><tr><th>比较维度</th><th>教学结论</th></tr></thead><tbody>${rows
      .map((row) => `<tr><td>${esc(row[0])}</td><td>${esc(row[1])}</td></tr>`).join('')}</tbody></table>`;
  }
  if (layout === 'case') {
    return `<div class="preview-timeline">${bullets.map((text, index) => {
      const [label, value] = splitPreviewLabel(text, `环节 ${index + 1}`);
      return `<div><b>${index + 1}</b><strong>${esc(label)}</strong><span>${esc(value)}</span></div>`;
    }).join('')}</div>`;
  }
  if (layout === 'interaction') {
    return `<div class="preview-question">${esc(bullets[0] || '课堂主问题')}</div>
      <div class="preview-prompts">${bullets.slice(1).map((text) => `<span>${esc(text)}</span>`).join('')}</div>`;
  }
  if (layout === 'summary') {
    return `<div class="preview-map"><strong>核心要点</strong>${bullets.map((text) => `<span>${esc(text)}</span>`).join('')}</div>`;
  }
  const left = bullets.slice(0, 2);
  const generatedExamples = [
    slide.example ? `示例：${slide.example}` : '',
    slide.counterExample ? `反例：${slide.counterExample}` : '',
  ].filter(Boolean);
  const right = generatedExamples.length ? generatedExamples : bullets.slice(2);
  return `<div class="preview-definition"><div><b>核心内容</b>${left.map((text) => `<p>${esc(text)}</p>`).join('')}</div>
    <div><b>${generatedExamples.length ? 'AI 示例与反例' : '关键理解与辨析'}</b>${right.map((text) => `<p>${esc(text)}</p>`).join('')}</div></div>`;
}

// 渲染“PPT 生成”预览面板（只读预览）。
function renderPptPreview() {
  const host = $('#ppt-preview');
  if (!state.slides.length) {
    host.innerHTML = '<div class="empty">尚未生成 PPT，请返回上一步确认知识点与补充。</div>';
    return;
  }
  host.innerHTML = state.slides
    .map((slide) => {
      const layout = selectSlideLayout(slide);
      return `
      <div class="slide preview-layout-${layout}">
        <div class="slide-head">
          <span class="section-badge">${esc(slide.section)}</span>
          <span class="title">${esc(slide.title)}</span>
          <span class="layout-badge">${esc(PREVIEW_LAYOUT_LABELS[layout] || '结构化内容')}</span>
        </div>
        <div class="slide-body">
          ${renderPreviewBody(slide, layout)}
          ${slide.notes?.length ? `<div class="slide-notes">${slide.notes.map(esc).join('<br/>')}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

// 渲染“人工审核”面板：支持编辑标题/正文、确认、删除。
function renderReview() {
  const host = $('#review-list');
  const summary = $('#review-summary');
  const confirmAllButton = $('#btn-confirm-all');
  if (!state.slides.length) {
    host.innerHTML = '<div class="empty">尚未生成 PPT，请先完成生成步骤。</div>';
    summary.innerHTML = '';
    confirmAllButton.disabled = true;
    return;
  }

  const stats = summarizeReview(state.slides);
  confirmAllButton.disabled = stats.pending === 0;
  summary.innerHTML = `
    <div class="summary-item"><div class="num">${stats.total}</div><div class="label">总数</div></div>
    <div class="summary-item"><div class="num">${stats.confirmed}</div><div class="label">已确认</div></div>
    <div class="summary-item"><div class="num">${stats.pending}</div><div class="label">待确认</div></div>
    <div class="summary-item"><div class="num">${stats.deleted}</div><div class="label">已删除</div></div>`;

  const banner = isReviewComplete(state.slides)
    ? '<div class="success-banner">✅ 全部内容已审核确认，可导出并用于正式授课。</div>'
    : '<div class="warn-banner">⚠️ 尚有未确认内容：未经教师确认的内容不能直接用于正式授课。</div>';

  host.innerHTML =
    banner +
    state.slides
      .map(
        (slide) => `
        <div class="slide" data-slide="${slide.id}">
          <div class="slide-head">
            <span class="section-badge">${esc(slide.section)}</span>
            <span class="status status-${slide.status}">${
              slide.status === 'confirmed' ? '已确认' : slide.status === 'deleted' ? '已删除' : '待确认'
            }</span>
          </div>
          <div class="slide-body">
            <input class="slide-edit-title" value="${esc(slide.title)}" data-role="title" />
            <textarea class="slide-edit-bullets" data-role="bullets">${esc(slide.bullets.join('\n'))}</textarea>
            ${slide.example || slide.counterExample ? `
              <label class="review-extra-field">AI 示例
                <textarea class="slide-edit-extra" data-role="example">${esc(slide.example || '')}</textarea>
              </label>
              <label class="review-extra-field">AI 反例
                <textarea class="slide-edit-extra" data-role="counterExample">${esc(slide.counterExample || '')}</textarea>
              </label>` : ''}
            ${
              slide.notes.length
                ? `<div class="slide-notes">${slide.notes.map(esc).join('<br/>')}</div>`
                : ''
            }
          </div>
          <div class="review-tools">
            <button class="btn" data-action="confirm">确认</button>
            <button class="btn" data-action="toggle-delete">${
              slide.status === 'deleted' ? '恢复' : '删除'
            }</button>
          </div>
        </div>`,
      )
      .join('');

  // 编辑标题与正文时只更新状态，不重新渲染，避免输入框失焦。
  host.querySelectorAll('[data-role="title"]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const id = event.target.closest('.slide').dataset.slide;
      state.slides = updateSlide(state.slides, id, { title: event.target.value });
    });
  });
  host.querySelectorAll('[data-role="bullets"]').forEach((textarea) => {
    textarea.addEventListener('input', (event) => {
      const id = event.target.closest('.slide').dataset.slide;
      state.slides = updateSlide(state.slides, id, {
        bullets: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
      });
    });
  });
  host.querySelectorAll('[data-role="example"], [data-role="counterExample"]').forEach((textarea) => {
    textarea.addEventListener('input', (event) => {
      const id = event.target.closest('.slide').dataset.slide;
      state.slides = updateSlide(state.slides, id, { [event.target.dataset.role]: event.target.value.trim() });
    });
  });

  // 确认/删除会改变状态徽标与汇总，因此操作后整体重新渲染。
  host.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const id = event.target.closest('.slide').dataset.slide;
      const action = event.target.dataset.action;
      if (action === 'confirm') {
        state.slides = setSlideStatus(state.slides, id, SLIDE_STATUS.CONFIRMED);
      } else if (action === 'toggle-delete') {
        const slide = state.slides.find((item) => item.id === id);
        const next = slide.status === SLIDE_STATUS.DELETED ? SLIDE_STATUS.PENDING : SLIDE_STATUS.DELETED;
        state.slides = setSlideStatus(state.slides, id, next);
      }
      renderReview();
    });
  });
}

// 根据当前步骤渲染对应面板。
function render() {
  if (state.step === 2) renderAnalysis();
  if (state.step === 3) renderSupplements();
  if (state.step === 4) renderPptPreview();
  if (state.step === 5) renderReview();
}

// 触发浏览器下载 Markdown 文件。
function download(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(filename, blob);
}

// 触发浏览器下载任意二进制 Blob。
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 生成并下载真正的 PowerPoint（.pptx）文件。
function downloadPptx(filename) {
  if (!state.slides.length) {
    alert('还没有可导出的 PPT 内容，请先生成 PPT。');
    return;
  }
  const PptxGenJS = window.PptxGenJS;
  if (!PptxGenJS) {
    alert('PPT 组件未加载，请刷新页面后重试。');
    return;
  }
  const coverContent = deriveCoverContent(state.analysis || {}, state.slides);
  const model = slidesToExportModel(state.slides, coverContent);
  const pptx = buildPresentation(model, PptxGenJS);
  pptx.write({ outputType: 'blob' })
    .then((blob) => downloadBlob(filename, blob))
    .catch((error) => {
      console.error(error);
      alert('生成 PPT 失败：' + (error && error.message ? error.message : error));
    });
}

// 显示 AI 生成状态提示。
function showAiStatus(text) {
  const host = $('#ai-status');
  if (!host) return;
  host.textContent = text || '';
}

// 调用后端接口，用大模型生成 PPT 大纲。
async function generateWithAI() {
  if (!state.analysis) {
    alert('请先完成内容理解。');
    return;
  }
  const knowledgePoints = state.analysis.knowledgePoints.filter((point) =>
    state.selectedPoints.has(point),
  );
  const supplements = state.supplements.filter((item) =>
    state.selectedSupplements.has(item.id),
  );
  const filteredAnalysis = { ...state.analysis, knowledgePoints };

  const btn = $('#btn-ai-generate');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '生成中…';
  showAiStatus('');

  try {
    const resp = await fetch('/api/generate-outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysis: filteredAnalysis, supplements }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || '请求失败（' + resp.status + '）');

    state.slides = data.slides || [];
    if (data.source === 'llm') {
      showAiStatus('✅ AI 生成完成，共 ' + state.slides.length + ' 页。');
    } else {
      showAiStatus('ℹ️ 已用本地模板生成' + (data.warning ? '（' + data.warning + '）' : '') + '。');
    }
    renderPptPreview();
  } catch (error) {
    showAiStatus('❌ ' + (error && error.message ? error.message : error));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 绑定所有按钮与交互事件。
function bindEvents() {
  $('#btn-sample').addEventListener('click', fillSample);

  $('#btn-clear').addEventListener('click', () => {
    ['#mat-lesson-plan', '#mat-textbook', '#mat-syllabus', '#mat-past-ppt'].forEach(
      (selector) => { $(selector).value = ''; },
    );
    state.uploads = [];
    state.analysis = null;
    state.analysisSource = null;
    state.analysisWarning = '';
    state.slides = [];
    renderFileChips();
    showFileStatus('');
  });

  $('#file-input').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    const failures = [];
    let imported = 0;
    showFileStatus(files.length ? `正在读取 ${files.length} 个文件…` : '');
    for (const file of files) {
      try {
        const result = await readUploadedFile(file);
        if (!result.content.trim()) throw new Error('没有提取到可用文字');
        // 同名文件再次上传时替换旧内容，避免重复资料影响内容理解。
        state.uploads = state.uploads.filter((item) => item.title !== file.name);
        state.uploads.push({ type: result.type, title: file.name, content: result.content });
        imported += 1;
        if (result.truncated) failures.push(`${file.name}：内容过长，已截取前 250000 个字符`);
      } catch (error) {
        failures.push(`${file.name}：${error && error.message ? error.message : error}`);
      }
    }
    event.target.value = '';
    if (imported) {
      state.analysis = null;
      state.analysisSource = null;
      state.analysisWarning = '';
      state.supplements = [];
      state.slides = [];
    }
    renderFileChips();
    const summary = imported ? `已成功读取 ${imported} 个文件。` : '';
    showFileStatus([summary, ...failures].filter(Boolean).join(' '), failures.length > 0);
  });

  $('#btn-analyze').addEventListener('click', async () => {
    if (!collectMaterials().length) {
      alert('请先上传或粘贴至少一份教学资料。');
      return;
    }
    const button = $('#btn-analyze');
    const originalText = button.textContent;
    state.analysis = null;
    state.analysisSource = null;
    state.analysisWarning = '';
    state.slides = [];
    goTo(2);
    $('#analysis-result').innerHTML = '<div class="empty">AI 正在理解教学资料，请稍候…</div>';
    button.disabled = true;
    try {
      await ensureAnalysis();
      render();
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  $('#btn-to-supplement').addEventListener('click', () => navigateTo(3));
  $('#btn-to-generate').addEventListener('click', () => {
    state.slides = [];
    ensureSlides();
    goTo(4);
    render();
  });
  $('#btn-to-review').addEventListener('click', () => navigateTo(5));

  $('#btn-confirm-all').addEventListener('click', () => {
    state.slides = confirmAllSlides(state.slides);
    renderReview();
  });

  $('#btn-ai-generate').addEventListener('click', generateWithAI);

  $('#btn-export-md').addEventListener('click', () =>
    download('PPT初稿-Sprint1.md', toMarkdown(state.slides)),
  );
  $('#btn-export-pptx').addEventListener('click', () =>
    downloadPptx('PPT初稿-Sprint1.pptx'),
  );
  $('#btn-export-final').addEventListener('click', () =>
    download('PPT最终稿-Sprint1.md', toMarkdown(state.slides)),
  );
  $('#btn-export-pptx-final').addEventListener('click', () =>
    downloadPptx('PPT最终稿-Sprint1.pptx'),
  );

  $$('.step').forEach((btn) =>
    btn.addEventListener('click', () => navigateTo(Number(btn.dataset.step))),
  );
  $$('[data-prev]').forEach((btn) =>
    btn.addEventListener('click', () => navigateTo(Math.max(1, state.step - 1))),
  );
}

// 用示例教学资料填充四个文本域。
function fillSample() {
  $('#mat-lesson-plan').value = SAMPLE_MATERIALS.lessonPlan;
  $('#mat-textbook').value = SAMPLE_MATERIALS.textbook;
  $('#mat-syllabus').value = SAMPLE_MATERIALS.syllabus;
  $('#mat-past-ppt').value = SAMPLE_MATERIALS.pastPpt;
  // 资料已变化，作废旧有解析结果，避免展示过期的“内容理解/PPT”。
  state.analysis = null;
  state.analysisSource = null;
  state.analysisWarning = '';
  state.supplements = [];
  state.slides = [];
}

// 渲染已上传文件的小标签。
function renderFileChips() {
  const host = $('#file-chips');
  if (!state.uploads.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = state.uploads
    .map((item) => `<span class="chip">📄 ${esc(item.title)}</span>`)
    .join('');
}

// 启动应用。
bindEvents();
renderFileChips();
