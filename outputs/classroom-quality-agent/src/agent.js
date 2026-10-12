import { AppError, clone, id } from './store.js';
import { currentVersion, createResource, applyPptOperations, commitResource, applyWorkspaceCommand } from './workspace.js';
import { validateActivity } from './interactive.js';
import { requestJSON } from './model.js';
import { DEFAULT_PROMPTS, CHAT_CONTRACT } from './prompts.js';
import { splitCodeSource } from './codeBlock.js';
import { createHash } from 'node:crypto';
import { READ_TOOLS, CONVERSATION_CONTRACT, workspaceSummary, readConversationTool, directOperationPlan, fitConversationContext } from './conversation.js';

export const AGENT_TOOLS = ['ppt.create', 'ppt.update', 'activity.create', 'activity.update', 'resource.attach', 'advice'];
const FUNCTIONAL_REVIEW_POLICY = '本次先验收功能：检查教师要求的核心内容、源码、必要依赖与调用说明是否齐全，资源结构、操作范围、分页衔接及既有内容保护是否正确。算法正确性、复杂度、边界行为和预期运行输出的代码疑点，只有 codeChecks/codeRuns 中存在直接支持的独立失败证据时才安排强制修正；未运行的模型推演只能放 suggestions，不能据此判失败、改写算法或反复扩写。没有独立证据时不得声称代码已运行或算法已验证。普通正文中可直接核实的矛盾仍应修正。';
const PLAN_SCHEMA = '返回 JSON {action:"plan",reply:"简要计划",goal:"教学目标",steps:[{id:"唯一短ID",title:"步骤名称",tool:"ppt.create|ppt.update|activity.create|activity.update|resource.attach|advice",resourceId:"现有ID、current或step:先前创建步骤ID",targetIds:["要修改的原页ID"],instructions:"本步骤具体要求",focus:"concept|implementation|demonstration|exercise",needsCode:true|false,topics:["知识主题"],sourceIds:["资料索引ID"],minutes:本步骤课时, pages:预计生成或修改页面数}]}。实现代码步骤标needsCode:true，概念讲解与代码实现分成不同步骤，少量验证即可，不默认安排大量练习和答案页。新建PPT的第一个步骤用ppt.create，后续章节用ppt.update并resourceId=current；每个ppt.create创建一份新资源。需引用尚未生成的资源时用resourceId=step:创建步骤ID；关联互动时resourceId必须指向PPT。当前已有PPT时默认使用ppt.update。歧义返回 {action:"clarify",reply}，仅建议可返回 {action:"advice",reply}。';
const REVIEW_SCHEMA = '检查已执行成果，返回 JSON {action:"review",passed:true|false,reply:"简洁检查结论",issues:["已核实且必须修正的具体缺陷"],suggestions:["不阻止完成的可选改进"],repairSteps:[与计划steps同结构的修正步骤]}。必须修正的缺陷包括知识、计算、答案错误，缺少教师明确要求的核心内容，或实操缺少必要输入、步骤、结果而无法执行。先独立核算并核对相邻页，确认错误才列入issues；reply只写最终结论，不输出猜测或已排除的疑点。章节标签、标题组织、排版、可选补充例子以及不同但各自正确的练习属于suggestions，不因这些偏好判失败。passed 为 false 时必须给出能修正缺陷的 repairSteps，不能只让教师重试。passed 为 true 时issues和repairSteps为空，可保留suggestions。targetIds 表示必须修改的错误原页，pages至少等于目标数。纯新增内容用空targetIds，可用afterSlideId指定插入位置。对同一演算的所有错误续页统一修正，不能新增正确页却保留原错误。可以删除本任务新生成的重复页，但保留教师原有页面。已满足目标时不要无限扩写。同一页和同一个代码块可以包含多个完整函数，这符合教师的分页要求；函数闭括号后紧接下一函数定义本身不构成错误。代码分段应按blockId拼接后检查完整程序，不能因单个展示页无法独立编译而要求重复源码或拆散完整函数。仅有同页多个函数的排版偏好应列为suggestions，不能据此判失败。';
const cannotRetry=e=>[413,503,429].includes(e.statusCode) || ['MODEL_HTTP_401','MODEL_HTTP_403','MODEL_HTTP_429'].includes(e.code);

