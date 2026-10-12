import { AppError, clone } from './store.js';
import { currentVersion } from './workspace.js';

export const READ_TOOLS = [
  { name: 'workspace.read', description: '读取最新教学要求、教师修订、分页资源目录与任务概况', args: { resourceStart:0, resourceLimit:10, materialStart:0, materialLimit:10 } },
  { name: 'resource.read', description: '读取资源正文；PPT 按稳定页面 ID 或从 start 页开始读取（从0计数）', args: { resourceId: '资源 ID 或 current', pageIds: ['页面 ID，可省略'], start: 0, limit: 3 } },
  { name: 'material.read', description: '按字符位置读取完整资料的一段，可继续读取下一段', args: { materialId: '资料 ID', start: 0, length: 6000 } },
  { name: 'context.read', description: '按字符位置读取完整的教师修订知识点和已选择补充内容（JSON 文本）', args: { start: 0, length: 6000 } },
  { name: 'conversation.read', description: '读取历史消息目录或指定消息正文；缩略历史可按需补读', args: { messageId: '消息 ID，可省略', messageStart: 0, start: 0, length: 6000 } },
  { name: 'task.status', description: '读取最新任务进度、错误及草稿概况；省略 ID 时读取近期任务', args: { jobId: '任务 ID，可省略' } },
];

export const CONVERSATION_CONTRACT = [
  '对话与工具协议：只返回 JSON。每轮自主选择直接回答、澄清、读取工具、直接修改工具或复杂任务计划，不要求先制定计划。',
  '问候、聊天、概念解释和建议通常直接返回 {action:"reply",reply:"自然简洁的回答"}；缺少必要目标时返回 {action:"clarify",reply:"一个具体问题"}。advice 与 reply 等价。',
  '纯问候用一两句自然回应即可，不主动复述课程要求、失败任务或询问是否重新生成课件。普通回答不必以备课任务提议或确认问题结尾，按教师正在讨论的内容回应。',
  '教师设置、已上传资料、已选资源和历史失败任务只是背景，不代表本轮授权生成或修改。只在教师本轮提出操作要求或明确承接上一轮操作提议时修改资源；不因问候或询问自动继续旧任务。',
  '需要事实依据时返回 {action:"tool",tool:"workspace.read|resource.read|material.read|context.read|conversation.read|task.status",args:{工具参数}}。观察 toolResults 后自主选择继续读取、回答或执行。只引用实际读到的正文，不虚构进度或声称已修改。contextOmissions 和 truncated 表示本轮仅携带预览，可按需读取完整记录。教师修订的分析和选中补充优先于资料中的旧内容。',
  '简单且明确的操作直接返回 create/update/attach 数据协议；修改前若未看到目标正文，先 resource.read。大规模生成或多步骤任务才返回 action:plan。返回给教师的回复不要包含内部 JSON 或工具协议。',
  '教师已明确给出的目标值和范围直接执行，不重复询问已提供的信息。每页都改成同一标题等明确要求也应按原值执行。',
  '执行中仍可以回答问题；有其它写入任务执行时，应说明需要等待或先暂停，再执行新的写入，不自行暂停、恢复、取消旧任务。',
].join('\n');

export function workspaceSummary(state) {
  return { requirements: clone(state.requirements), selectedId: state.selectedId, analysis: clone(state.analysis), analysisSource: state.analysisSource || null, supplements: clone(state.supplements),
    resources: state.resources.map(r => ({ id: r.id, name: r.name, type: r.type, versionId: r.currentVersionId,
      pages: r.type === 'ppt' ? currentVersion(r).content.slides.map(s => ({ id: s.id, title: s.title })) : undefined })),
    materials: state.materials.map(m => ({ id: m.id, title: m.title, status: m.status, characters: m.content?.length || 0 })),
    tasks: state.messages.filter(m => m.role === 'user' && m.jobId && (m.mode === 'task' || !m.mode)).slice(-8).map(m => ({ id: m.jobId, request: m.text, status: m.status, mode: m.mode, error: m.error })) };
}

