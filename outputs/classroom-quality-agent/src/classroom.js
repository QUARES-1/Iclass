import { AppError, id, clone } from './store.js';
import {simplifiedTranscript,simplifiedReport} from './chineseText.js';
import {REPORT_SECTIONS,CLASSROOM_TERMINAL_STAGES,hasClassroomTask,analysisSegments} from './classroomShared.js';
export {REPORT_SECTIONS,CLASSROOM_TERMINAL_STAGES,hasClassroomTask,analysisSegments,textObservations} from './classroomShared.js';
export function formatTime(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
export const emptyClassroom = () => ({ revision: 0, savedAt:null, course: { title: '', description: '' }, courseVersion: 0,audioGeneration:0, audio: null, transcriptVersions: [], currentTranscriptId: null, reports: [], currentReportId: null, jobs: [],conversation:[],conversationGeneration:0 });
export const transcriptOf = state => state.transcriptVersions.find(t => t.id === state.currentTranscriptId);
export const reportOf = state => state.reports.find(r => r.id === state.currentReportId);
// Only audio workflow fields migrate from an older document.
export function migrateClassroom(raw = {}) {
  const base = emptyClassroom();
  for (const key of Object.keys(base)) if (raw[key] !== undefined) base[key] = clone(raw[key]);
  base.course = { title: String(base.course?.title || ''), description: String(base.course?.description || '') };
  const audioFields = ['id','file','name','bytes','duration','codec','sampleRate','format','source','createdAt','playbackFile','deleted'];
  const cleanAudio = audio => audio ? Object.fromEntries(audioFields.filter(k => audio[k] !== undefined).map(k => [k,audio[k]])) : null;
  base.audio = cleanAudio(base.audio);
  base.transcriptVersions = base.transcriptVersions.map(t => ({ ...Object.fromEntries(['id','audioId','source','original','createdAt','parentId','processing'].filter(k => t[k] !== undefined).map(k => [k,t[k]])), audio: cleanAudio(t.audio), segments: (t.segments || []).map(s => Object.fromEntries(['id','start','end','text','timestampSource','excluded'].filter(k => s[k] !== undefined).map(k => [k,s[k]]))) }));
  const cleanSections = sections => Object.fromEntries(Object.keys(REPORT_SECTIONS).map(k => [k,(sections?.[k] || []).filter(item => typeof item.text === 'string' && !/抬头率|注意力回落|投入回升|attention-low|headUpRate/.test(item.text)).map(item => Object.fromEntries(['id','text','kind','evidenceIds','confirmed','edited','timeEvidence'].filter(f => item[f] !== undefined).map(f => [f,item[f]])))]));
  base.reports = base.reports.map(r => ({ ...Object.fromEntries(['id','transcriptId','courseVersion','course','stale','createdAt','source','coverage','mode','detailSections','parentReportId','detailRequest','textNormalization'].filter(k => r[k] !== undefined).map(k => [k,r[k]])), sections: cleanSections(r.sections), history:(r.history||[]).map(h=>({id:h.id,createdAt:h.createdAt,sections:cleanSections(h.sections)})) }));
  if (!base.course.title && typeof raw.meta?.course === 'string') base.course.title = raw.meta.course;
  if (!base.transcriptVersions.length && Array.isArray(raw.segments)) {
    try { const segments = validateSegments(raw.segments, Infinity, 'legacy-user-timestamps'); const v = { id: id(), source: 'legacy', audioId: null, segments, createdAt: new Date().toISOString() }; base.transcriptVersions = [v]; base.currentTranscriptId = v.id; } catch { /* Invalid old timestamps cannot masquerade as recognition. */ }
  }
  return base;
}
export function invalidateReports(state) { state.reports.forEach(r => { r.stale = true; }); }
export function validateSegments(segments, duration, source) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 50000) throw new AppError('未识别到有效语音，或片段数量过多。');
  let previousStart = -1;
  const out = segments.map(s => {
    if (!s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 16000 || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > duration + 0.3 || s.start < previousStart) throw new AppError('转写片段时间或文本无效。');
    previousStart = s.start;
    if (s.id !== undefined && (typeof s.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(s.id))) throw new AppError('转写片段 ID 无效。');
    return { id: s.id || id(), start: s.start, end: s.end, text: s.text.trim(), timestampSource: s.timestampSource || source };
  });
  if (new Set(out.map(s => s.id)).size !== out.length) throw new AppError('转写片段 ID 重复。');
  return out;
}
export function applyClassroomCommand(raw, cmd) {
  const state = migrateClassroom(raw);
  if (cmd.action === 'clear') {
    if (hasClassroomTask(state)) throw new AppError('任务进行中，请先暂停或取消再清空。', 409);
    return {...emptyClassroom(),audioGeneration:state.audioGeneration+1,conversationGeneration:state.conversationGeneration+1};
  }
  if(cmd.action==='clearConversation'){state.conversation=[];state.conversationGeneration++;return state;}
  if (cmd.action === 'course') {
    if (typeof cmd.course?.title !== 'string' || typeof cmd.course?.description !== 'string' || cmd.course.title.length > 500 || cmd.course.description.length > 8000) throw new AppError('课程说明格式无效。');
    if (JSON.stringify(state.course) !== JSON.stringify(cmd.course)) { state.course = cmd.course; state.courseVersion++; invalidateReports(state); }
  } else if (cmd.action === 'correct') {
    const current = transcriptOf(state);
    if (!current || current.id !== cmd.transcriptId) throw new AppError('转写版本已改变，请刷新后重试。', 409);
    if (!Array.isArray(cmd.segments) || cmd.segments.length !== current.segments.length || !cmd.segments.every((s, i) => s.id === current.segments[i].id && typeof s.text === 'string' && s.text.length <= 16000 && (s.excluded===undefined || typeof s.excluded==='boolean'))) throw new AppError('校正必须保留原片段与时间；可修改文字或排除误识别片段。');
    const v = { ...current, id: id(), parentId: current.id, source: 'teacher', original: false, segments: current.segments.map((s, i) => ({ ...s, text: cmd.segments[i].text, excluded:cmd.segments[i].excluded===true || !cmd.segments[i].text.trim() })), createdAt: new Date().toISOString() };
    state.transcriptVersions.push(v); state.currentTranscriptId = v.id; invalidateReports(state);
  } else if(cmd.action==='simplifyTranscript'){
    if(hasClassroomTask(state))throw new AppError('请先完成或暂停当前任务，再转换转写字形。',409);
    const current=transcriptOf(state);
    if(!current||current.id!==cmd.transcriptId)throw new AppError('转写版本已变化，请刷新后重试。',409);
    const normalized=simplifiedTranscript(current);
    if(normalized){
      const report=reportOf(state);
      const aligned=report&&!report.stale&&report.transcriptId===current.id&&report.courseVersion===state.courseVersion;
      const normalizedReport=aligned?simplifiedReport(report,normalized.id):null;
      state.transcriptVersions.push(normalized);state.currentTranscriptId=normalized.id;invalidateReports(state);
      if(normalizedReport){state.reports.push(normalizedReport);state.currentReportId=normalizedReport.id;}
    }
  } else if (cmd.action === 'selectAudio') {
    if(hasClassroomTask(state))throw new AppError('请先暂停当前任务再切换录音。',409);
    const audio=[state.audio,...state.transcriptVersions.map(t=>t.audio),...state.jobs.map(j=>j.audio)].find(a=>a?.id===cmd.audioId&&!a.deleted);
    if(!audio)throw new AppError('录音不存在或已删除。',404);
    state.audio=clone(audio);state.audioGeneration++;
    state.currentTranscriptId=state.transcriptVersions.filter(t=>t.audioId===audio.id).at(-1)?.id||null;invalidateReports(state);
  } else if (cmd.action === 'selectTranscript') {
    if(hasClassroomTask(state))throw new AppError('请先暂停当前任务再切换转写。',409);
    const t=state.transcriptVersions.find(t=>t.id===cmd.transcriptId);
    if(!t)throw new AppError('转写版本不存在。',404);
    state.currentTranscriptId=t.id;state.audio=t.audio&&!t.audio.deleted?clone(t.audio):null;state.audioGeneration++;invalidateReports(state);
  } else if (['selectReport','restoreReportRevision','confirmReport'].includes(cmd.action)) {
    if(hasClassroomTask(state))throw new AppError('请先暂停当前任务再切换或确认报告。',409);
    const r=state.reports.find(r=>r.id===cmd.reportId);
    if(!r)throw new AppError('报告版本不存在。',404);
    state.currentReportId=r.id;
    if(cmd.action==='selectReport') {
      r.stale=r.transcriptId!==state.currentTranscriptId||r.courseVersion!==state.courseVersion||Boolean(state.transcriptVersions.find(t=>t.id===r.transcriptId)?.audio?.deleted);
    } else if(cmd.action==='confirmReport') {
      if(r.stale)throw new AppError('输入已更新，请重新分析后确认。');
      rememberReport(r);Object.values(r.sections).flat().forEach(item=>item.confirmed=true);
    } else {
      const h=r.history.find(h=>h.id===cmd.historyId);
      if(!h)throw new AppError('修订版本不存在。',404);
      const sections=clone(h.sections);rememberReport(r);r.sections=sections;
    }
  } else if (cmd.action === 'reportItem') {
    const report = reportOf(state);
    if (!report || report.id !== cmd.reportId || !REPORT_SECTIONS[cmd.section]) throw new AppError('报告版本或分类不存在。', 409);
    const item = report.sections[cmd.section].find(x => x.id === cmd.itemId);
    if (!item) throw new AppError('结论不存在。');
    if (cmd.delete) { rememberReport(report);report.sections[cmd.section] = report.sections[cmd.section].filter(x => x.id !== cmd.itemId); }
    else if (cmd.confirm) { if (report.stale) throw new AppError('输入已更新，请重新分析后确认。'); if(!item.confirmed){rememberReport(report);item.confirmed = true;} }
    else {
      if (typeof cmd.text !== 'string' || !cmd.text.trim() || cmd.text.length > 10000) throw new AppError('修订内容无效。');
      if (item.text !== cmd.text) { rememberReport(report);item.text = cmd.text; item.confirmed = false; item.edited = true; }
    }
  } else if (cmd.action === 'deleteAudio') {
    if (state.jobs.some(j => ['queued','processing','loading-model','transcribing'].includes(j.stage))) throw new AppError('正在转写，完成后可删除。', 409);
    const audioId=state.audio?.id;
    state.transcriptVersions.forEach(t=>{if(t.audio?.id===audioId)t.audio.deleted=true;});
    state.jobs.forEach(j=>{if(j.audio?.id===audioId)j.audio.deleted=true;});
    state.audio = null;state.audioGeneration++; invalidateReports(state);
  } else throw new AppError('未知课堂操作。', 400);
  return state;
}
function rememberReport(report){(report.history ||= []).push({id:id(),createdAt:new Date().toISOString(),sections:clone(report.sections)});}
export function validateReportSections(raw, segments, sectionKeys = Object.keys(REPORT_SECTIONS)) {
  const ids = new Set(segments.map(s => s.id)), sections = {};
  for (const key of Object.keys(REPORT_SECTIONS)) {
    if (!sectionKeys.includes(key)) { sections[key]=[];continue; }
    if (!Array.isArray(raw?.[key]) || raw[key].length > 100) throw new AppError('AI 报告分类缺失或条目超限。', 502);
    sections[key] = raw[key].map(item => {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 10000 || !Array.isArray(item.evidenceIds) || !item.evidenceIds.length || item.evidenceIds.some(i => !ids.has(i))) throw new AppError('AI 结论缺少有效原文证据，未提交报告。', 502);
      if (!['transcript', 'teacher-emphasis', 'ai-inference', 'hypothesis', 'timing-estimate'].includes(item.kind)) throw new AppError('AI 未标注结论类型。', 502);
      if (key === 'difficulties' && item.kind !== 'hypothesis') throw new AppError('潜在难点必须标为推测。', 502);
      if (key === 'emphasis' && !['teacher-emphasis','ai-inference'].includes(item.kind)) throw new AppError('教学重点須区分原文强调与 AI 归纳。', 502);
      if (/学生.{0,12}(已掌握|没听懂|已经理解|掌握得|专注|注意力)|全班.{0,8}(听懂|理解|掌握)|抬头率|注意力回落|投入回升|质量总分|测得.{0,8}(语调|响度)/.test(item.text)) throw new AppError('AI 返回了无法由转写支持的结论，未提交报告。', 502);
      let timeEvidence;
      if(item.kind==='timing-estimate'){
        if(!Array.isArray(item.timeEvidence)||!item.timeEvidence.length||item.timeEvidence.length>3)throw new AppError('时间判断须提供timeEvidence起止片段与计算方式，不能只引用几个离散片段。',502);
        if(/连续(?:讲授|讲解|发言).{0,12}\d+\s*(?:秒|分钟)/.test(item.text))throw new AppError('转写时间不能证明连续讲授，请描述讲解跨度（含片段间隔）并给出起止依据。',502);
        timeEvidence=item.timeEvidence.map(range=>{
          const first=segments.find(s=>s.id===range.startId),last=segments.find(s=>s.id===range.endId);
          if(!first||!last||!['transcript-span','segment-gap'].includes(range.basis))throw new AppError('时间判断的起止片段或计算方式无效。',502);
          const start=range.basis==='segment-gap'?first.end:first.start,end=range.basis==='segment-gap'?last.start:last.end;
          if(end<=start)throw new AppError('时间判断区间无效，请核对起止顺序。',502);
          return {startId:first.id,endId:last.id,basis:range.basis,start,end,seconds:Math.round((end-start)*1000)/1000};
        });
      }
      return { id: id(), text: item.text, evidenceIds: [...new Set([...item.evidenceIds,...(timeEvidence||[]).flatMap(r=>[r.startId,r.endId])])], kind: item.kind, confirmed: false, edited: false,...(timeEvidence?{timeEvidence}:{}) };
    });
  }
  return sections;
}
export function buildClassroomReport(state) {
  const report = reportOf(state);
  if (!report) throw new AppError('尚无分析报告。');
  const transcript = state.transcriptVersions.find(v => v.id === report.transcriptId);
  const lines = ['# 课堂音频复盘报告', '', `课程：${report.course.title || '未命名'}`, `课程说明：${report.course.description}`, `转写版本：${report.transcriptId}`, `课程说明版本：${report.courseVersion}`, `报告状态：${report.stale ? '待更新（输入已改变）' : '当前输入'}；条目确认状态见下文`, '', '分析整段录音；未区分全部教师与学生发言。时间节奏基于识别片段范围，不代表精确静音或声学测量。', ''];
  for (const [key, title] of Object.entries(REPORT_SECTIONS)) {
    if (!report.sections[key]?.length) continue;
    lines.push('## ' + title, '');
    for (const item of report.sections[key]) {
      lines.push(`- [${item.confirmed && !report.stale ? '已确认' : '待确认'} · ${item.kind}${item.edited ? ' · 教师修订' : ''}] ${item.text}`);
      for(const range of item.timeEvidence||[])lines.push(`  - 时间依据 ${formatTime(range.start)}—${formatTime(range.end)}：${range.basis==='segment-gap'?'识别片段间隔，不代表精确静音':'讲解跨度，含片段间隔，不代表连续发言'}（约${Math.round(range.seconds)}秒）。`);
      for (const eid of item.evidenceIds) { const s = transcript?.segments.find(s => s.id === eid); if (s) lines.push(`  - 依据 ${formatTime(s.start)}—${formatTime(s.end)}（${s.id}，${s.timestampSource}）：${s.text}`); }
    }
    lines.push('');
  }
  return lines.join('\n');
}
