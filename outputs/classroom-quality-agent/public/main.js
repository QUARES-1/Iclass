// 前端交互入口：把“资料上传 → 内容理解 → 前沿补充 → PPT 生成 → 人工审核”
// 五个功能切片串联成一条完整的课前智能备课流程。
// 核心解析、匹配、生成、审核逻辑复用 src/ 下的纯函数模块，保证浏览器与单元测试一致。

import { analyzeMaterials } from '../src/analyzer.js';
import { matchSupplements } from '../src/frontier.js';
import { generateOutline, toMarkdown } from '../src/pptGenerator.js';
import { slidesToExportModel, buildPresentation } from '../src/pptExport.js';
import {
  setSlideStatus,
  updateSlide,
  summarizeReview,
  isReviewComplete,
  SLIDE_STATUS,
} from '../src/review.js';
import { SAMPLE_MATERIALS } from './sample.js';

// 全局状态：保存当前步骤、解析结果、用户选择与生成的幻灯片。
const state = {
  step: 1,
  uploads: [],            // 通过文件上传额外导入的资料
  analysis: null,         // 内容理解结果
  supplements: [],        // 匹配到的前沿补充
  selectedPoints: new Set(),     // 纳入 PPT 的知识点
  selectedSupplements: new Set(),// 纳入 PPT 的补充 id
  slides: [],             // 生成的 PPT 幻灯片
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

// 步骤①→②：解析资料并初始化“内容理解”与“前沿补充”的默认选择。
function ensureAnalysis() {
  if (state.analysis) return;
  const materials = collectMaterials();
  state.analysis = analyzeMaterials(materials);
  state.supplements = matchSupplements(state.analysis.knowledgePoints);
  state.selectedPoints = new Set(state.analysis.knowledgePoints);
  state.selectedSupplements = new Set(state.supplements.map((item) => item.id));
  state.slides = [];
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
function navigateTo(step) {
  if (step >= 2) ensureAnalysis();
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

  host.innerHTML = `
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
            <span class="pill ${item.needsVerify ? 'pill-verify' : 'pill-ok'}">${item.needsVerify ? '待核验' : '已核验'}</span>
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

// 渲染“PPT 生成”预览面板（只读预览）。
function renderPptPreview() {
  const host = $('#ppt-preview');
  if (!state.slides.length) {
    host.innerHTML = '<div class="empty">尚未生成 PPT，请返回上一步确认知识点与补充。</div>';
    return;
  }
  host.innerHTML = state.slides
    .map(
      (slide) => `
      <div class="slide">
        <div class="slide-head">
          <span class="section-badge">${esc(slide.section)}</span>
          <span class="title">${esc(slide.title)}</span>
        </div>
        <div class="slide-body">
          <ul>${slide.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
          ${slide.notes.length ? `<div class="slide-notes">${slide.notes.map(esc).join('<br/>')}</div>` : ''}
        </div>
      </div>`,
    )
    .join('');
}

// 渲染“人工审核”面板：支持编辑标题/正文、确认、删除。
function renderReview() {
  const host = $('#review-list');
  const summary = $('#review-summary');
  if (!state.slides.length) {
    host.innerHTML = '<div class="empty">尚未生成 PPT，请先完成生成步骤。</div>';
    summary.innerHTML = '';
    return;
  }

  const stats = summarizeReview(state.slides);
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
  const coverTitle = (state.analysis && state.analysis.chapters[0]) || '课堂质量改进智能体 · 课前智能备课';
  const model = slidesToExportModel(state.slides, { coverTitle });
  const pptx = buildPresentation(model, PptxGenJS);
  pptx.write({ outputType: 'blob' })
    .then((blob) => downloadBlob(filename, blob))
    .catch((error) => {
      console.error(error);
      alert('生成 PPT 失败：' + (error && error.message ? error.message : error));
    });
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
    state.slides = [];
    renderFileChips();
  });

  $('#file-input').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      const text = await file.text();
      if (text.trim()) state.uploads.push({ type: '补充资料', title: file.name, content: text });
    }
    event.target.value = '';
    renderFileChips();
  });

  $('#btn-analyze').addEventListener('click', () => {
    if (!collectMaterials().length) {
      alert('请先上传或粘贴至少一份教学资料。');
      return;
    }
    state.analysis = null;
    state.slides = [];
    ensureAnalysis();
    goTo(2);
    render();
  });

  $('#btn-to-supplement').addEventListener('click', () => navigateTo(3));
  $('#btn-to-generate').addEventListener('click', () => {
    state.slides = [];
    ensureSlides();
    goTo(4);
    render();
  });
  $('#btn-to-review').addEventListener('click', () => navigateTo(5));

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
  state.supplements = [];
  state.slides = [];
}

// 首次打开时若资料为空，则自动填入示例，方便完整体验流程。
function seedSampleIfEmpty() {
  const isEmpty = ['#mat-lesson-plan', '#mat-textbook', '#mat-syllabus', '#mat-past-ppt'].every(
    (selector) => !$(selector).value.trim(),
  );
  if (isEmpty) fillSample();
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
seedSampleIfEmpty();
renderFileChips();
