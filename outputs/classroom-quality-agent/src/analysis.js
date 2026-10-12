import { requestJSON } from './model.js';
import { validateReportSections, REPORT_SECTIONS, textObservations, analysisSegments } from './classroom.js';
import { AppError } from './store.js';
import { DEFAULT_PROMPTS, CLASSROOM_CONTRACT } from './prompts.js';
export function partitionTranscript(segments, maxChars = 8500, maxSerializedChars = 90000) {
  const parts = []; let part = [], size = 0, serializedSize = 0;
  for (const s of segments) {
    const segmentSize=JSON.stringify(s).length+1, previous=part.at(-1);
    const gapSize=previous && s.start-previous.end>=2 ? JSON.stringify({start:previous.end,end:s.start,evidenceIds:[previous.id,s.id]}).length+1 : 0;
    if(segmentSize>maxSerializedChars)throw new AppError('单个转写片段与课程说明超出模型输入限制，请缩短该片段的校正文字或课程说明。');
    if (part.length && (size+s.text.length>maxChars || serializedSize+segmentSize+gapSize>maxSerializedChars)) {
      parts.push(part); part=[]; size=0; serializedSize=0;
    }
    // A valid corrected segment may exceed the soft text budget. Keep its
    // original evidence ID and times in one part rather than asking for a
    // segment split that the correction interface cannot perform.
    serializedSize+=segmentSize+(part.length ? gapSize : 0);
    part.push(s); size+=s.text.length;
  }
  if (part.length) parts.push(part);
  return parts;
}
export async function analyzeClassroom(course, transcript, call = requestJSON, progress = async () => {}, config = {}, options = {}) {
  const check=()=>{if(config.signal?.aborted)throw new AppError('任务已暂停，已完成分析保留。',499);};
  transcript={...transcript,segments:analysisSegments(transcript)};
  const mode=options.mode ?? 'overview';
  const requestedSections=mode==='overview'?['summary','suggestions']:options.requestedSections;
  if(!['overview','details'].includes(mode)||!Array.isArray(requestedSections)||!requestedSections.length||requestedSections.some(k=>!REPORT_SECTIONS[k]))throw new AppError('分析范围无效。',400);
  const prompt = (config.prompts?.classroom ?? DEFAULT_PROMPTS.classroom) + '\n\n' + CLASSROOM_CONTRACT;
  const base={course,mode,requestedSections,request:options.request||''};
  const budget=(config.maxInputChars??115000)-prompt.length-JSON.stringify(base).length-2500;
  const chunks = partitionTranscript(transcript.segments,8500,budget), partials = [];
  const restored=options.checkpoint?.partials||[];
  for(let i=0;i<restored.length;i++){
    if(!chunks[i]||JSON.stringify(restored[i].ids)!==JSON.stringify(chunks[i].map(s=>s.id)))throw new AppError('转写已变化，不能沿用旧分析进度。',409);
    partials.push(restored[i]);
  }
  if(!chunks.length)throw new AppError('尚无有效转写，请先完成转写再分析。');
  async function readSections(system,input,segments){
    let feedback='',completeCandidate;
    function overviewLayout(sections){
      const summary=sections.summary;
      if(summary.length>1){
        const text=summary.map(item=>item.text).join('\n\n');
        if(text.length>10000)throw new AppError('整体总结内容超过安全保存限制，请缩小分析要求。',502);
        sections={...sections,summary:[{...summary[0],text,kind:summary.every(i=>i.kind===summary[0].kind)?summary[0].kind:'ai-inference',evidenceIds:[...new Set(summary.flatMap(i=>i.evidenceIds))],timeEvidence:summary.flatMap(i=>i.timeEvidence||[])}]};
      }
      return sections;
    }
    for(let attempt=0;attempt<2;attempt++){
      check();
      let received=false;
      try{
        const result=await call(system,{...base,...input,feedback},config);
        received=true;
        let sections=validateReportSections(result.sections,segments,requestedSections);
        if(mode==='overview'&&!sections.summary.length)throw new AppError('报告缺少统一总结。',502);
        if(mode==='overview'){
          const layoutIssues=[];
          if(sections.summary.length>1)layoutIssues.push(`summary返回${sections.summary.length}条，须合并为一个整体总结`);
          if(layoutIssues.length){
            completeCandidate=overviewLayout(sections);
            if(!attempt)throw new AppError('分析条目过多：'+layoutIssues.join('；')+'。总结用自然段，不罗列分段摘要。',502);
            sections=completeCandidate;
          }
        }
        const excessive=[];
        for(const key of requestedSections){
          if(key==='suggestions')continue;
          const count=mode==='overview'?1:5,limit=mode==='overview'?1000:400;
          if(sections[key].length>count)throw new AppError(`分析条目过多：${key}返回${sections[key].length}条，最多${count}条。请合并共同主线并保留最重要建议，不拼接分段摘要。`,502);
          sections[key].forEach((item,i)=>{if(item.text.length>limit)excessive.push(`${key}第${i+1}条为${item.text.length}字符，建议不超过${limit}字符`);});
        }
        // Readability targets are soft. Keep complete validated output after
        // one compacting attempt rather than fail the entire lesson on length.
        if(excessive.length&&!attempt){
          completeCandidate=sections;
          throw new AppError('分析过长：'+excessive.join('；')+'。请精简文字，仍须返回完整JSON和有效原文证据；只生成'+requestedSections.join('、')+'，不截断句子。',502);
        }
        return sections;
      }catch(error){
        check();
        if(attempt){if(completeCandidate)return completeCandidate;throw error;}
        if(!received&&!completeCandidate&&!['MODEL_LENGTH','MODEL_FORMAT'].includes(error.code))throw error;
        feedback=error.message;
      }
    }
  }
  for (let i = partials.length; i < chunks.length; i++) {
    check();
    await progress({ stage: 'analyzing', completedParts: i, totalParts: chunks.length, coveredIds: partials.flatMap(p => p.ids) });
    try {
      const prior=i?chunks[i-1].at(-1):null;
      const previous=prior?{...prior,text:prior.text.slice(-400),previewOnly:prior.text.length>400}:null;
      const observations=textObservations(chunks[i]);
      const boundary=previous&&chunks[i][0].start-previous.end>=2?{start:previous.end,end:chunks[i][0].start,evidenceIds:[previous.id,chunks[i][0].id]}:null;
      if(boundary)observations.gaps.unshift(boundary);
      const evidenceSegments=previous?[previous,...chunks[i]]:chunks[i];
      const sections=await readSections(prompt,{part:i+1,totalParts:chunks.length,segments:chunks[i],...(previous?{previousBoundarySegment:previous}:{}),textObservations:observations},evidenceSegments);
      partials.push({ ids: chunks[i].map(s => s.id), sections });
      await progress({completedParts:partials.length,totalParts:chunks.length,checkpoint:{partials}});
    } catch (error) { throw new AppError(`第 ${i + 1}/${chunks.length} 段分析失败，未生成不完整报告。${error.message}`, error.statusCode || 502); }
  }
  let sections = partials[0].sections;
  if (partials.length > 1) {
    await progress({ stage: 'summarizing', completedParts: chunks.length, totalParts: chunks.length, coveredIds: transcript.segments.map(s => s.id) });
    let summaries=partials.map((p,i)=>({ids:[...new Set(Object.values(p.sections).flatMap(items=>items.flatMap(item=>item.evidenceIds)))],sections:p.sections,coverage:[{part:i+1,segmentCount:chunks[i].length,start:chunks[i][0].start,end:chunks[i].at(-1).end}]}));
    const summaryPrompt=prompt+'\n综合所有分段的共同主线与最主要的问题，给出统一结论，不罗列分段摘要，不追加原分段条目。完整分析覆盖范围见coverage；仅用代表证据支持结论。';
    try {
      while(summaries.length>1){
        check();
        const groups=[];let group=[];
        for(const item of summaries){
          const trial=[...group,item],chars=summaryPrompt.length+JSON.stringify({...base,partials:trial,coverage:trial.flatMap(p=>p.coverage),feedback:''}).length;
          if(chars>(config.maxInputChars??115000)-1000&&group.length){groups.push(group);group=[];}
          group.push(item);
        }
        if(group.length)groups.push(group);
        if(groups.every(g=>g.length===1))throw new AppError('统一总结所需上下文超出输入额度，请提高输入额度。',413);
        const next=[];
        for(const parts of groups){
          if(parts.length===1){next.push(parts[0]);continue;}
          const merged=await readSections(summaryPrompt,{partials:parts,coverage:parts.flatMap(p=>p.coverage)},transcript.segments);
          next.push({ids:[...new Set(Object.values(merged).flatMap(items=>items.flatMap(item=>item.evidenceIds)))],sections:merged,coverage:parts.flatMap(p=>p.coverage)});
        }
        summaries=next;
      }
      sections=summaries[0].sections;
    } catch(error) { throw new AppError('整课汇总失败，录音与转写保留，未提交不完整报告。'+error.message,error.statusCode || 502); }
  }
  return { sections, coverage: partials.map(p => ({ ids: p.ids, status: 'complete' })), source: 'llm', mode, detailSections:mode==='details'?requestedSections:[] };
}
