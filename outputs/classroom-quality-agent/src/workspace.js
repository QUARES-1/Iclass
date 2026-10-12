import { AppError, id, clone } from './store.js';
import { slidesToExportModel,cleanSlideTitle,pageTitleFor } from './pptExport.js';
import { validateActivity } from './interactive.js';
import { MAX_MATERIALS,MAX_EXTRACTED_CHARACTERS,MAX_TOTAL_CHARACTERS } from './uploadPolicy.js';
import { validateCodeBlock, splitCodeSource } from './codeBlock.js';

export const emptyWorkspace = () => ({ revision: 0, requirements: { topic: '', audience: '', duration: 45, instructions: '' }, materials: [], analysis: null, analysisSource: null, analysisWarning:'', supplements: [], resources: [], selectedId: null, messages: [] });
export const currentVersion = resource => resource?.versions.find(v => v.id === resource.currentVersionId);
export function findResource(state, resourceId) {
  const r = state.resources.find(r => r.id === resourceId);
  if (!r) throw new AppError('请选择有效资源。', 404);
  return r;
}
const pageFields = ['section', 'title', 'bullets', 'notes', 'example', 'counterExample', 'code', 'layout', 'steps', 'metrics', 'comparisonRows', 'emphasis', 'visualType'];
export function validateSlides(slides, { paginate = false } = {}) {
  if (!Array.isArray(slides) || !slides.length) throw new AppError('PPT 至少需要一页。');
  const cleaned = slides.map(s => {
    if (!s || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 200) throw new AppError('页面标题无效。');
    if (s.id !== undefined && (typeof s.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(s.id))) throw new AppError('页面 ID 无效。');
    for (const field of ['bullets', 'notes']) if (!Array.isArray(s[field] || []) || (s[field] || []).length > 100 || !(s[field] || []).every(v => typeof v === 'string' && v.length < 10000)) throw new AppError('页面正文或备注格式无效。');
    const out = Object.fromEntries(pageFields.filter(k => s[k] !== undefined).map(k => [k, clone(s[k])]));
    if(out.code!==undefined){try{out.code=validateCodeBlock(out.code);if(out.code){splitCodeSource(out.code.source,20,out.code.language);out.code.blockId ||= id();}}catch(e){throw new AppError(e.message);}}
    if(out.layout==='code'&&!out.code)delete out.layout;
    if(s.paginationRootId!==undefined){if(typeof s.paginationRootId!=='string'||!/^[a-z0-9-]{1,80}$/i.test(s.paginationRootId))throw new AppError('分页来源无效。');out.paginationRootId=s.paginationRootId;}
    for (const field of ['example', 'counterExample']) if (out[field] !== undefined && (typeof out[field] !== 'string' || out[field].length > 10000)) throw new AppError('示例格式无效。');
    for (const field of ['steps','emphasis']) if (out[field] !== undefined && (!Array.isArray(out[field]) || out[field].length > 100 || !out[field].every(v => typeof v === 'string' && v.length < 10000))) throw new AppError('步骤或标签格式无效。');
    if (out.comparisonRows !== undefined && (!Array.isArray(out.comparisonRows) || out.comparisonRows.length > 100 || JSON.stringify(out.comparisonRows).length > 20000)) throw new AppError('比较表格格式无效。');
    if (out.metrics !== undefined && (!out.metrics || typeof out.metrics !== 'object' || JSON.stringify(out.metrics).length > 10000)) throw new AppError('页面指标格式无效。');
    if (!['导入', '讲解', '案例', '互动', '总结'].includes(out.section)) out.section = '讲解';
    return { ...out, id: s.id || id(), bullets: out.bullets || [], notes: out.notes || [], status: 'pending', ...(s.attachment ? { attachment: clone(s.attachment) } : {}) };
  });
  const result = paginate ? cleaned.flatMap(s => slidesToExportModel([s]).map((p, i) => ({ ...p, paginationRootId:s.paginationRootId||s.id,id: i ? id() : s.id, status: 'pending' }))) : cleaned;
  if (new Set(result.map(s => s.id)).size !== result.length) throw new AppError('页面 ID 重复。');
  return result;
}
const fingerprint = page => JSON.stringify(Object.fromEntries(Object.entries(page).filter(([k]) => !['status', 'id', 'paginationRootId'].includes(k))));
export function reflowCodePages(content, blockIds = null) {
  const groups=new Map();
  for(const page of content.slides.filter(s=>s.code?.blockId&&s.code.kind!=='output'&&(!blockIds||blockIds.has(s.code.blockId)))){
    if(!groups.has(page.code.blockId))groups.set(page.code.blockId,[]);groups.get(page.code.blockId).push(page);
  }
  const replacements=new Map(),removed=new Set();let changed=0;
  for(const pages of groups.values()){
    const head=pages[0],source=pages.map(p=>p.code.source).join(''),parts=splitCodeSource(source,20,head.code.language);
    if(parts.length===pages.length&&parts.every((part,i)=>part===pages[i].code.source))continue;
    const notes=[...new Set(pages.flatMap(p=>p.notes||[]))],baseTitle=cleanSlideTitle(head.title);
    const updated=parts.map((source,i)=>{
      const page={...clone(pages[i]||head),id:pages[i]?.id||id(),paginationRootId:head.paginationRootId||head.id,notes:i?(pages[i]?.notes||[]):notes,status:'pending',code:{language:head.code.language,blockId:head.code.blockId,source,part:i+1,parts:parts.length}};
      page.title=pageTitleFor(baseTitle,page,i);return page;
    });
    // Keep associated interactive content on an ordinary page if pagination
    // retires its old physical code page. Teacher notes are retained above.
    for(const page of pages.slice(parts.length).filter(p=>p.attachment)){
      const retained=clone(page);delete retained.code;delete retained.layout;retained.status='pending';updated.push(retained);
    }
    validateSlides(updated);replacements.set(head.id,updated);pages.slice(1).forEach(p=>removed.add(p.id));changed++;
  }
  content.slides=content.slides.flatMap(page=>replacements.get(page.id)||(removed.has(page.id)?[]:[page]));
  return changed;
}
function paginateChangedSlides(content, changedIds, replacedCode = new Set()) {
  let added = 0;
  // A replacement program replaces its generated code/output pages. Retain
  // unrelated lecture pages and edits to individual code fragments.
  content.slides=content.slides.filter(s=>!(s.code&&s.id!==s.paginationRootId&&replacedCode.has(s.paginationRootId)));
  const codeGroups=new Set(content.slides.filter(s=>changedIds.has(s.id)&&s.code?.blockId).map(s=>s.code.blockId));
  content.slides = content.slides.flatMap(slide => {
    if (!changedIds.has(slide.id)) return [slide];
    const [valid] = validateSlides([slide]), pages = slidesToExportModel([valid]);
    added += pages.length - 1;
    return pages.map((page, index) => {
      const result = { ...page, paginationRootId:slide.paginationRootId||slide.id,id: index ? id() : slide.id, status:valid.status };
      if (index) delete result.attachment;
      return result;
    });
  });
  reflowCodePages(content,codeGroups);
  return added;
}
export function commitResource(resource, content, summary, source = 'teacher', reset = false) {
  const previous = currentVersion(resource);
  if (resource.type === 'ppt') {
    content = { slides: validateSlides(content.slides) };
    content.slides = content.slides.map(s => {
      const old = previous?.content.slides.find(p => p.id === s.id);
      return { ...s, status: !reset && old && fingerprint(old) === fingerprint(s) ? old.status : 'pending' };
    });
  } else content = validateActivity(content);
  if (!reset && previous && JSON.stringify(previous.content) === JSON.stringify(content)) {
    if (source === 'llm') {
      const error = new AppError('AI 候选与当前内容一致，未形成实际修改，请补充具体要求后重试。');
      error.code = 'RESOURCE_UNCHANGED'; throw error;
    }
    return previous;
  }
  const version = { id: id(), parentId: previous?.id || null, content, summary, source, createdAt: new Date().toISOString(), confirmed: false };
  resource.versions.push(version); resource.currentVersionId = version.id;
  if (resource.type !== 'ppt') resource.name = content.title;
  return version;
}
export function createResource(state, type, name, content, source = 'llm') {
  if (!['ppt', 'game', 'web'].includes(type)) throw new AppError('资源类型无效。');
  if (state.resources.length >= 60) throw new AppError('资源数量超过 60，请先删除不再使用的资源。');
  const r = { id: id(), type, origin: source, name: String(name || '未命名资源').slice(0, 200), versions: [], currentVersionId: null };
  if (type === 'ppt') content = { slides: validateSlides(content.slides, { paginate: true }) };
  commitResource(r, content, '创建资源', source);
  state.resources.push(r); state.selectedId = r.id;
  return r;
}
export function applyWorkspaceCommand(state, cmd) {
  const { action } = cmd;
  if (action === 'settings') {
    const q = cmd.requirements;
    if (!q || typeof q.topic !== 'string' || typeof q.audience !== 'string' || typeof q.instructions !== 'string' || q.topic.length > 500 || q.instructions.length > 8000 || q.audience.length > 500 || !Number.isFinite(Number(q.duration)) || Number(q.duration) <= 0) throw new AppError('教学要求格式无效。');
    state.requirements = { topic: q.topic, audience: q.audience, duration: Number(q.duration), instructions: q.instructions };
  } else if (action === 'material') {
    const m = cmd.material;
    if (!m || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 255 || typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_EXTRACTED_CHARACTERS || state.materials.length >= MAX_MATERIALS || String(m.type||'文本').length>100) throw new AppError('资料为空、超过 250000 字符或数量超过 20 条，请精简后重试。');
    if(state.materials.reduce((n,m)=>n+m.content.length,0)+m.content.length>MAX_TOTAL_CHARACTERS)throw new AppError('资料正文合计超过 500000 字符，请先移除或精简资料。');
    if(m.truncated && (!Number.isSafeInteger(m.originalCharacters)||m.originalCharacters<=m.content.length))throw new AppError('资料截取信息无效。');
    state.materials.push({ id: id(), title: m.title, type: String(m.type || '文本'), content: m.content, source: m.source === 'sample' ? 'sample' : 'teacher', status: 'parsed', ...(m.truncated?{truncated:true,originalCharacters:m.originalCharacters}:{}) });
    state.analysis = null; state.analysisSource = null; state.analysisWarning='';state.supplements = [];
  } else if (action === 'removeMaterial') {
    state.materials = state.materials.filter(m => m.id !== cmd.materialId); state.analysis = null; state.analysisSource = null; state.analysisWarning='';state.supplements = [];
  } else if (action === 'materialFailure') {
    if (typeof cmd.title !== 'string' || cmd.title.length > 255 || typeof cmd.error !== 'string' || cmd.error.length > 2000 || state.materials.length >= 20) throw new AppError('文件错误记录无效。');
    state.materials.push({ id: id(), title: cmd.title, type: '文件', content: '', status: 'failed', error: cmd.error });
  } else if (action === 'context') {
    if (cmd.analysis !== null && (!cmd.analysis || !['chapters','objectives','knowledgePoints','keyPoints','difficultPoints'].every(k => Array.isArray(cmd.analysis[k]) && cmd.analysis[k].every(x => typeof x === 'string' && x.length < 6000)))) throw new AppError('知识点格式无效。');
    if (cmd.source !== undefined && !['llm','local','teacher'].includes(cmd.source)) throw new AppError('理解来源无效。');
    if(cmd.warning!==undefined && (typeof cmd.warning!=='string' || cmd.warning.length>2000))throw new AppError('理解说明格式无效。');
    state.analysisWarning=cmd.analysis===null?'':cmd.warning??state.analysisWarning??'';
    state.analysisSource = cmd.analysis === null ? null : cmd.source || (JSON.stringify(state.analysis) !== JSON.stringify(cmd.analysis) ? 'teacher' : state.analysisSource || null);
    state.analysis = cmd.analysis;
    if (!Array.isArray(cmd.supplements) || cmd.supplements.length > 100) throw new AppError('补充内容格式无效。');
    state.supplements = cmd.supplements;
  } else if (action === 'clearConversation') {
    if (state.messages.some(m => m.status === 'processing')) throw new AppError('请先暂停正在执行的任务，再清空上下文。', 409);
    state.messages = [];
  } else if (action === 'clear') return emptyWorkspace();
  else if (action === 'select') { findResource(state, cmd.resourceId); state.selectedId = cmd.resourceId; }
  else if (action === 'delete') {
    state.resources = state.resources.filter(r => r.id !== cmd.resourceId);
    if (state.selectedId === cmd.resourceId) state.selectedId = state.resources[0]?.id || null;
  } else {
    const r = findResource(state, cmd.resourceId), v = currentVersion(r);
    if (cmd.baseVersionId !== v.id) throw new AppError('资源版本已改变，请刷新后重试。', 409);
    if(action==='reflowCode'){
      if(r.type!=='ppt')throw new AppError('当前资源不是 PPT。');
      const content=clone(v.content),changed=reflowCodePages(content);
      if(changed)commitResource(r,content,'教师整理代码分页：'+changed+' 份程序按完整函数与代码部分重新排页');
    } else if (action === 'editSlideTitles') {
      if(r.type!=='ppt')throw new AppError('当前资源不是 PPT。');
      if(!Array.isArray(cmd.titles)||!cmd.titles.length||cmd.titles.length>v.content.slides.length)throw new AppError('页面标题列表无效。');
      const content=clone(v.content),seen=new Set();
      for(const entry of cmd.titles){
        if(!entry||typeof entry.slideId!=='string'||seen.has(entry.slideId)||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>200)throw new AppError('页面标题或目标无效。');
        const page=content.slides.find(s=>s.id===entry.slideId);if(!page)throw new AppError('页面已不存在。');
        seen.add(entry.slideId);page.title=entry.title.trim();
      }
      if(cmd.removeDuplicateIds!==undefined){
        if(!Array.isArray(cmd.removeDuplicateIds)||new Set(cmd.removeDuplicateIds).size!==cmd.removeDuplicateIds.length)throw new AppError('重复页面列表无效。');
        const removed=new Set(cmd.removeDuplicateIds);
        const equivalent=page=>JSON.stringify(Object.fromEntries(Object.entries(page).filter(([key])=>!['title','id','status'].includes(key)).map(([key,value])=>[key,key==='bullets'?value.join(''):value]).sort(([a],[b])=>a.localeCompare(b))));
        for(const pid of removed){
          const page=content.slides.find(s=>s.id===pid);
          if(!page||page.code||page.attachment||!page.bullets.length||!content.slides.some(s=>!removed.has(s.id)&&equivalent(s)===equivalent(page)))throw new AppError('只能合并同一主题中正文和备注完全重复、且不含代码或互动的页面。');
        }
        content.slides=content.slides.filter(s=>!removed.has(s.id));
      }
      commitResource(r,content,'教师整理页面标题：'+cmd.titles.length+' 页');
    } else if (action === 'editSlide') {
      if (r.type !== 'ppt') throw new AppError('当前资源不是 PPT。');
      const c = clone(v.content), slide = c.slides.find(s => s.id === cmd.slideId);
      if (!slide) throw new AppError('页面已不存在。');
      if (!cmd.patch || typeof cmd.patch !== 'object') throw new AppError('页面修改格式无效。');
      for (const k of pageFields) if (cmd.patch[k] !== undefined) slide[k] = cmd.patch[k];
      const replacement=Object.hasOwn(cmd.patch,'code')&&(!slide.paginationRootId||slide.paginationRootId===slide.id)&&(!v.content.slides.find(s=>s.id===slide.id)?.code||cmd.patch.code?.replaceBlock===true)?new Set([slide.id]):new Set();
      const added = paginateChangedSlides(c, new Set([slide.id]),replacement);
      commitResource(r, c, '教师编辑页面：' + slide.title + (added ? `；自动分页新增 ${added} 页` : ''));
    } else if (action === 'addSlide' || action === 'deleteSlide') {
      if (r.type !== 'ppt') throw new AppError('当前资源不是 PPT。');
      const c = clone(v.content);
      if (action === 'addSlide') c.slides.push({ id: id(), section: '讲解', title: '新页面', bullets: [], notes: [], status: 'pending' });
      else c.slides = c.slides.filter(s => s.id !== cmd.slideId);
      commitResource(r, c, action === 'addSlide' ? '新增页面' : '删除页面');
    } else if (action === 'editActivity') {
      if (r.type === 'ppt') throw new AppError('请选择互动资源。');
      commitResource(r, { ...v.content, title: cmd.title, description: cmd.description }, '教师编辑基本信息');
    } else if (action === 'rename') {
      if (typeof cmd.name !== 'string' || !cmd.name.trim() || cmd.name.length > 200) throw new AppError('名称无效。');
      if (r.type === 'ppt') r.name = cmd.name;
      else commitResource(r, { ...v.content, title: cmd.name }, '重命名互动资源');
    } else if (action === 'restore' || action === 'undo') {
      const target = r.versions.find(x => x.id === (action === 'undo' ? v.parentId : cmd.versionId));
      if (!target) throw new AppError('没有可恢复版本。');
      commitResource(r, clone(target.content), '恢复版本 ' + target.id, 'restore', true);
    } else if (action === 'confirm') {
      if (r.type === 'ppt') {
        if (cmd.slideId && !v.content.slides.some(s => s.id === cmd.slideId)) throw new AppError('页面不存在。');
        v.content.slides.forEach(s => { if (!cmd.slideId || s.id === cmd.slideId) s.status = 'confirmed'; });
      } else v.confirmed = true;
    } else if (action === 'attach') {
      if (r.type !== 'ppt') throw new AppError('选择 PPT 后再关联互动。');
      const other = findResource(state, cmd.activityId);
      if (other.type === 'ppt') throw new AppError('仅支持关联互动资源。');
      const ov = currentVersion(other), c = clone(v.content), slide = c.slides.find(s => s.id === cmd.slideId);
      if (!slide) throw new AppError('页面不存在。');
      slide.attachment = { resourceId: other.id, versionId: ov.id, fileName: `activity-${other.id}-${ov.id}.html`, title: ov.content.title, content: clone(ov.content), confirmed: ov.confirmed, source: other.origin || ov.source };
      slide.example = `互动示意：${ov.content.mode} · ${(ov.content.questions?.[0]?.prompt || ov.content.items?.join(' → ') || ov.content.pairs?.map(p => p.left).join(' / ') || '').slice(0, 350)}`;
      slide.notes = [...slide.notes, `操作说明：${ov.content.description}`, `配套文件 ${slide.attachment.fileName} 与课件保存在同一文件夹，可用浏览器直接打开。`];
      commitResource(r, c, '关联互动 ' + other.name + '（固定版本）');
    } else throw new AppError('未知工作台操作。', 400);
  }
  return state;
}