// Keep the current request intact. Older context is an explicitly labelled
// preview, with tools for reading the complete saved record when needed.
export function fitConversationContext(input, maxChars) {
  const out = clone(input), omissions = new Set(out.contextOmissions || []);
  const size = () => JSON.stringify(out).length;
  const mark = name => { omissions.add(name); out.contextOmissions = [...omissions]; };
  if(out.recentConversation){
    const historyBudget=Math.min(24000,Math.max(0,Math.floor(maxChars/4)));
    if(JSON.stringify(out.recentConversation).length>historyBudget){
      out.recentConversation.forEach((m,i)=>{
        const limit=i>=out.recentConversation.length-2?6000:1200;
        if(m.text.length>limit){m.characters=m.characters??m.text.length;m.text=m.text.slice(0,limit);m.truncated=true;}
      });
      for(const m of out.recentConversation){
        if(JSON.stringify(out.recentConversation).length<=historyBudget)break;
        if(m.text.length>300){m.characters=m.characters??m.text.length;m.text=m.text.slice(0,300);m.truncated=true;}
      }
      mark('recentConversation：conversation.read 可读取完整消息');
    }
  }
  if (size() <= maxChars) return out;
  for (const m of out.recentConversation || []) {
    if (m.text.length > 600) { m.characters = m.characters??m.text.length; m.text = m.text.slice(0, 600); m.truncated = true; mark('recentConversation：conversation.read 可读取完整消息'); }
    if (size() <= maxChars) return out;
  }
  for (const field of ['sourceIndex','resources','analysis','supplements','toolResults']) {
    if (field === 'sourceIndex' && out.sourceIndex?.length) {
      out.sourceIndex = out.sourceIndex.slice(0, 12).map(({excerpt,...item})=>item); mark('sourceIndex：material.read 可读取资料正文');
    } else if (field === 'resources' && out.resources) {
      out.resources = out.resources.map(r=>({...r,...(r.pages?{totalPages:r.pages.length,pages:r.pages.slice(0,6)}:{})})); mark('resources.pages：resource.read 可按 start 分页读取');
    } else if (field === 'analysis' && out.analysis) {
      out.analysis = Object.fromEntries(Object.entries(out.analysis).map(([k,v])=>[k,Array.isArray(v)?v.slice(0,3).map(s=>String(s).slice(0,200)):v])); mark('analysis：context.read 可读取教师修订全文');
    } else if (field === 'supplements' && out.supplements?.length) {
      out.supplements = out.supplements.slice(0,3).map(s=>({title:String(s.title||'').slice(0,200),description:String(s.description||'').slice(0,200),source:String(s.source||'').slice(0,200)})); mark('supplements：context.read 可读取全部已选择补充');
    } else if (field === 'toolResults' && out.toolResults?.length) {
      out.toolResults = out.toolResults.slice(-1); mark('toolResults：较早读取可重新调用原工具');
    }
    if (size() <= maxChars) return out;
  }
  // Very small budgets may require keeping only the newest turns and selected
  // resource directory. Never shorten the teacher's current request or task.
  if (out.recentConversation) { out.recentConversation = out.recentConversation.slice(-2); mark('recentConversation：conversation.read 可读取完整历史'); }
  if (out.resources) { out.resources = out.resources.filter(r=>r.id===out.selectedId);mark('resources：workspace.read 可分页读取完整目录'); }
  if (out.materials?.length>3) { out.materials=out.materials.slice(0,3);mark('materials：workspace.read 可分页读取完整目录'); }
  if (size() > maxChars) throw new AppError('本轮请求、教学要求或提示词超过输入额度，请提高输入额度或精简这些设置。历史已压缩，完整记录仍保留。', 413);
  return out;
}

