// Pure classroom display helpers shared with the browser.
export const REPORT_SECTIONS = { summary: '统一总结', knowledge: '核心知识点', emphasis: '教学重点', difficulties: '潜在难点（推测）', observations: '表达与时间节奏观察', suggestions: '改进建议' };
export const CLASSROOM_TERMINAL_STAGES = ['completed','failed','paused','cancelled'];
export const hasClassroomTask = state => state.jobs.some(j => !CLASSROOM_TERMINAL_STAGES.includes(j.stage));
export const analysisSegments = transcript => (transcript?.segments || []).filter(s => !s.excluded && s.text.trim());
export const transcriptLabel=transcript=>({asr:'真实识别原稿',teacher:'教师校正版',simplified:'简体转写（原稿保留）',legacy:'旧转写（人工时间）'}[transcript?.source]||'转写版本');
export function transcriptText(transcript,{timestamps=false}={}){
  const segments=transcript?.segments||[];
  const time=seconds=>{const n=Math.max(0,Math.floor(seconds));return (Math.floor(n/3600)?Math.floor(n/3600)+':':'')+String(Math.floor(n/60)%60).padStart(2,'0')+':'+String(n%60).padStart(2,'0');};
  if(timestamps)return segments.map(s=>`[${time(s.start)}—${time(s.end)}]${s.excluded?'【已排除误识别，保留记录】':''} ${s.text}`).join('\n');
  const paragraphs=[];let words=[],length=0,start;
  for(const s of segments){
    if(words.length&&(length+s.text.length>450||s.start-start>=60||s.excluded)){paragraphs.push(words.join(' '));words=[];length=0;}
    if(s.excluded){paragraphs.push(`【已排除误识别 ${time(s.start)}—${time(s.end)}】${s.text}`);continue;}
    if(!words.length)start=s.start;words.push(s.text);length+=s.text.length;
  }
  if(words.length)paragraphs.push(words.join(' '));
  return paragraphs.join('\n\n');
}
export function textObservations(segments = []) {
  segments = segments.filter(s => !s.excluded && s.text.trim());
  const chars = segments.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
  const span = segments.reduce((n, s) => n + s.end - s.start, 0);
  return { chars, questions: segments.filter(s => /[?？]|为什么|如何|是否/.test(s.text)).length, estimatedCharsPerMinute: span > 0 ? Math.round(chars / span * 60) : null,
    basis: '字数除以识别片段时间跨度，包含片段内停顿；仅是文本节奏估算，不是声学测量。',
    gaps: segments.slice(1).flatMap((s, i) => s.start - segments[i].end >= 2 ? [{ start: segments[i].end, end: s.start, evidenceIds: [segments[i].id, s.id] }] : []),
  };
}