// Only field patches are allowed on existing pages. An AI response cannot replace
// untouched pages or silently erase teacher edits by returning a whole old deck.
export function applyPptOperations(resource, operations, scopeIds = null) {
  if (!Array.isArray(operations) || !operations.length) throw new AppError('AI 没有返回有效页面修改。');
  const content = clone(currentVersion(resource).content);
  const changed = [], changedIds = new Set(), insertionTail = new Map(), replacedCode=new Set();
  for (const op of operations) {
    if (!op || typeof op !== 'object') throw new AppError('AI 操作格式无效。');
    if (scopeIds && (!scopeIds.includes(op.slideId) || op.action === 'add')) throw new AppError('AI 修改超出了指定页面范围；原资源已保留。');
    if (op.action === 'add') {
      const [s] = validateSlides([op.slide]); s.id = id();
      if (op.afterSlideId !== undefined) {
        const anchor = insertionTail.get(op.afterSlideId) || op.afterSlideId, index = content.slides.findIndex(p => p.id === anchor);
        if (index < 0) throw new AppError('AI 指定的插入位置不存在；原资源已保留。');
        content.slides.splice(index + 1, 0, s); insertionTail.set(op.afterSlideId, s.id);
      } else content.slides.push(s);
      changedIds.add(s.id); changed.push('新增：' + s.title);
    } else {
      const slide = content.slides.find(s => s.id === op.slideId);
      if (!slide) throw new AppError('AI 引用了不存在的页面；原资源已保留。');
      if (op.action === 'delete') { content.slides = content.slides.filter(s => s.id !== op.slideId); changed.push('删除：' + slide.title); }
      else if (op.action === 'update' && op.patch && Object.keys(op.patch).length) {
        if(op.patch.code?.replaceBlock===true&&slide.code?.blockId){
          const group=content.slides.filter(s=>s.code?.blockId===slide.code.blockId);
          if(scopeIds&&group.some(s=>!scopeIds.includes(s.id)))throw new AppError('替换完整代码会涉及其续页，请选择整份资源范围。');
          if(group.find(s=>s.code.kind!=='output')?.id!==slide.id)throw new AppError('替换完整代码请更新该程序的第一段。');
          content.slides=content.slides.filter(s=>s.id===slide.id||s.code?.blockId!==slide.code.blockId);
          slide.code={language:slide.code.language,blockId:slide.code.blockId};
        }
        if(Object.hasOwn(op.patch,'code')&&(!slide.paginationRootId||slide.paginationRootId===slide.id)&&(!slide.code||op.patch.code?.replaceBlock===true)){
          if(scopeIds&&op.patch.code?.replaceBlock===true)throw new AppError('替换完整代码会涉及其续页，请选择整份资源范围。');
          replacedCode.add(slide.id);
        }
        for (const key of Object.keys(op.patch)) {
          if (!pageFields.includes(key)) throw new AppError(`AI 页面字段 ${key} 无效。允许字段：${pageFields.join('、')}；源码和预期输出放在code.source、code.expectedOutput内。`);
          slide[key] = key==='code'&&op.patch.code ? {...slide.code,...clone(op.patch.code)} : clone(op.patch[key]);
        }
        changed.push('修改：' + slide.title + '（' + Object.keys(op.patch).join('、') + '）');
        changedIds.add(slide.id);
      } else throw new AppError('AI 操作格式无效。');
    }
  }
  // Split changed pages before saving so preview, stable IDs and export agree.
  const added = paginateChangedSlides(content, changedIds,replacedCode);
  if (added) changed.push(`自动分页新增 ${added} 页，当前共 ${content.slides.length} 页`);
  return { content, summary: changed.join('；') };
}
