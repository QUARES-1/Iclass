// AI supplies a declarative activity. The executable renderer is owned by this app.
// No AI HTML or script is evaluated, and preview and export use this exact renderer.
export function validateActivity(value) {
  if (!value || !['quiz', 'order', 'match', 'steps'].includes(value.mode)) throw new Error('互动类型需为 quiz、order、match 或 steps。');
  const str = (v, label) => { if (typeof v !== 'string' || !v.trim() || v.length > 6000) throw new Error(label + '不能为空或过长。'); return v.trim(); };
  const a = { mode: value.mode, title: str(value.title, '标题'), description: str(value.description, '说明'), hint: str(value.hint, '操作提示'), explanation: str(value.explanation, '反馈解释') };
  if (a.mode === 'quiz') {
    if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 30) throw new Error('题目数量应为 1～30。');
    a.questions = value.questions.map(q => {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) throw new Error('题目答案或选项无效。');
      return { prompt: str(q.prompt, '题干'), options: q.options.map(o => str(o, '选项')), answer: q.answer, explanation: str(q.explanation, '题目解释') };
    });
  } else if (a.mode === 'match') {
    if (!Array.isArray(value.pairs) || value.pairs.length < 2 || value.pairs.length > 16) throw new Error('配对数量应为 2～16。');
    a.pairs = value.pairs.map(p => ({ left: str(p.left, '概念'), right: str(p.right, '解释') }));
    if (new Set(a.pairs.map(p => p.left)).size !== a.pairs.length || new Set(a.pairs.map(p => p.right)).size !== a.pairs.length) throw new Error('配对项必须互不重复。');
  } else {
    if (!Array.isArray(value.items) || value.items.length < 2 || value.items.length > 40) throw new Error('步骤数量应为 2～40。');
    a.items = value.items.map(i => str(i, '步骤'));
    if (new Set(a.items).size !== a.items.length) throw new Error('排序或步骤项必须互不重复。');
    if (a.mode === 'order') {
      a.rule = value.rule || 'sequence';
      if (!['sequence', 'bubble'].includes(a.rule)) throw new Error('排序规则需为 sequence 或 bubble。');
      if (a.rule === 'bubble') {
        if (a.items.some(v => !Number.isFinite(Number(v)))) throw new Error('冒泡排序项需为数字。');
        a.items.sort((x, y) => Number(x) - Number(y));
      }
    }
  }
  return a;
}