export function scopeFor(state, request, resourceId, pageId) {
  const r = state.resources.find(r => r.id === resourceId);
  if (r?.type !== 'ppt') return null;
  const slides=currentVersion(r).content.slides, numbers=new Set();
  const valid=n=>{if(!Number.isSafeInteger(n)||n<1||n>slides.length)throw new AppError('指定页码不存在，请选择有效页面。');return n;};
  const remaining=request.replace(/第\s*(\d+)\s*(?:页\s*)?(?:到|至|[-—~～])\s*(?:第\s*)?(\d+)\s*页/g,(_,a,b)=>{
    const start=valid(Number(a)),end=valid(Number(b));if(end<start)throw new AppError('页面范围顺序无效。');
    for(let n=start;n<=end;n++)numbers.add(n);return '';
  });
  for(const match of remaining.matchAll(/第\s*(\d+(?:\s*[、,，和及]\s*(?:第\s*)?\d+)*)\s*页/g))for(const n of match[1].matchAll(/\d+/g))numbers.add(valid(Number(n[0])));
  if(numbers.size)return [...numbers].sort((a,b)=>a-b).map(n=>slides[n-1].id);
  if(pageId&&!slides.some(s=>s.id===pageId))throw new AppError('指定页码不存在，请选择有效页面。');
  return pageId?[pageId]:null;
}
export function compactWorkspace(state) {
  return { ...clone(state), resources: state.resources.map(r => ({ ...clone(r), versions: [clone(currentVersion(r))] })) };
}
export function materialIndex(materials) {
  const chunks = [];
  for (const m of materials.filter(m => m.status === 'parsed')) {
    const lines = m.content.split(/(?<=\n)/), maxSize = 5000;
    let text = '', heading = m.title, offset = 0, start = 0;
    const flush = () => { if (text.trim()) chunks.push({ id: m.id + ':' + start, materialId: m.id, title: m.title, heading, start, end: start + text.length, text }); text = ''; start = offset; };
    for (const line of lines) {
      const h = line.match(/^\s*#{1,5}\s+(.+)/);
      if (h && text.length > 300) flush();
      if (h) heading = h[1].trim().slice(0,200);
      if (text.length + line.length > maxSize && text) flush();
      // A long paragraph is split with exact offsets; no body text is discarded.
      for (let i = 0; i < line.length; i += maxSize) {
        const part = line.slice(i, i + maxSize); if (text.length + part.length > maxSize && text) flush();
        text += part; offset += part.length;
      }
    }
    flush();
  }
  return chunks;
}
function inventory(state) {
  return state.resources.map(r => ({ id: r.id, type: r.type, name: r.name, versionId: r.currentVersionId,
    pages: r.type === 'ppt' ? currentVersion(r).content.slides.map(s => ({ id: s.id, title: s.title })) : undefined }));
}
function toolState(job) {
  const state = clone(job.input);
  for (const resource of job.drafts || []) { const i = state.resources.findIndex(r => r.id === resource.id); if (i < 0) state.resources.push(clone(resource)); else state.resources[i] = clone(resource); }
  state.selectedId = job.workingId || job.resourceId || state.selectedId;
  return state;
}
function recordDraft(job, resource) {
  const refs = new Set(job.drafts.flatMap(r => currentVersion(r).content.slides?.flatMap(s => s.attachment ? [s.attachment.versionId] : []) || []));
  const compact = { ...clone(resource), versions: resource.versions.filter(v => v.id === resource.currentVersionId || refs.has(v.id)).map(clone) }, index = job.drafts.findIndex(r => r.id === resource.id);
  if (index < 0) job.drafts.push(compact); else job.drafts[index] = compact;
}
const sourcePages=slides=>slides.filter(s=>s.code?.source?.trim()&&s.code.kind!=='output');
function updateCodePages(before,after,operations,scope){
  const originalIds=new Set(before.map(s=>s.id)),affected=new Set([...scope,...operations.map(op=>op.slideId)]);
  const blocks=new Set([...before,...after].filter(s=>(affected.has(s.id)||affected.has(s.paginationRootId))&&s.code?.blockId).map(s=>s.code.blockId));
  return sourcePages(after).filter(s=>affected.has(s.id)||!originalIds.has(s.id)||blocks.has(s.code.blockId)).length;
}
function requiredRepairTargets(task,slides){
  if(Array.isArray(task.requiredTargetIds))return task.requiredTargetIds.filter(id=>task.targetIds.includes(id));
  // Old checkpoints expanded an output-only repair to include its unchanged
  // program. Recover the actual output target without demanding a source rewrite.
  const outputs=slides.filter(s=>task.targetIds.includes(s.id)&&s.code?.kind==='output').map(s=>s.id);
  const instructions=task.instructions||'';
  const sourceRewrite=/(?:修改|修正|重写|删除|移除|替换|清理|新增|补充).{0,12}(?:代码|源码|函数|定义)|(?:代码|源码|函数|定义).{0,12}(?:修改|修正|重写|删除|移除|替换|清理)/.test(instructions);
  return task.focus==='demonstration'&&outputs.length&&/预期输出|输出块|输出由|输出为/.test(instructions)&&!sourceRewrite?outputs:task.targetIds;
}
function selectedSources(index, task, availableChars) {
  const terms = [...(task.topics || []), task.title].filter(Boolean).flatMap(t => [t, ...t.split(/[\s、，,:：/]+/)]).filter(t => t.length > 1);
  const explicit = new Set(task.sourceIds || []);
  const ranked = index.map(c => ({ c, score: (explicit.has(c.id) ? 1000 : 0) + terms.reduce((n, t) => n + (c.heading.includes(t) ? 20 : 0) + (c.text.includes(t) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const chosen = []; let size = 0;
  for (const { c, score } of ranked) {
    if (score <= 0 && chosen.length) continue;
    const bytes = JSON.stringify(c).length;
    if (size + bytes > availableChars) continue;
    chosen.push(c); size += bytes;
    if (chosen.length >= 8) break;
  }
  return chosen;
}
function validatePlan(raw, job, config, index, repair = false, checkBudget = true) {
  if (!raw || raw.action !== 'plan' || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > (config.maxPlanSteps ?? 60)) throw new AppError('计划格式或步骤数量不符合运行额度。');
  const sourceIds = new Set(index.map(c => c.id)), state = toolState(job), stepIds = new Set(), targets = new Map();
  let plannedCurrent=state.selectedId;
  const steps = raw.steps.map((s, i) => {
    if (!s || !AGENT_TOOLS.includes(s.tool) || typeof s.title !== 'string' || !s.title.trim() || typeof s.instructions !== 'string' || !s.instructions.trim()) throw new AppError('计划缺少明确工具和执行要求。');
    const step = { ...s, id: String(s.id || 'step-' + (i + 1)), pages: s.tool.startsWith('ppt.') ? Math.max(Number(s.pages || 1),Array.isArray(s.targetIds)?s.targetIds.length:0) : 1, minutes: Number(s.minutes || 0), targetIds: s.targetIds || [], sourceIds: s.sourceIds || [], topics: s.topics || [] };
    if(s.needsCode!==undefined&&typeof s.needsCode!=='boolean')throw new AppError('计划的代码要求须为布尔值。');
    if(s.focus!==undefined&&!['concept','implementation','demonstration','exercise'].includes(s.focus))throw new AppError('计划教学重点格式无效。');
    step.needsCode=step.tool.startsWith('ppt.')&&(s.needsCode===true||s.focus==='implementation'||/示例代码|实现代码|核心代码|完整代码|代码实现|可运行代码|代码示例/.test(s.instructions));
    if (stepIds.has(step.id) || !Number.isInteger(step.pages) || step.pages < 1 || step.pages > (config.maxAgentCalls ?? 120) * (config.batchPages ?? 3) || !Number.isFinite(step.minutes) || step.minutes < 0) throw new AppError('计划步骤 ID、页数或课时无效。');
    stepIds.add(step.id);
    if (!Array.isArray(step.sourceIds) || step.sourceIds.some(sid => !sourceIds.has(sid)) || !Array.isArray(step.targetIds) || !Array.isArray(step.topics)) throw new AppError('计划引用了不存在的资料或页面。');
    const reference=typeof step.resourceId==='string' && step.resourceId.startsWith('step:')?step.resourceId.slice(5):null;
    if(reference && !targets.has(reference) && !job.created[reference])throw new AppError(`计划引用的资源步骤 ${reference} 尚不存在或顺序错误。step:后必须是先前步骤ID；当前已有资源可直接使用 ${job.resourceId||state.selectedId||'current'}。`);
    const targetRef=reference?(job.created[reference]||targets.get(reference)):(step.resourceId&&step.resourceId!=='current'?step.resourceId:plannedCurrent);
    const target=state.resources.find(r=>r.id===targetRef),future=typeof targetRef==='string'&&targetRef.startsWith('step:');
    if(targetRef&&!future&&!target)throw new AppError('计划目标资源不存在。');
    if(!step.tool.endsWith('.create'))step.resourceId=targetRef||'current';
    const writesSelectedPpt=['ppt.update','resource.attach'].includes(step.tool);
    if(job.scopeIds && writesSelectedPpt && step.resourceId && step.resourceId!=='current' && step.resourceId!==(job.scopeResourceId||job.resourceId))throw new AppError('计划超出教师指定资源。');
    if(step.tool.endsWith('.create')){plannedCurrent='step:'+step.id;targets.set(step.id,plannedCurrent);}
    else if(step.tool!=='advice'&&targetRef){targets.set(step.id,targetRef);plannedCurrent=targetRef;}
    if (step.targetIds.some(pid => !currentVersion(target)?.content.slides?.some(p => p.id === pid))) throw new AppError('计划引用了不存在的目标页面。');
    if(step.afterSlideId && !currentVersion(target)?.content.slides?.some(p=>p.id===step.afterSlideId))throw new AppError('计划新增位置不存在。');
    if (job.scopeIds && writesSelectedPpt && step.targetIds.some(pid => !job.scopeIds.includes(pid))) throw new AppError('计划超出教师指定页面的修改范围。');
    if(job.scopeIds && step.tool==='resource.attach' && !step.targetIds.length)throw new AppError('关联步骤须指定教师要求的目标页面。');
    if (step.tool === 'ppt.create' && job.resourceId && state.resources.find(r => r.id === job.resourceId)?.type === 'ppt' && !/新建|另建|创建/.test(job.request)) throw new AppError('扩写请求不能新建替代课件。');
    if (job.scopeIds && step.tool==='ppt.update') { if(!step.targetIds.length)step.targetIds=[...job.scopeIds];step.pages=Math.max(step.pages,step.targetIds.length); }
    return step;
  });
  if(!repair && /示例代码|实现代码|代码实现|可运行代码|代码示例/.test(job.request) && steps.some(s=>s.tool.startsWith('ppt.')) && !steps.some(s=>s.needsCode))throw new AppError('教师要求示例代码，计划必须安排真实代码实现步骤，不能用例题或伪代码替代。');
  if(raw.courseMode!==undefined&&!['full','partial'].includes(raw.courseMode))throw new AppError('课程范围须为 full 或 partial。');
  const fullCourse = !repair && !job.scopeIds && (raw.courseMode==='full' || steps.some(s=>s.tool==='ppt.create') && /课件|PPT|课程|完整/i.test(job.request));
  if (fullCourse) {
    const minutes = steps.reduce((n, s) => n + s.minutes, 0), expected = job.input.requirements.duration;
    if (Math.abs(minutes - expected) > Math.max(5, expected * 0.1)) throw new AppError(`计划分配了 ${minutes} 分钟，当前教学要求为 ${expected} 分钟；请重新安排完整课时。`);
  }
  if (checkBudget && steps.reduce((n, s) => n + Math.ceil(s.pages / (config.batchPages ?? 3)), 0) + 2 > (config.maxAgentCalls ?? 120) - job.calls) throw new AppError('计划预计调用次数超过当前运行额度，请优化批次与计划。');
  return { goal: String(raw.goal || job.request), reply: String(raw.reply || '按教学主题分步完成。'), fullCourse, steps };
}
function tasksFor(steps, config, round = 0) {
  return steps.flatMap(step => {
    const size = config.batchPages ?? 3, count = Math.ceil(step.pages / size);
    return Array.from({ length: count }, (_, part) => ({ ...step, ...(step.requiredTargetIds?{requiredTargetIds:step.requiredTargetIds.filter(id=>step.targetIds.slice(part*size,(part+1)*size).includes(id))}:{}),taskId: `${round}:${step.id}:${part}`, part: part + 1, parts: count,
      pageStart: part * size + 1, pageCount: Math.min(size, step.pages - part * size), targetIds: step.targetIds.slice(part * size, (part + 1) * size), attempts: 0 }));
  });
}
function paused(signal) { if (signal?.aborted) { const e = new AppError('任务已暂停，已完成的草稿保留。', 499); e.code = 'AGENT_PAUSED'; throw e; } }

export function newAgentJob(input, request, resourceId, pageId) {
  let scopeIds = null;
  // A quoted or nonexistent page in a question must not reject the conversation.
  // Actual writes validate the requested scope again after the model chooses them.
  try { scopeIds = scopeFor(input, request, resourceId, pageId); } catch {}
  return { id: id(), revision: 0, stage: 'queued', mode: 'conversation', request, resourceId: resourceId || null, pageId: pageId || null, scopeIds, input: compactWorkspace(input),
    plan: null, tasks: [], cursor: 0, calls: 0, repairRound: 0, drafts: [], observations: [], anchors: {}, created: {}, workingId: resourceId || input.selectedId, createdAt: new Date().toISOString() };
}
export function publicAgentJob(job) {
  const { input, drafts, tasks, directCandidate, pendingCandidate, pendingCandidates, toolResults, stepPages, codePagingVersion, codeChecks, auditEvidence, ...visible } = job;
  return { ...visible, ...(job.execution === 'direct' ? {plan:null} : {}), completedBatches: job.cursor, totalBatches: tasks?.length || 0,
    draftPages: (drafts || []).filter(r => r.type === 'ppt').reduce((n, r) => n + currentVersion(r).content.slides.length, 0),
    draftResources: (drafts || []).map(r => ({ id: r.id, type: r.type, name: r.name, pages: currentVersion(r).content.slides?.length })),
    observations: (job.observations || []).slice(-12) };
}

// Models choose the plan and tools; every tool result or failure feeds subsequent
// execution and review. Checkpoints contain data, never API credentials.
export async function runTeachingAgent(job, { config = {}, call = requestJSON, runtimeCheck = async () => {}, codeCheck = async()=>({status:'not_checked'}), checkpoint = async () => {}, readContext, claimTask = async () => {}, signal } = {}) {
  const codeGroups=resource=>{
    const groups=new Map();if(resource?.type!=='ppt')return groups;
    for(const page of currentVersion(resource).content.slides.filter(s=>s.code&&s.code.kind!=='output')){
      const key=page.code.blockId||page.id;if(!groups.has(key))groups.set(key,{blockId:key,language:page.code.language,source:'',pageIds:[],title:page.title});
      const group=groups.get(key);group.source+=page.code.source;group.pageIds.push(page.id);
    }
    for(const group of groups.values())group.hash=createHash('sha256').update(group.language+'\n'+group.source).digest('hex');
    return groups;
  };
  const checkGroups=async groups=>{
    job.codeChecks||={};const results=[];
    for(const group of groups){
      let checked=job.codeChecks[group.hash];if(!checked){paused(signal);checked=await codeCheck(group);job.codeChecks[group.hash]=checked;}
      results.push({blockId:group.blockId,title:group.title,pageIds:group.pageIds,...checked});
    }
    return results;
  };
  const checkedRuns=resources=>resources.flatMap(resource=>[...codeGroups(resource).values()].flatMap(group=>{
    const evidence=job.auditEvidence?.find(e=>e.hash===group.hash);if(!evidence)return [];
    const output=currentVersion(resource).content.slides.filter(s=>s.code?.blockId===group.blockId&&s.code.kind==='output').map(s=>s.code.source).join('');
    const input=output.includes('输入：')?output.split('输入：')[1].split('输出：')[0]:'';
    if(input.split(/\s+/).filter(Boolean).join(' ')!==evidence.input.split(/\s+/).filter(Boolean).join(' '))return [];
    const expected=output.includes('输出：')?output.split('输出：')[1].split('（说明：')[0]:output;
    const normalize=s=>s.trim().split(/\s+/).join(' ');
    return [{blockId:group.blockId,title:group.title,pageIds:currentVersion(resource).content.slides.filter(s=>s.code?.blockId===group.blockId).map(s=>s.id),status:evidence.exitCode===0&&normalize(evidence.actual)===normalize(expected)?'passed':'failed',actual:evidence.actual,expected,input,diagnostic:evidence.diagnostic,checker:evidence.checker,scope:'sample-run'}];
  }));
  if(!job.codePagingVersion){
    // Balance an old draft's tiny trailing code page without changing the full
    // program, page IDs, page order, or the teacher's saved resource.
    for(const r of job.drafts.filter(r=>r.type==='ppt')){
      const groups=new Map();
      for(const s of currentVersion(r).content.slides.filter(s=>s.code?.blockId)){
        const key=s.code.blockId+':'+(s.code.kind||'source');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(s);
      }
      for(const pages of groups.values()){
        const parts=splitCodeSource(pages.map(s=>s.code.source).join(''));
        if(parts.length===pages.length)pages.forEach((page,i)=>{page.code.source=parts[i];page.code.part=i+1;page.code.parts=parts.length;});
      }
    }
    job.codePagingVersion=1;await checkpoint(job);
  }
  // Older checkpoints can contain more target pages than their recorded output
  // count. Cover every target on resume rather than dropping requested repairs.
  for(const task of job.tasks.slice(job.cursor))if(task.targetIds.length>task.pageCount){task.pageCount=task.targetIds.length;task.attempts=0;delete task.feedback;}
  const index = materialIndex(job.input.materials), strategy = (config.prompts?.agent ?? DEFAULT_PROMPTS.agent) + '\n' + (config.prompts?.preparation ?? DEFAULT_PROMPTS.preparation);
  const teacherContext=fitConversationContext({analysis:job.input.analysis,analysisSource:job.input.analysisSource||null,supplements:job.input.supplements},Math.max(1000,Math.min(16000,(config.maxInputChars??115000)-strategy.length-12000)));
  const save = async (stage, detail) => { paused(signal); job.stage = stage; if (detail) job.detail = detail; await checkpoint(job); };
  const ask = async (system, input) => {
    paused(signal);
    if (job.calls >= (config.maxAgentCalls ?? 120)) throw new AppError('任务达到设置中的模型调用额度；已完成草稿保留，增加运行额度后可继续。', 429);
    job.calls++; await checkpoint(job);
    try { return await call(system, input, { ...config, signal }); }
    catch(e){
      if(e.code==='MODEL_FORMAT'&&e.details)job.lastModelFailure={code:e.code,...e.details,phase:input.phase,taskId:input.task?.taskId};
      throw e;
    }
  };
  const sourceCatalog = index.map(({ text, ...c }) => ({ ...c, excerpt: text.slice(0, 120) }));
  if (!job.plan && !job.directCandidate) {
    let feedback = '', failures = 0;
    job.toolResults ||= [];
    // One model-driven loop: answer, inspect, make a direct operation, or opt into
    // a long task. There is no mandatory classification call or planning phase.
    const decisionSystem = (config.prompts?.agent ?? DEFAULT_PROMPTS.agent) + '\n' + CONVERSATION_CONTRACT + '\n' + CHAT_CONTRACT + '\n仅选择 action:plan 时使用下列计划格式：\n' + PLAN_SCHEMA + '\n计划可标 courseMode:"full|partial"，仅新建完整课程或教师明确要求重新安排整课时选 full。局部字段和标题修改选 partial，minutes 可为0，不为修改操作补足整课分钟数。关联互动步骤的 targetIds 填入实际PPT目标页；页面范围是允许修改的页面，不限制基于这些页面新建独立资源。';
    while (!job.plan && !job.directCandidate) {
      await save('deciding', feedback ? '调整本轮回应' : '正在思考…');
      const initialInput = { phase: 'decide', request: job.request, ...workspaceSummary(job.input), selectedId: job.resourceId || job.input.selectedId, requestedPageId: job.pageId, scopeIds: job.scopeIds, sourceIndex: sourceCatalog,
        recentConversation: job.input.messages.filter(m => !job.messageId || m.id !== job.messageId).slice(-12).map(m => ({ id:m.id,role: m.role, text: m.text, status: m.status })), tools: [...READ_TOOLS, ...AGENT_TOOLS], toolResults: job.toolResults, feedback,
        executionBudget: { batchPages: config.batchPages ?? 3, remainingCalls: (config.maxAgentCalls ?? 120) - job.calls, maxSteps: config.maxPlanSteps ?? 60 } };
      try {
        const input=fitConversationContext(initialInput,(config.maxInputChars??115000)-decisionSystem.length-1500);
        const result = await ask(decisionSystem, input);
        if (result?.action === 'tool') {
          await save('reading', '正在查看相关内容…');
          const remaining = (config.maxInputChars ?? 115000) - decisionSystem.length - JSON.stringify(input).length - 1500;
          const read = await readConversationTool(job, result, { readContext, maxChars: Math.min(20000, remaining) });
          job.toolResults.push(read); job.observations.push({kind:'read-result', tool:result.tool, text:'已读取相关内容'});
          feedback = ''; failures = 0; await checkpoint(job); continue;
        }
        if (!result || typeof result.reply !== 'string' || !result.reply.trim()) throw new AppError('模型缺少有效回复。', 502);
        if (['reply', 'advice', 'clarify'].includes(result.action)) {
          job.mode = 'conversation'; job.outcome = result.action; job.directCandidate = {action:result.action,reply:result.reply}; await checkpoint(job); return job.directCandidate;
        }
        const selectedResource=job.input.resources.find(r=>r.id===job.resourceId);
        const attachmentTarget=result.action==='attach'?result.pptId:result.action==='plan'?result.steps?.find(s=>s.tool==='resource.attach')?.resourceId:null;
        job.scopeResourceId=selectedResource?.type!=='ppt'&&job.input.resources.some(r=>r.id===attachmentTarget&&r.type==='ppt')?attachmentTarget:job.resourceId;
        job.scopeIds = scopeFor(job.input, job.request, job.scopeResourceId, job.scopeResourceId===job.resourceId?job.pageId:null);
        if (config.allowDirectCandidate && ['create', 'update', 'attach'].includes(result.action)) {
          await claimTask(job); job.mode = 'task'; job.directCandidate = { ...result, scopeIds: job.scopeIds }; await checkpoint(job); return job.directCandidate;
        }
        const direct = ['create','update','attach'].includes(result.action);
        const candidatePlan = direct ? directOperationPlan(result, job, config) : result;
        const validated = validatePlan(candidatePlan, job, config, index, direct, !direct);
        await claimTask(job); job.mode = 'task'; job.execution = direct ? 'direct' : 'planned';
        job.plan = validated; job.tasks = tasksFor(job.plan.steps, config);
        if (direct) {
          if(job.tasks.length>1)job.pendingCandidates=Object.fromEntries(job.tasks.map(task=>[task.taskId,{...result,operations:result.operations.slice(task.pageStart-1,task.pageStart-1+task.pageCount)}]));
          else job.pendingCandidate = result;
        }
        await checkpoint(job); break;
      } catch (e) {
        paused(signal); feedback = e.message; job.observations.push({ kind: 'decision-repair', text: feedback });
        if (++failures >= 3 || cannotRetry(e)) throw e;
      }
    }
  }
  if (job.plan) job.mode = 'task';
  if (job.directCandidate) return job.directCandidate;
  while (true) {
    while (job.cursor < job.tasks.length) {
      const task = job.tasks[job.cursor], state = toolState(job), targetId = task.resourceId?.startsWith('step:') ? job.created[task.resourceId.slice(5)] : task.resourceId && task.resourceId !== 'current' ? task.resourceId : state.selectedId;
      const target = state.resources.find(r => r.id === (job.created[task.id] || targetId));
      const priorCode=codeGroups(target);
      if(job.repairRound&&target?.type==='ppt'){
        const required=job.scopeIds?task.targetIds.filter(id=>job.scopeIds.includes(id)):requiredRepairTargets(task,currentVersion(target).content.slides);
        if(!task.requiredTargetIds&&required.length<task.targetIds.length&&/本步骤要求真实示例代码.*没有返回code\.source/.test(task.feedback||''))delete task.feedback;
        task.requiredTargetIds=required;
      }
      if(job.repairRound&&!job.scopeIds&&!task.disableCodeMerge){
        // Repairs to adjacent fragments of one program must land together:
        // closing a function in one fragment can require removing its old tail.
        const groups=new Set(currentVersion(target).content.slides.filter(s=>task.targetIds.includes(s.id)&&s.code?.blockId).map(s=>s.code.blockId));
        while(groups.size&&job.tasks[job.cursor+1]?.id===task.id){
          const next=job.tasks[job.cursor+1];
          if(!next.targetIds.length||!next.targetIds.every(pid=>groups.has(currentVersion(target)?.content.slides.find(s=>s.id===pid)?.code?.blockId)))break;
          task.targetIds=[...new Set([...task.targetIds,...next.targetIds])];task.pageCount=Math.max(task.pageCount+next.pageCount,task.targetIds.length);
          task.requiredTargetIds=[...new Set([...task.requiredTargetIds,...requiredRepairTargets(next,currentVersion(target).content.slides)])];
          task.attempts=0;delete task.feedback;job.tasks.splice(job.cursor+1,1);
        }
      }
      const tool = task.tool === 'ppt.create' && job.created[task.id] ? 'ppt.update' : task.tool;
      await save('retrieving', `读取“${task.title}”相关资料`);
      const scope = task.targetIds;
      const resource = target ? { id: target.id, name: target.name, type: target.type, versionId: target.currentVersionId, content: target.type === 'ppt' ? { slides: currentVersion(target).content.slides.filter(s => scope.includes(s.id)) } : currentVersion(target).content } : null;
      const input = { phase: 'execute', request: job.request, requirements: job.input.requirements, ...teacherContext,task: { ...task, tool }, resource, scopeIds: ['ppt.update','resource.attach'].includes(tool)?job.scopeIds:null,
        afterSlideId: job.anchors[task.id] || task.afterSlideId || task.targetIds.at(-1) || currentVersion(target)?.content.slides?.at(-1)?.id,
        resources: inventory(state), observations: job.observations.slice(-4), feedback: task.feedback || '' };
      const covered=new Set(job.stepPages?.[task.id]||[]);
      input.stepProgress={completedParts:job.observations.filter(o=>o.stepId===task.id&&o.kind==='tool-result').length,coveredPages:currentVersion(target)?.content.slides?.filter(s=>covered.has(s.id)).map(s=>({id:s.id,title:s.title,hasCode:Boolean(s.code),codeKind:s.code?.kind}))||[]};
      input.codeRuns=target?checkedRuns([target]).filter(c=>c.pageIds.some(pid=>scope.includes(pid))):[];
      const system = strategy + '\n' + CHAT_CONTRACT + '\n只执行本次 task，不重复整份课程。PPT 本批生成或修改最多 ' + task.pageCount + ' 个逻辑页面；只允许修改 task.targetIds 中的原页，新详解页用 add 放在 afterSlideId 后，连续新增保持教学顺序。needsCode表示本步骤完成后需有真实源码，已有源码可以保留；仅改输出或备注时不要求重新返回源码。kind=output页面的code.source是输出文本，不是程序源码。part>1 且无targetIds时只补充stepProgress未覆盖的内容；本步骤提前完成时可返回advice说明无需追加，最终仍会检查完整覆盖。不能为了凑预计页数重复前面讲过的原理或代码。不得在一次响应中返回整份课件。contextPages是只读相邻页，用于衔接步骤和核对输入、规则、结果；不能修改这些范围外页面。'+(job.repairRound?' 修正阶段：原页存在演算或答案错误时，必须update错误原页，不能只新增正确页面而留下错误。task.requiredTargetIds是必须修正的原页，targetIds中其余页为同一程序的可修改范围，正确的源码或输出页可以不改。只处理本批task.targetIds，不处理其他批次目标。自动续页共同承载一段内容，只修正本页对应的步骤，不把整段演算重复写到每个续页；优先最小字段补丁，保留正确内容与前后页衔接。':'');
      if(target?.type==='ppt'){
        // A physical code page can start or end inside a function. Supply the
        // assembled program as read-only context while keeping edit scope local.
        input.codeContext=[];
        const codeAllowance=Math.max(0,(config.maxInputChars??115000)-system.length-JSON.stringify(input).length-12000);
        let codeSize=0;
        for(const group of priorCode.values()){
          const allIds=currentVersion(target).content.slides.filter(s=>s.code?.blockId===group.blockId).map(s=>s.id);
          if(!allIds.some(pid=>scope.includes(pid))&&!currentVersion(target).content.slides.some(s=>s.code?.blockId===group.blockId&&scope.includes(s.paginationRootId)))continue;
          const context={blockId:group.blockId,language:group.language,source:group.source,pageIds:group.pageIds,readOnly:true,
            canReplaceBlock:allIds.every(pid=>scope.includes(pid))&&!job.scopeIds,
            replacementHint:'canReplaceBlock=true时可仅update该程序第一段，code.source给完整程序并设replaceBlock:true、expectedOutput给正确输出。旧源码和输出续页自动替换，无需逐段重复程序。否则只改当前段，保留其它段。'};
          const size=JSON.stringify(context).length;
          if(codeSize+size<=codeAllowance){input.codeContext.push(context);codeSize+=size;}
        }
        const slides=currentVersion(target).content.slides, positions=scope.length?slides.flatMap((s,i)=>scope.includes(s.id)?[i-1,i+1]:[]):[slides.length-2,slides.length-1];
        input.contextPages=[];let contextSize=0;
        const allowance=Math.min(16000,Math.max(0,(config.maxInputChars??115000)-system.length-JSON.stringify(input).length-6000));
        for(const pos of [...new Set(positions)].sort((a,b)=>a-b)){
          const page=slides[pos];if(!page||scope.includes(page.id))continue;
          const size=JSON.stringify(page).length;if(contextSize+size>allowance)continue;
          input.contextPages.push(page);contextSize+=size;
        }
      }
      const available = Math.max(0, (config.maxInputChars ?? 115000) - system.length - JSON.stringify(input).length - 1000);
      input.sources = selectedSources(index, task, Math.min(available, 45000));
      if (index.length && !input.sources.length) throw new AppError('当前输入额度不足以容纳该步骤及资料片段；已完成草稿保留，可调整输入额度后继续。', 413);
      await save(job.repairRound ? 'repairing' : 'generating', `${task.title} · 第 ${task.part}/${task.parts} 批`);
      try {
        const candidate = job.pendingCandidates?.[task.taskId] || job.pendingCandidate || await ask(system, input); delete job.pendingCandidate;if(job.pendingCandidates)delete job.pendingCandidates[task.taskId];paused(signal);
        await save('validating', `检查“${task.title}”的结构、范围与实际内容`);
        if(candidate.action==='advice'&&tool.startsWith('ppt.')){
          const previous=job.observations.filter(o=>o.stepId===task.id&&o.kind==='tool-result');
          if(task.part<=1||scope.length||!previous.length||(task.needsCode&&!previous.some(o=>o.codePages>0)))throw new AppError('本批仍有明确目标或代码要求，不能只返回建议。');
          job.observations.push({kind:'tool-skip',stepId:task.id,text:candidate.reply||'前批已覆盖本步骤，不追加重复内容。'});job.cursor++;await checkpoint(job);continue;
        }
        let produced,newAnchor,codePages=0;
        if (tool === 'ppt.create' || tool === 'activity.create') {
          if (candidate.action !== 'create' || (tool === 'ppt.create' ? candidate.type !== 'ppt' : !['game', 'web'].includes(candidate.type))) throw new AppError('工具返回了错误的资源类型或操作。');
          if (candidate.type === 'ppt' && candidate.content?.slides?.length > task.pageCount) throw new AppError('本批返回的页面多于批次额度。');
          produced = createResource(state, candidate.type, candidate.name, candidate.content);
          if(produced.type==='ppt')codePages=sourcePages(currentVersion(produced).content.slides).length;
          if (produced.type !== 'ppt') currentVersion(produced).runtimeValidation = await runtimeCheck(currentVersion(produced).content);
        } else if (tool === 'ppt.update') {
          if (!target || target.type !== 'ppt' || candidate.action !== 'update' || !Array.isArray(candidate.operations)) throw new AppError('PPT 更新工具没有返回有效补丁。');
          if (candidate.operations.length > task.pageCount && !job.scopeIds) throw new AppError('本批修改超出批次额度。');
          const original = currentVersion(target).content.slides;
          if(job.repairRound && scope.length && candidate.operations.some(op=>op.action==='add'))throw new AppError('修正已有页面时请直接更新目标页，不另外追加例题、答案或重复讲解；补缺内容应另列空targetIds步骤。');
          const replacedIds=new Set();
          for(const op of candidate.operations.filter(op=>op.action==='update'&&op.patch?.code?.replaceBlock===true)){
            const page=original.find(s=>s.id===op.slideId),owned=original.filter(s=>page?.code?.blockId?s.code?.blockId===page.code.blockId:s.code&&s.paginationRootId===page?.id);
            if(owned.some(s=>!scope.includes(s.id)))throw new AppError('替换完整程序需将所有代码和输出分段列入当前修正范围。');
            owned.forEach(s=>replacedIds.add(s.id));
          }
          if(job.repairRound && task.requiredTargetIds.some(pid=>!replacedIds.has(pid)&&!candidate.operations.some(op=>op.action!=='add'&&op.slideId===pid)))throw new AppError('修正批次必须修改所有指定原页；不能只新增页面而保留原错误。');
          for (const op of candidate.operations) {
            if (op.action !== 'add' && !scope.includes(op.slideId)) throw new AppError('工具修改了本批范围之外的页面。');
            if (op.action === 'delete' && !/删除|移除|重做|重写|替换|重构/.test(job.request) && (!job.repairRound || currentVersion(job.input.resources.find(r=>r.id===target.id))?.content.slides?.some(s=>s.id===op.slideId))) throw new AppError('扩写不能删除未要求移除的原有页面。');
            if (op.action === 'add') op.afterSlideId = input.afterSlideId;
            if (op.patch?.notes && !/备注|讲稿|notes/.test(job.request)) {
              const baseline=job.input.resources.find(r=>r.id===target.id);
              const teacherNotes=currentVersion(baseline)?.content.slides?.find(s=>s.id===op.slideId)?.notes || [];
              op.patch.notes = [...new Set([...teacherNotes, ...op.patch.notes])];
            }
          }
          const edit = applyPptOperations(target, candidate.operations, job.scopeIds);
          codePages=updateCodePages(original,edit.content.slides,candidate.operations,scope);
          commitResource(target, edit.content, '智能体：' + task.title, 'llm'); produced = target;
          const beforeIds = new Set(original.map(s => s.id)), added = currentVersion(target).content.slides.filter(s => !beforeIds.has(s.id));
          if (added.length) newAnchor = added.at(-1).id;
        } else if (tool === 'activity.update') {
          if (!target || target.type === 'ppt' || candidate.action !== 'update') throw new AppError('互动更新工具没有返回有效内容。');
          candidate.content = validateActivity(candidate.content); const checked = await runtimeCheck(candidate.content);
          const version = commitResource(target, candidate.content, '智能体：' + task.title, 'llm'); version.runtimeValidation = checked; produced = target;
        } else if (tool === 'resource.attach') {
          if (candidate.action !== 'attach') throw new AppError('关联工具未提供稳定资源ID。');
          produced = state.resources.find(r => r.id === candidate.pptId);
          if (!produced || produced.type!=='ppt' || produced.id!==target?.id) throw new AppError('关联工具超出计划中的PPT范围。');
          if(task.targetIds.length&&!task.targetIds.includes(candidate.slideId)||job.scopeIds&&!job.scopeIds.includes(candidate.slideId))throw new AppError('关联工具超出教师指定页面的修改范围。');
          applyWorkspaceCommand(state, { action: 'attach', resourceId: produced.id, baseVersionId: produced.currentVersionId, activityId: candidate.activityId, slideId: candidate.slideId });
        } else if (candidate.action !== 'advice') throw new AppError('建议工具返回了不支持的操作。');
        if(task.needsCode && task.part===task.parts && !codePages && !job.observations.some(o=>o.stepId===task.id&&o.codePages>0))throw new AppError('本步骤要求真实示例代码，但完成后的目标内容中没有程序源码。请提供code.source及调用方法，不用例题、伪代码、备注或输出文本代替。');
        if(produced?.type==='ppt'){
          const changedGroups=[...codeGroups(produced).values()].filter(group=>priorCode.get(group.blockId)?.hash!==group.hash);
          const checks=await checkGroups(changedGroups);
          for(const failed of checks.filter(c=>c.status==='failed')){
            const prior=priorCode.get(failed.blockId),priorCheck=prior?(await checkGroups([prior]))[0]:null;
            // Several parts of an already-invalid program can need successive
            // batches. Keep that intermediate draft; final review still blocks it.
            if(job.repairRound&&priorCheck?.status==='failed')job.observations.push({kind:'code-repair',stepId:task.id,text:'分段代码仍有编译错误，保留中间修正，最终检查必须通过：'+failed.diagnostic.slice(0,600)});
            else throw new AppError(`示例代码语法检查未通过：“${failed.title}”。${failed.diagnostic} 代码分段属于同一程序，请只修正当前段，不在每一段重复粘贴整份程序。`,422);
          }
        }
        if (produced) { recordDraft(job, produced); job.workingId = produced.id;if(tool.endsWith('.create'))job.created[task.id]=produced.id;if(newAnchor)job.anchors[task.id]=newAnchor; }
        if(produced?.type==='ppt'){
          // The read-only input inventory records the pre-operation IDs.
          const priorIds=new Set(input.resources.find(r=>r.id===produced.id)?.pages?.map(s=>s.id)||[]);
          const affected=new Set(candidate.operations?.filter(op=>op.action!=='delete').map(op=>op.slideId)||[]);
          const producedIds=currentVersion(produced).content.slides.filter(s=>!priorIds.has(s.id)||affected.has(s.id)||affected.has(s.paginationRootId)).map(s=>s.id);
          job.stepPages||={};job.stepPages[task.id]=[...new Set([...(job.stepPages[task.id]||[]),...producedIds])];
        }
        job.observations.push({ kind: 'tool-result', stepId: task.id, taskId: task.taskId, tool, text: candidate.reply || task.title,
          resourceId: produced?.id, pages: currentVersion(produced)?.content.slides?.length, codePages, sourceIds: input.sources.map(s => s.id) });
        job.cursor++; await checkpoint(job);
      } catch (e) {
        if(e.code==='RESOURCE_UNCHANGED'&&job.repairRound&&tool==='ppt.update'){
          paused(signal);
          job.observations.push({kind:'repair-no-op',stepId:task.id,repairRound:job.repairRound,text:'修正补丁与现有草稿一致，未重复写入。返回内容检查重新核对该问题，不据此声称已修正或检查通过。',instructions:task.instructions});
          job.cursor++;await checkpoint(job);continue;
        }
        paused(signal); task.attempts++; task.feedback = `上次执行未提交：${e.message}。修正该问题后只返回当前批次。`;
        job.observations.push({ kind: 'tool-repair', stepId: task.id, text: e.message });
        if(e.code==='MODEL_FORMAT'){
          task.feedback += '格式修正：返回完整 JSON 对象，字符串中的换行、双引号和反斜杠正确转义，不使用 Markdown 围栏；保持当前完整教学单元，不为格式错误拆散代码。';
        }
        if ((e.code==='MODEL_LENGTH' || /批次额度/.test(e.message)) && task.pageCount > 1) {
          const first = Math.floor(task.pageCount / 2), second = task.pageCount - first;
          job.tasks.splice(job.cursor, 1, { ...task, ...(task.requiredTargetIds?{requiredTargetIds:task.requiredTargetIds.filter(id=>task.targetIds.slice(0,first).includes(id))}:{}),disableCodeMerge:true,pageCount: first, targetIds: task.targetIds.slice(0, first), taskId: task.taskId + ':a', attempts: 0 },
            { ...task, ...(task.requiredTargetIds?{requiredTargetIds:task.requiredTargetIds.filter(id=>task.targetIds.slice(first).includes(id))}:{}),disableCodeMerge:true,pageStart: task.pageStart + first, pageCount: second, targetIds: task.targetIds.slice(first), taskId: task.taskId + ':b', attempts: 0 });
          await save('repairing', '输出过长，已自动缩小批次继续'); continue;
        }
        if (task.attempts <= (config.maxRepairs ?? 2) && !cannotRetry(e)) {
          await save('repairing', `修正“${task.title}”：${e.message}`); continue;
        }
        throw new AppError(`“${task.title}”暂未完成。${e.message} 已完成草稿保留，可继续任务。`, e.statusCode || 502);
      }
    }
    await save('reviewing', '核对教学目标、课时、知识覆盖与可实操内容');
    const state = toolState(job), changedPageIds = new Set(Object.values(job.stepPages || {}).flat());
    const content = job.drafts.map(r => ({ id: r.id, type: r.type, name: r.name,
      content: job.execution === 'direct' && r.type === 'ppt' && job.input.resources.some(old => old.id === r.id)
        ? {slides:currentVersion(r).content.slides.filter(s => changedPageIds.has(s.id))} : currentVersion(r).content }));
    const reviewGroups=job.drafts.flatMap(r=>{
      const original=codeGroups(job.input.resources.find(old=>old.id===r.id));
      return [...codeGroups(r).values()].filter(group=>job.execution!=='direct'||original.get(group.blockId)?.hash!==group.hash);
    });
    const codeChecks=await checkGroups(reviewGroups),codeRuns=checkedRuns(job.drafts);
    const reviewInput = { phase: 'review', request: job.request, requirements: job.input.requirements, ...teacherContext,plan: job.plan, resources: inventory(state),
      operationMode:job.execution || 'planned',
      reviewScope:job.execution === 'direct' || !job.plan.fullCourse ? '只核对本次操作目标是否实现及是否保留其它内容。未请求重做整课时，不因标题、字段或局部修改要求覆盖全部课程或补足授课分钟数。不因未修改的旧内容安排额外修正。' : '检查本任务教学目标与完整成果。',
      ...(job.execution === 'direct' ? {originalTargets:job.input.resources.flatMap(r=>r.type==='ppt'?currentVersion(r).content.slides.filter(s=>job.tasks.some(t=>t.resourceId===r.id&&t.targetIds.includes(s.id))).map(s=>({resourceId:r.id,content:s})):[])} : {}),
      pagination: 'content是程序自动分页后的实际展示页，plan.pages是生成时的逻辑内容单元。展示页超过计划数、同主题续页、长句分到相邻页不等于重复或丢失；应连同相邻页核对完整内容，不把正常分页当作缺陷。',
      observations: job.observations.filter(o => o.kind === 'tool-result').map(({ text, ...o }) => o), content, sourceIndex: sourceCatalog,codeChecks,codeRuns,
      unchangedRepairs:job.observations.filter(o=>o.kind==='repair-no-op'&&o.repairRound===job.repairRound).map(o=>({stepId:o.stepId,instructions:o.instructions,text:o.text})),
      reviewPolicy:FUNCTIONAL_REVIEW_POLICY,
      codeRunMeaning:'codeRuns是独立本机运行证据，只在源码和输入保持一致时有效。actual是实际输出，必须与当前expected一致；这些输入是验证数据而非教师指定答案，计划中的示例输出也可能错误，应按算法与运行结果修正正文、注释和输出。passed仅证明列出的输入，不能声称所有边界正确。',
      codeCheckMeaning:'passed仅表示本机编译器语法检查通过，未运行程序，不证明算法或预期输出正确。failed是实际编译错误，必须修正对应代码组；not_checked不得声称通过本机验证。' };
    // Review full page content in several parts if necessary, never drop pages.
    const reviewSystem = strategy + '\n' + REVIEW_SCHEMA + '\n分段检查时，只评价本段实际内容；其他段缺少正文不能推断整课缺失。全课覆盖参照 resources 页面目录。优先修正计算、答案矛盾与不可操作的练习；对已满足当前课时与目标的内容不反复增补。用于讲解错误写法的反例、错误分析不能当作正式算法步骤判错。每条issues只写已经证实的缺陷，已核算正确或无需修改的内容不得列入issues。\n'+FUNCTIONAL_REVIEW_POLICY+'\n本轮 phase=review 是检查工具：顶层action必须为review，须返回passed、issues与repairSteps；不要返回对话reply操作或再次返回update/attach。', budget = (config.maxInputChars ?? 115000) - reviewSystem.length - JSON.stringify({ ...reviewInput, content: [] }).length - 1000;
    const reviewParts = []; let part = [], size = 0;
    for (const r of content) for (const item of r.type === 'ppt' ? r.content.slides : [r.content]) {
      const entry = { resourceId: r.id, type: r.type, content: item }, bytes = JSON.stringify(entry).length;
      if (bytes > budget) throw new AppError('单页检查内容超过输入额度；草稿保留，可调整输入额度后继续。', 413);
      if (part.length && size + bytes > budget) { reviewParts.push(part); part = []; size = 0; }
      part.push(entry); size += bytes;
    }
    if (part.length || !reviewParts.length) reviewParts.push(part);
    const repairs = [], issues = [], suggestions = []; let reviewReply = '';
    for (let i = 0; i < reviewParts.length; i++) {
      await save('reviewing',`检查教学内容 · 第 ${i+1}/${reviewParts.length} 部分`);
      let feedback = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const pageIds=new Set(reviewParts[i].map(p=>p.content.id));
          const reviewed = await ask(reviewSystem, { ...reviewInput, codeChecks:codeChecks.filter(c=>c.pageIds.some(pid=>pageIds.has(pid))),codeRuns:codeRuns.filter(c=>c.pageIds.some(pid=>pageIds.has(pid))), content: reviewParts[i], reviewPart: i + 1, totalReviewParts: reviewParts.length, feedback });
          // Models often omit empty lists when a review passes. That is a valid
          // empty result, while a failed review must still provide executable repairs.
          if(reviewed?.action==='review'&&reviewed.passed===true){reviewed.issues??=[];reviewed.repairSteps??=[];}
          if(reviewed?.passed===true){const failures=[...codeChecks,...codeRuns].filter(c=>c.status==='failed'&&reviewParts[i].some(p=>c.pageIds.includes(p.content.id)));if(failures.length)throw new AppError('本段仍有实际编译或运行输出错误，不能通过检查。请根据codeChecks和codeRuns为对应pageIds返回具体修正步骤。');}
          if (reviewed?.action !== 'review' || typeof reviewed.passed !== 'boolean' || !Array.isArray(reviewed.issues) || !Array.isArray(reviewed.repairSteps)) throw new AppError('检查工具返回的结构无效。');
          if (reviewed.suggestions !== undefined && (!Array.isArray(reviewed.suggestions) || reviewed.suggestions.some(s => typeof s !== 'string'))) throw new AppError('检查建议格式无效。');
          if (reviewed.issues.some(s => typeof s !== 'string' || /未发现.{0,8}错误|没有计算错误|无需(?:修改|修正|改动)|无须(?:修改|修正)/.test(s))) throw new AppError('检查结果把已排除或无需修改的问题列为缺陷。请重新独立核算，只保留证实的错误；正确内容从issues和repairSteps移除，可选改进放suggestions。');
          if (!reviewed.passed && !reviewed.repairSteps.length) throw new AppError('检查发现问题但没有提供可执行修正。');
          if (reviewed.passed && (reviewed.issues.length || reviewed.repairSteps.length)) throw new AppError('检查结果矛盾：仍有问题或修正步骤时不能标记通过。');
          if(!reviewed.passed)validatePlan({action:'plan',steps:reviewed.repairSteps},job,config,index,true,false);
          issues.push(...reviewed.issues); suggestions.push(...(reviewed.suggestions || [])); if (!reviewed.passed) repairs.push(...reviewed.repairSteps); reviewReply = reviewed.reply || '完成目标检查。'; break;
        } catch (e) {
          paused(signal);feedback=e.message;
          if(e.code==='MODEL_LENGTH' && reviewParts[i].length>1){
            const chunk=reviewParts[i],half=Math.floor(chunk.length/2);reviewParts.splice(i,1,chunk.slice(0,half),chunk.slice(half));
            job.observations.push({kind:'review-repair',text:'检查输出过长，已缩小检查批次继续。'});await checkpoint(job);i--;break;
          }
          if (attempt === 2 || cannotRetry(e)) throw e;
        }
      }
    }
    job.review = { passed: !repairs.length, issues, suggestions: [...new Set(suggestions)], reply: reviewReply }; await checkpoint(job);
    if (!repairs.length) return { action: 'agent-commit', reply: job.execution === 'direct' ? `已完成本次修改。${reviewReply}` : `已按计划完成 ${job.plan.steps.length} 个步骤，并检查教学目标与内容。${reviewReply}`, job };
    if (job.repairRound >= (config.maxRepairs ?? 3)) throw new AppError(`自动修正轮次达到运行额度，仍有 ${issues.length} 项待处理。`+issues.slice(0,2).map(s=>String(s).slice(0,120)).join('；')+'。完整问题见内容检查记录；草稿保留，可在设置中增加修正轮次后继续。', 422);
    // Independent review parts often reuse IDs such as repair-1. They are local
    // to each response; assign unique execution IDs before merging the results.
    const merged=[];
    for(const repair of repairs){
      const same=repair.targetIds?.length && merged.find(s=>s.tool===repair.tool && s.resourceId===repair.resourceId && JSON.stringify(s.targetIds)===JSON.stringify(repair.targetIds));
      if(same){same.instructions+='\n'+repair.instructions;same.sourceIds=[...new Set([...same.sourceIds,...(repair.sourceIds||[])])];same.topics=[...new Set([...same.topics,...(repair.topics||[])])];same.pages=Math.max(Number(same.pages)||1,Number(repair.pages)||1);}
      else merged.push({...repair,id:`repair-${job.repairRound+1}-${merged.length+1}`,sourceIds:repair.sourceIds||[],topics:repair.topics||[]});
    }
    const plan = validatePlan({ action: 'plan', steps: merged }, job, config, index, true);
    if(!job.scopeIds)for(const step of plan.steps.filter(s=>s.tool==='ppt.update')){
      const resource=state.resources.find(r=>r.id===(step.resourceId==='current'?state.selectedId:step.resourceId));
      const slides=currentVersion(resource)?.content.slides||[],blocks=new Set(slides.filter(s=>step.targetIds.includes(s.id)&&s.code?.blockId).map(s=>s.code.blockId));
      step.requiredTargetIds=[...step.targetIds];
      step.targetIds=[...new Set([...step.targetIds,...slides.filter(s=>blocks.has(s.code?.blockId)).map(s=>s.id)])];step.pages=Math.max(step.pages,step.targetIds.length);
    }
    job.repairRound++; job.tasks.push(...tasksFor(plan.steps, config, job.repairRound));
    job.observations.push({ kind: 'review-repair', text: issues.join('；') }); await checkpoint(job);
  }
}

export function checkAgentBase(state, job) {
  if (JSON.stringify(state.requirements) !== JSON.stringify(job.input.requirements) || JSON.stringify(state.materials) !== JSON.stringify(job.input.materials) || JSON.stringify(state.analysis) !== JSON.stringify(job.input.analysis) || JSON.stringify(state.supplements) !== JSON.stringify(job.input.supplements)) throw new AppError('执行期间教学要求或资料已改变，未覆盖成果。请用最新输入重新规划；旧草稿保留。', 409);
  const affected = new Set([job.resourceId, ...job.drafts.map(r => r.id)].filter(Boolean));
  for (const original of job.input.resources.filter(r => affected.has(r.id))) {
    if (state.resources.find(r => r.id === original.id)?.currentVersionId !== original.currentVersionId) throw new AppError('执行期间目标资源已被编辑或删除，未覆盖教师修改。请使用最新版本重新规划。', 409);
  }
}

export function commitAgentDrafts(state, job) {
  checkAgentBase(state, job); let selected;
  const selection = state.selectedId, selectionUnchanged = selection === job.input.selectedId;
  const summaries = [];
  for (const draft of job.drafts) {
    const existing = state.resources.find(r => r.id === draft.id), version = currentVersion(draft);
    let target;
    if (existing) { commitResource(existing, version.content, '智能体完成：' + job.plan.goal, 'llm'); target = existing; }
    else { target = createResource(state, draft.type, draft.name, version.content); target.id = draft.id; }
    const committed = currentVersion(target);
    committed.id = version.id; target.currentVersionId = version.id;
    const known = new Set(target.versions.map(v => v.id));
    for (const referenced of draft.versions.filter(v => !known.has(v.id))) target.versions.push({ ...clone(referenced), parentId: committed.parentId });
    if (version.runtimeValidation) currentVersion(target).runtimeValidation = version.runtimeValidation;
    selected = target;
    summaries.push(target.name + (target.type === 'ppt' ? `：${currentVersion(target).content.slides.length} 页` : '：可运行互动'));
  }
  state.selectedId = selectionUnchanged && job.workingId ? job.workingId : selection;
  return { target: selected, produced: currentVersion(selected), summary: summaries.join('；') };
}
