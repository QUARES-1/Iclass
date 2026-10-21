import path from 'node:path';
import QRCode from 'qrcode';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { FeedbackService } from './feedbackService.js';
import { FeedbackAgent, publicFeedbackJob } from './feedbackAgent.js';
import { AppError } from './store.js';
import { defaultTemplate, LIMITS, validId } from './feedbackDomain.js';

export function createFeedbackApi(options){
  const {store,json,bodyJSON:parseBody}=options,service=new FeedbackService(options),agent=new FeedbackAgent(service);
  const bodyJSON=async req=>{const value=await parseBody(req);if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('请求体须为 JSON 对象。',400);return value;};
  let ready;
  const handler=async (req,res,url)=>{
    if(!url.pathname.startsWith('/api/feedback'))return false;
    ready ||= service.recover();await ready;
    if(options.lessonContext){
      const lesson=await options.lessonContext();
      const existing=await store.read('feedback-class-'+lesson.id,null);
      if(!existing)await service.create({title:lesson.title,date:lesson.date});
      if(url.pathname==='/api/feedback/samples')throw new AppError('请在历史工作区体验独立样例；当前课次保持自己的反馈。',400);
      if(url.pathname==='/api/feedback/sessions'&&req.method==='POST')throw new AppError('本课次已包含反馈记录，请在课程页新建课次。',409);
      let c=await service.refreshReferences(lesson.id);
      if(c.publish.status==='pending'&&!c.publish.token&&(await service.config()).accessToken)service.launchPublish(c.id);
      if(!c.source&&!c.sourceOptOut){const audio=await store.read('classroom',null);if(audio?.currentTranscriptId){try{c=await service.command(c.id,{revision:c.revision,action:'linkAudio',transcriptId:audio.currentTranscriptId,reportId:audio.currentReportId});}catch(error){if(error.statusCode!==409)throw error;}}}
    }
    const p=url.pathname,post=req.method==='POST',get=req.method==='GET';
    const send=value=>{json(res,value);return true;};
    if(p==='/api/feedback/bootstrap'&&get)return send({sessions:await service.list(),templates:await service.templates(),config:service.publicConfig(await service.config()),limits:LIMITS});
    if(p==='/api/feedback/default-template'&&get)return send(await defaultTemplate());
    if(p==='/api/feedback/templates'&&post)return send(await service.saveTemplate(await bodyJSON(req)));
    if(p==='/api/feedback/settings'&&get)return send(service.publicConfig(await service.config()));
    if(p==='/api/feedback/settings'&&post)return send(await service.saveConfig(await bodyJSON(req)));
    if(p==='/api/feedback/settings/test'&&post)return send(await service.testConfig(await bodyJSON(req)));
    if(p==='/api/feedback/sessions'&&post)return send(service.public(await service.create(await bodyJSON(req))));
    if(p==='/api/feedback/samples'&&post){await bodyJSON(req);return send(await service.sampleClasses());}
    const handoff=p.match(/^\/api\/feedback\/handoffs\/([a-f0-9]{64})$/);
    if(handoff&&get)return send(await service.getHandoff(handoff[1]));
    const route=p.match(/^\/api\/feedback\/sessions\/([a-f0-9-]{36})(?:\/(records|preview|import|chat|handoff|job|report|evidence|audio|qr))?$/);
    if(!route)throw new AppError('反馈接口不存在。',404);
    const classId=route[1],action=route[2],c=await service.refreshReferences(classId);
    if(!action&&get)return send(service.public(c));
    if(!action&&post){const body=await bodyJSON(req);if(options.lessonContext&&body.action==='delete')throw new AppError('请在课程页归档本课次，保留相关教学记录。',409);return send(service.public(await service.command(classId,body)));}
    if(action==='qr'&&get){
      if(c.publish.status!=='published'||!c.publish.url)throw new AppError('问卷尚未发布。',404);
      const png=await QRCode.toBuffer(c.publish.url,{width:320,margin:2});
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);return true;
    }
    if(action==='records'&&get){
      const search=(url.searchParams.get('q')||'').trim().slice(0,500).toLocaleLowerCase(),value=Number(url.searchParams.get('offset')),offset=Number.isSafeInteger(value)&&value>=0?value:0;
      const questions=new Map((c.publish.template||c.template).questions.map(q=>[q.id,{label:q.label,options:new Map((q.options||[]).map(o=>[o.id,o.label]))}]));
      const all=c.records.filter(r=>!search||[r.id,JSON.stringify(r.answers),...Object.entries(r.answers).map(([key,value])=>{const q=questions.get(key);return (q?.label||key)+' '+[value].flat().map(v=>q?.options.get(v)||v).join(' ');})].join('\n').toLocaleLowerCase().includes(search));
      return send({total:all.length,offset,records:all.slice(offset,offset+50),template:c.publish.template||c.template});
    }
    if(action==='preview'&&post)return send(await service.previewImport(classId,await bodyJSON(req)));
    if(action==='import'&&post){const b=await bodyJSON(req);return send(service.public(await service.commitImport(classId,b.revision,b.previewId,b.validOnly)));}
    if(action==='chat'&&post){json(res,await agent.start(classId,await bodyJSON(req)),202);return true;}
    if(action==='handoff'&&post)return send(await service.handoff(classId,await bodyJSON(req)));
    if(action==='job'){
      const jobId=get?url.searchParams.get('id'):(await bodyJSON(req));
      if(get){if(!validId(jobId))return send(null);const j=await store.read('feedback-job-'+jobId,null);if(j?.classId!==classId)throw new AppError('任务不存在。',404);return send(publicFeedbackJob(j));}
      if(post){if(jobId.action==='resume'&&options.feedbackRateLimit?.(req))throw new AppError('模型请求过于频繁，请一分钟后重试。',429);return send(await agent.control(classId,jobId.id,jobId.action));}
    }
    if(action==='report'&&get){
      const markdown=await service.reportMarkdown(classId,url.searchParams.get('id'),url.searchParams.get('version'));
      res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="feedback-report.md"'});res.end(markdown);return true;
    }
    if(action==='evidence'&&get){
      const r=c.reports.find(r=>r.id===url.searchParams.get('reportId'));if(!r)throw new AppError('报告不存在。',404);
      const input=await service.readInput(r.inputId);
      return send({template:input.template,course:input.course,stats:input.stats,records:input.records,segments:input.source?.transcript?.segments||[],ppt:input.ppt,teachingResources:input.teachingResources||[],findings:r.findings});
    }
    if(action==='audio'&&get){
      const report=c.reports.find(r=>r.id===url.searchParams.get('reportId'));
      if(url.searchParams.has('reportId')&&!report)throw new AppError('报告不存在。',404);
      const snapshot=report?await service.readInput(report.inputId):null;
      const source=report?snapshot?.source:(c.source?await store.read('feedback-source-'+c.source.id,null):null),audio=source?.audio;
      if(!audio||audio.deleted)throw new AppError('原音频不存在或已删除。',404);
      const filename=audio.playbackFile||audio.file;
      if(!/^[a-f0-9-]+(?:\.(?:wav|mp3|m4a|webm|ogg)|\.play\.mp3)$/.test(filename||''))throw new AppError('音频引用无效。',404);
      const file=path.join(store.root,'audio',filename),info=await stat(file).catch(()=>{throw new AppError('原音频已删除，转写依据仍保留。',404);});
      let start=0,end=info.size-1,status=200;
      if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)throw new AppError('音频范围无效。',416);start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end||start>=info.size)throw new AppError('音频范围无效。',416);status=206;}
      res.writeHead(status,{'Content-Type':({'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.webm':'audio/webm','.ogg':'audio/ogg'})[path.extname(filename)],'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':'bytes '+start+'-'+end+'/'+info.size}:{})});const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
    }
    throw new AppError('请求方法不支持。',405);
  };
  handler.isBusy=()=>Boolean(service.runs.size||service.connectionBusy||service.connectionQueue.length);
  handler.resetRecovery=()=>{ready=undefined;};
  return handler;
}