export async function readConversationTool(job, result, { readContext, maxChars = 20000 } = {}) {
  if (!READ_TOOLS.some(t => t.name === result.tool) || !result.args || typeof result.args !== 'object' || Array.isArray(result.args)) throw new AppError('只读工具名称或参数无效。');
  const args = result.args;
  // Reads use the latest workspace when available. Writes still check the original
  // version before committing, so a fresh read cannot authorize a stale overwrite.
  const state = readContext ? await readContext('workspace') : job.input;
  let data;
  if (result.tool === 'workspace.read') {
    const summary=workspaceSummary(state);
    for(const [field,startKey,limitKey] of [['resources','resourceStart','resourceLimit'],['materials','materialStart','materialLimit']]){
      const start=args[startKey]??0,limit=args[limitKey]??10;
      if(!Number.isSafeInteger(start)||start<0||start>summary[field].length||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new AppError('工作台目录读取位置或数量无效。');
      summary['total'+field[0].toUpperCase()+field.slice(1)]=summary[field].length;
      summary['next'+startKey[0].toUpperCase()+startKey.slice(1)]=start+limit<summary[field].length?start+limit:null;
      summary[field]=summary[field].slice(start,start+limit);
    }
    data = fitConversationContext(summary, maxChars);
  }
  else if (result.tool === 'task.status') {
    data = readContext ? await readContext('tasks', args.jobId) : workspaceSummary(state).tasks.filter(t => !args.jobId || t.id === args.jobId);
    if (args.jobId && !data.length) throw new AppError('当前对话中不存在该任务。');
  } else if (result.tool === 'resource.read') {
    const r = state.resources.find(r => r.id === (args.resourceId === 'current' || !args.resourceId ? job.resourceId || state.selectedId : args.resourceId));
    if (!r) throw new AppError('要读取的资源不存在。');
    const v = currentVersion(r); data = { id: r.id, name: r.name, type: r.type, versionId: v.id };
    if (r.type !== 'ppt') data.content = clone(v.content);
    else {
      const ids = args.pageIds;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => !v.content.slides.some(s => s.id === id)))) throw new AppError('要读取的页面不存在，请使用目录中的页面 ID。');
      const start = args.start ?? 0, limit = args.limit ?? 3;
      if (!Number.isSafeInteger(start) || start < 0 || start >= v.content.slides.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new AppError('页面读取位置或数量无效。');
      const pages = ids ? v.content.slides.filter(s => ids.includes(s.id)) : v.content.slides.slice(start, start + limit);
      data.content = { slides: clone(pages) }; data.totalPages = v.content.slides.length;
      data.readPageIds = pages.map(s => s.id);
      if (!ids) data.nextPageStart = start + pages.length < data.totalPages ? start + pages.length : null;
    }
  } else if (result.tool === 'context.read' || result.tool === 'conversation.read') {
    let text;
    if (result.tool === 'context.read') text = JSON.stringify({analysis:state.analysis,analysisSource:state.analysisSource,supplements:state.supplements});
    else if (args.messageId) {
      const message = state.messages.find(m=>m.id===args.messageId);
      if (!message) throw new AppError('历史消息不存在。');
      text = message.text;
    } else {
      const start = args.messageStart ?? Math.max(0,state.messages.length-20);
      if (!Number.isSafeInteger(start) || start < 0 || start > state.messages.length) throw new AppError('历史消息读取位置无效。');
      data = { messages:state.messages.slice(start,start+20).map(m=>({id:m.id,role:m.role,preview:m.text.slice(0,80),characters:m.text.length})), totalMessages:state.messages.length, nextMessageStart:start+20<state.messages.length?start+20:null, previousMessageStart:start?Math.max(0,start-20):null };
    }
    if (text !== undefined) {
      const start = args.start ?? 0, length = args.length ?? Math.min(6000,maxChars-1000);
      if (!Number.isSafeInteger(start) || start < 0 || start > text.length || !Number.isSafeInteger(length) || length < 1 || length > 20000) throw new AppError('上下文读取位置或长度无效。');
      const end=Math.min(text.length,start+length);data={text:text.slice(start,end),start,end,totalCharacters:text.length,nextStart:end<text.length?end:null};
    }
  } else {
    const m = state.materials.find(m => m.id === args.materialId && m.status === 'parsed');
    if (!m) throw new AppError('要读取的已解析资料不存在。');
    const start = args.start ?? 0, length = args.length ?? Math.min(6000, maxChars - 1000);
    if (!Number.isSafeInteger(start) || start < 0 || start > m.content.length || !Number.isSafeInteger(length) || length < 1 || length > 20000) throw new AppError('资料读取位置或长度无效。');
    const end = Math.min(m.content.length, start + length);
    data = { id: m.id, title: m.title, start, end, totalCharacters: m.content.length, text: m.content.slice(start, end), nextStart: end < m.content.length ? end : null };
  }
  if (JSON.stringify(data).length > maxChars) throw new AppError('读取结果超过本轮输入额度，请减少页面数量或资料读取长度。', 413);
  return { tool: result.tool, args: clone(args), data, observedAt:new Date().toISOString() };
}

export function directOperationPlan(candidate, job, config) {
  const targetId = candidate.action === 'attach' ? candidate.pptId : job.resourceId || job.input.selectedId;
  const target = job.input.resources.find(r => r.id === targetId);
  const tool = candidate.action === 'attach' ? 'resource.attach' : candidate.action === 'create' ? candidate.type === 'ppt' ? 'ppt.create' : 'activity.create' : target?.type === 'ppt' ? 'ppt.update' : 'activity.update';
  if (candidate.action === 'update' && !target) throw new AppError('没有选中的资源，请先选择或新建。');
  const pages = candidate.action === 'create' && candidate.type === 'ppt' ? candidate.content?.slides?.length : target?.type === 'ppt' && candidate.action === 'update' ? candidate.operations?.length : 1;
  const targetIds = candidate.action === 'attach' ? [candidate.slideId] : [...new Set((candidate.operations || []).filter(op => op.action !== 'add').map(op => op.slideId))];
  const canSplit = tool==='ppt.update' && targetIds.length===pages && candidate.operations.every(op=>['update','delete'].includes(op.action));
  if (!Number.isInteger(pages) || pages < 1 || pages > (config.batchPages ?? 3) && !canSplit) throw new AppError('直接操作超过单批额度；独立页面的修改和删除可自动分批，其它操作请按需规划。');
  const anchors = [...new Set((candidate.operations || []).filter(op => op.action === 'add' && op.afterSlideId).map(op => op.afterSlideId))];
  if (anchors.length > 1) throw new AppError('多个不同插入位置需要分别规划执行。');
  return { action: 'plan', goal: job.request, reply: candidate.reply, steps: [{ id: 'direct', title: '执行本次修改', tool, resourceId: targetId || 'current', targetIds,
    instructions: job.request, pages, minutes: 0, sourceIds: [], topics: [], ...(anchors.length ? {afterSlideId:anchors[0]} : {}) }] };
}