function activityRuntime(a, token) {
  const root = document.getElementById('activity');
  const feedback = document.getElementById('feedback');
  let step = 0, chosen = null, moving = null, order = [], correct = new Set();
  const el = (tag, text, parent = root) => { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; };
  const say = (text, ok = false) => { feedback.textContent = text; feedback.dataset.ok = String(ok); };
  const button = (text, handler, parent = root) => { const b = el('button', text, parent); b.type = 'button'; b.onclick = handler; return b; };
  const shuffled = values => values.length > 1 ? [...values.slice(1), values[0]] : [...values];
  function draw() {
    root.replaceChildren();
    if (a.mode === 'quiz') {
      if (step >= a.questions.length) { el('h2', '答题完成'); say('全部答对。' + a.explanation, true); return; }
      const q = a.questions[step];
      el('p', `第 ${step + 1} / ${a.questions.length} 题`);
      el('h2', q.prompt);
      q.options.forEach((text, index) => button(text, () => {
        const ok = index === q.answer;
        say((ok ? '回答正确。' : '回答不正确，请再试一次。') + q.explanation, ok);
        if (ok && !root.querySelector('[data-next]')) { const next = button('下一题', () => { step++; say(''); draw(); }); next.dataset.next = '1'; }
      }));
    } else if (a.mode === 'order') {
      el('p', a.rule === 'bubble' ? '从左向右比较；只可交换相邻且逆序的数字。拖动一个数字到相邻位置，或使用右移按钮。' : '拖动卡片排列步骤；也可使用上下移动按钮。');
      order.forEach((text, index) => {
        const row = el('div', '', root); row.className = 'item'; row.draggable = true; row.dataset.index = index;
        el('span', text, row);
        row.ondragstart = event => { moving = index; event.dataTransfer.setData('text/plain', String(index)); };
        row.ondragover = event => event.preventDefault();
        row.ondrop = event => { event.preventDefault(); move(moving, index); };
        if (a.rule === 'bubble') button('向右比较 / 交换', () => move(index, index + 1), row);
        else { button('↑', () => move(index, index - 1), row); button('↓', () => move(index, index + 1), row); }
      });
      button('检查答案', () => { const ok = order.every((v, i) => v === a.items[i]); say((ok ? '顺序正确。' : '顺序还不正确。') + a.explanation, ok); });
    } else if (a.mode === 'match') {
      const columns = el('div', '', root); columns.className = 'columns';
      const left = el('div', '', columns), right = el('div', '', columns);
      a.pairs.forEach((p, i) => { const b = button(p.left, () => { chosen = i; draw(); }, left); b.disabled = correct.has(i); b.dataset.selected = String(chosen === i); });
      shuffled(a.pairs.map((_, i) => i)).forEach(i => {
        const b = button(a.pairs[i].right, () => {
          if (chosen === null) { say('先选择左侧概念。'); return; }
          const ok = chosen === i;
          say((ok ? '配对正确。' : '配对不正确。') + a.explanation, ok);
          if (ok) { correct.add(i); chosen = null; draw(); if (correct.size === a.pairs.length) say('全部配对完成。' + a.explanation, true); }
        }, right); b.disabled = correct.has(i);
      });
    } else {
      el('p', `步骤 ${step + 1} / ${a.items.length}`); el('h2', a.items[step]);
      button('上一步', () => { step = Math.max(0, step - 1); draw(); });
      button(step === a.items.length - 1 ? '完成演示' : '下一步', () => { if (step === a.items.length - 1) say(a.explanation, true); else { step++; draw(); } });
    }
  }
  function move(from, to) {
    if (!Number.isInteger(from) || to < 0 || to >= order.length || from === to) return;
    if (a.rule === 'bubble') {
      const lo = Math.min(from, to), hi = Math.max(from, to);
      if (hi - lo !== 1 || Number(order[lo]) <= Number(order[hi])) { say('只能交换相邻的逆序数字。' + a.explanation); return; }
      [order[lo], order[hi]] = [order[hi], order[lo]];
    } else { const [item] = order.splice(from, 1); order.splice(to, 0, item); }
    say('已移动；可以继续操作或检查答案。'); draw();
  }
  function reset() { step = 0; chosen = null; correct.clear(); order = shuffled(a.items || []); say(''); draw(); }
  document.getElementById('hint').onclick = () => say(a.hint);
  document.getElementById('reset').onclick = reset;
  reset();
  if (token) parent.postMessage({ type: 'activity-ready', token }, '*');
}
const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderActivity(content, { token = '', draft = true, version = '', source = '' } = {}) {
  const a = validateActivity(content);
  const data = JSON.stringify(a).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>${escapeHtml(a.title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f5f7fb;color:#172033;margin:0;padding:24px}main{max-width:820px;margin:auto}h1{font-size:28px}button{cursor:pointer;border:1px solid #cbd5e1;border-radius:10px;padding:12px 18px;background:white;color:#172033;margin:5px;font:inherit}button:hover,button[data-selected=true]{background:#eef2ff;border-color:#4f46e5}button:disabled{opacity:.45}.item{display:flex;align-items:center;gap:12px;border:1px solid #cbd5e1;border-radius:10px;background:white;padding:12px;margin:8px 0}.item span{flex:1}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.columns button{display:block;width:100%;margin:8px 0}#feedback{min-height:48px;background:#fff7ed;padding:16px;border-radius:12px;margin-top:20px}#feedback[data-ok=true]{background:#ecfdf5}.status{font-size:12px;color:#64748b}</style></head><body><main><p class="status">${draft ? '草稿 · 待确认' : '正式稿 · 已确认'}${source === 'sample' ? ' · 本地示例（含后续修改）' : ''} · 版本 ${escapeHtml(version)}</p><h1>${escapeHtml(a.title)}</h1><p>${escapeHtml(a.description)}</p><div id="activity"></div><div id="feedback" role="status"></div><button id="hint">操作提示</button><button id="reset">重置</button></main><script>(${activityRuntime.toString()})(${data},${JSON.stringify(token).replace(/</g, '\\u003c')});</script></body></html>`;
}
