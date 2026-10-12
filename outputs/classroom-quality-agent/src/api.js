import path from 'node:path';
import { mkdir, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, AppError, id, clone } from './store.js';
import { emptyWorkspace, applyWorkspaceCommand, findResource, currentVersion, createResource, commitResource, applyPptOperations } from './workspace.js';
import { emptyClassroom, migrateClassroom, transcriptOf, reportOf, applyClassroomCommand, invalidateReports, validateSegments, buildClassroomReport, CLASSROOM_TERMINAL_STAGES, analysisSegments, hasClassroomTask } from './classroom.js';
import {simplifiedTranscript} from './chineseText.js';
import { requestJSON } from './model.js';
import { analyzeClassroom } from './analysis.js';
import { speechCommand } from './speech.js';
import { renderActivity } from './interactive.js';
import { loadSampleWorkspace } from './sampleWorkspace.js';
import { validateActivity } from './interactive.js';
import { checkActivityRuntime } from './runtimeCheck.js';
import { audioLimits } from './uploadPolicy.js';
import { ModelSettings, validateModelSettings } from './modelSettings.js';
import { newAgentJob, runTeachingAgent, publicAgentJob, commitAgentDrafts, checkAgentBase } from './agent.js';
import {checkCodeSyntax} from './codeCheck.js';
import {classroomConversation} from './classroomConversation.js';

export const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
export async function bodyJSON(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 6 * 1024 * 1024) throw new AppError('请求内容超过 6 MB。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new AppError('请求体不是有效的 JSON。', 400); }
}
export function createApi(root, { dataDir = process.env.DATA_DIR || path.join(root, 'data'), modelCall = requestJSON, speechCall = (...args) => speechCommand(root, ...args), runtimeCheck = checkActivityRuntime, modelSettings = new ModelSettings(dataDir) } = {}) {
  const store = new Store(dataDir), audioDir = path.join(store.root, 'audio');
  const agentRuns = new Map();
  const classroomRuns = new Map(), pendingAudio = new Set();
  const activeClassJob=j=>!CLASSROOM_TERMINAL_STAGES.includes(j.stage);
  let speechQueue = Promise.resolve();
  const ws = () => store.read('workspace', emptyWorkspace());
  const classroom = async () => migrateClassroom(await store.read('classroom', emptyClassroom()));
  const saveClass = (revision, change) => store.update('classroom', revision, emptyClassroom(), async raw => change(migrateClassroom(raw)));
  let ready;
  const recoverInterrupted = async () => {
    const s = await classroom();
    if (s.jobs.some(activeClassJob)) await saveClass(undefined, c => { c.jobs.forEach(j => { if (activeClassJob(j)) { j.stage = j.input?'paused':'failed'; j.error = j.input?'服务重启，已完成分段保留，可继续任务。':'服务重启导致任务中断，已有数据保留，请重试。'; } }); return c; });
    const w = await ws();
    const recoveries = new Map();
    for (const m of w.messages.filter(m => m.role === 'user' && m.jobId)) {
      const job = await store.read('agent-' + m.jobId, null);
      if (job && !['completed','failed','paused'].includes(job.stage)) {
        job.stage = m.status === 'complete' ? 'completed' : 'paused'; job.detail = '服务重启，任务草稿已保留，可以继续。';
        await saveAgentJob(job); recoveries.set(m.id, job.stage);
      }
    }
    if (w.messages.some(m => m.status === 'processing')) await store.update('workspace', undefined, emptyWorkspace(), c => { c.messages.forEach(m => { if (m.status === 'processing') { m.status = m.jobId ? recoveries.get(m.id) === 'completed' ? 'complete' : 'paused' : 'failed'; m.error = m.jobId ? '服务重启，已完成草稿保留，可继续任务。' : '服务重启，请重试。'; } }); return c; });
  };
  async function saveAgentJob(job) {
    const saved = await store.update('agent-' + job.id, undefined, job, () => clone(job));
    job.revision = saved.revision; job.savedAt = saved.savedAt; return saved;
  }
  async function readAgentContext(kind, jobId, excludeId) {
    const state = await ws();
    if (kind === 'workspace') return state;
    const messages=state.messages.filter(m=>m.role==='user'&&m.jobId&&m.jobId!==excludeId);
    const allIds=[...new Set(messages.map(m=>m.jobId))];
    if (jobId && !allIds.includes(jobId)) throw new AppError('当前对话中不存在该任务。');
    const taskMessages=messages.filter(m=>m.mode==='task'||!m.mode);
    const ids=[...new Set([...taskMessages.slice(-8).map(m=>m.jobId),...taskMessages.filter(m=>m.status==='processing').map(m=>m.jobId)])];
    const tasks = [];
    for (const taskId of jobId ? [jobId] : ids) {
      const task = await store.read('agent-' + taskId, null);
      if (task) { const visible = publicAgentJob(task); tasks.push({id:task.id,request:task.request,mode:task.mode || 'task',stage:task.stage,detail:task.detail,
        completedBatches:visible.completedBatches,totalBatches:visible.totalBatches,draftPages:visible.draftPages,draftResources:visible.draftResources,error:task.error}); }
    }
    return tasks;
  }
  async function claimAgentTask(job) {
    await store.update('workspace', undefined, emptyWorkspace(), c => {
      const other = c.messages.find(m => m.id !== job.messageId && m.status === 'processing' && (m.mode === 'task' || !m.mode));
      if (other) throw new AppError('已有任务正在执行。可以继续聊天或查看进度；请等待或先暂停，再执行新的修改。', 409);
      const message = c.messages.find(m => m.id === job.messageId);
      if (!message) throw new AppError('这轮对话已移除，未启动操作。', 409);
      message.mode = 'task'; return c;
    }, {skipUnchanged:true});
  }
  async function finishCandidate(job, candidate, signal) {
    if (!candidate || typeof candidate.reply !== 'string' || !['agent-commit','create','update','attach','reply','advice','clarify'].includes(candidate.action)) throw new AppError('AI 操作结构无效，原成果保留。', 502);
    const conversational = ['reply','advice','clarify'].includes(candidate.action);
    const originalResource = job.input.resources.find(r => r.id === job.resourceId);
    let runtimeValidation;
    if ((candidate.action === 'create' && candidate.type !== 'ppt') || (candidate.action === 'update' && originalResource?.type !== 'ppt')) {
      candidate.content = validateActivity(candidate.content); runtimeValidation = await runtimeCheck(candidate.content);
    }
    return store.update('workspace', undefined, emptyWorkspace(), c => {
      if(signal?.aborted)throw new AppError('任务已暂停，草稿保留。',499);
      if (!conversational) checkAgentBase(c, job);
      let target = null, produced = null, summary = '';
      if (candidate.action === 'agent-commit') ({ target, produced, summary } = commitAgentDrafts(c, job));
      else if (candidate.action === 'create') {
        if (job.resourceId && !/新建|另建|创建/.test(job.request) && !(candidate.type !== originalResource.type && /生成|制作/.test(job.request))) throw new AppError('请求为修改，AI 却返回了新建资源；原成果保留，请重试。');
        target = createResource(c, candidate.type, candidate.name, candidate.content); produced = currentVersion(target); summary = '新增资源：' + target.name;
      } else if (candidate.action === 'update') {
        target = findResource(c, job.resourceId);
        if (target.type === 'ppt') { const edit = applyPptOperations(target, candidate.operations, candidate.scopeIds); produced = commitResource(target, edit.content, edit.summary, 'llm'); summary = edit.summary; }
        else { const previous = currentVersion(target).content, changed = Object.keys(candidate.content).filter(k => JSON.stringify(previous[k]) !== JSON.stringify(candidate.content[k])); summary = '修改互动字段：' + changed.join('、') + '。请试玩当前版本。'; produced = commitResource(target, candidate.content, summary, 'llm'); }
      } else if (candidate.action === 'attach') {
        target = findResource(c, candidate.pptId); applyWorkspaceCommand(c, { action: 'attach', resourceId: target.id, baseVersionId: target.currentVersionId, activityId: candidate.activityId, slideId: candidate.slideId });
        c.selectedId = target.id; produced = currentVersion(target); summary = '已将指定版本互动资源关联到 PPT 页面。';
      }
      if (produced && runtimeValidation) produced.runtimeValidation = runtimeValidation;
      const message = c.messages.find(m => m.id === job.messageId); if (!message) throw new AppError('任务对话已被移除，未提交旧成果。', 409);
      message.status = 'complete'; message.mode = conversational ? 'conversation' : 'task'; delete message.error;
      c.messages.push({ id: id(), role: 'assistant', text: candidate.reply, summary, status: 'complete', mode: message.mode, resourceId: target?.id || null, versionId: produced?.id || null, ...(message.jobId ? { jobId: job.id } : {}) });
      return c;
    });
  }
  async function executeAgent(job, controller) {
    try {
      const config = await modelSettings.read(); job.configRevision = config.revision; job.model = config.model;
      const candidate = await runTeachingAgent(job, { config, call: modelCall, runtimeCheck, codeCheck:checkCodeSyntax,checkpoint: saveAgentJob,
        readContext:(kind,id)=>readAgentContext(kind,id,job.id),claimTask:claimAgentTask, signal: controller.signal });
      if (controller.signal.aborted) throw Object.assign(new AppError('任务已暂停，草稿保留。', 499), { code: 'AGENT_PAUSED' });
      const conversational = ['reply','advice','clarify'].includes(candidate.action);
      job.stage = 'committing'; job.detail = conversational ? '正在保存回复' : '检查通过，保存新版本'; await saveAgentJob(job);
      await finishCandidate(job, candidate, controller.signal);
      job.stage = 'completed'; job.detail = conversational ? '已回复' : '成果已保存，请检查并确认。'; job.finishedAt = new Date().toISOString(); delete job.error; await saveAgentJob(job);
    } catch (error) {
      job.stage = controller.signal.aborted || error.code === 'AGENT_PAUSED' ? 'paused' : 'failed'; job.error = error.message; job.detail = job.mode === 'conversation' ? '本轮对话已停止，可重试' : job.stage === 'paused' ? '任务已暂停，草稿保留' : '任务暂未完成，草稿保留';
      await saveAgentJob(job);
      await store.update('workspace', undefined, emptyWorkspace(), c => { const m = c.messages.find(m => m.id === job.messageId); if (m) { m.status = job.stage; m.error = error.message; } return c; });
    } finally { agentRuns.delete(job.id); }
  }
  function launchAgent(job) { const controller = new AbortController(); agentRuns.set(job.id, controller); void executeAgent(job, controller).catch(() => agentRuns.delete(job.id)); }
  const updateJob = (jobId, patch) => saveClass(undefined, c => { const job = c.jobs.find(j => j.id === jobId); if (job && !['paused','cancelled','completed'].includes(job.stage)) { Object.assign(job, patch); if (patch.stage && patch.stage !== 'failed') delete job.error; } return c; });
  const progressKey=jobId=>'classroom-progress-'+jobId;
  const speechCheckpoint=jobId=>path.join(store.root,'classroom-asr-'+jobId+'.json');
  function launchClassroom(job,input){
    const controller=new AbortController();
    const task=job.type==='transcribe'?speechQueue.catch(()=>{}).then(()=>runTranscription(job.id,input.audio,controller.signal)):runAnalysis(job.id,input,controller.signal);
    if(job.type==='transcribe')speechQueue=task.catch(()=>{});
    classroomRuns.set(job.id,{controller,task});
    task.finally(()=>{if(classroomRuns.get(job.id)?.controller===controller)classroomRuns.delete(job.id);}).catch(()=>{});
  }
  async function runTranscription(jobId, audio, signal) {
    try {
      signal.throwIfAborted();await mkdir(store.root,{recursive:true});
      await updateJob(jobId, { stage: 'processing' });
      const result = await speechCall('transcribe', path.join(audioDir, audio.file), async e => { if(signal.aborted)return;if(e.stage==='chunk-complete')await updateJob(jobId,{completedParts:e.completedParts,totalParts:e.totalParts});else if (['processing','loading-model','transcribing'].includes(e.stage)) await updateJob(jobId, { stage: e.stage, chunkStart: e.chunkStart, chunkEnd: e.chunkEnd }); },{signal,checkpointPath:speechCheckpoint(jobId)});
      const segments = validateSegments(result.segments, audio.duration, 'whisper-word-alignment+chunk-offset');
      await saveClass(undefined, c => {
        signal.throwIfAborted();
        if (c.audio?.id !== audio.id) throw new AppError('录音已变更，未将旧转写覆盖到新录音。', 409);
        const v = { id: id(), audioId: audio.id, audio: clone(audio), source: 'asr', original: true, segments, createdAt: new Date().toISOString(), processing: { chunks: result.chunks, elapsedSeconds: result.elapsedSeconds, model: result.model, device: result.device, computeType: result.computeType, peakResidentBytes: result.peakResidentBytes } };
        c.transcriptVersions.push(v); c.currentTranscriptId = v.id; invalidateReports(c);
        const normalized=simplifiedTranscript(v);
        if(normalized){c.transcriptVersions.push(normalized);c.currentTranscriptId=normalized.id;}
        const job = c.jobs.find(j => j.id === jobId);
        Object.assign(job, { stage: 'completed', resultId: c.currentTranscriptId,originalResultId:v.id }); delete job.error; return c;
      });
      await rm(speechCheckpoint(jobId),{force:true});
    } catch (error) { if(!signal.aborted)await updateJob(jobId, { stage: 'failed', error: error.message }); }
  }
  async function runAnalysis(jobId, input, signal) {
    try {
      signal.throwIfAborted();
      const checkpoint=await store.read(progressKey(jobId),null);
      const result = await analyzeClassroom(input.course, input.transcript, modelCall, async patch => {
        const {checkpoint,...visible}=patch;
        if(checkpoint)await store.update(progressKey(jobId),undefined,{},()=>checkpoint);
        if(!signal.aborted)await updateJob(jobId,visible);
      }, {...input.modelConfig,signal}, {...input.options,checkpoint});
      await saveClass(undefined, c => {
        signal.throwIfAborted();
        if (c.currentTranscriptId !== input.transcript.id || c.courseVersion !== input.courseVersion || c.audio?.id !== input.audioId) throw new AppError('分析期间输入已更新，原报告保留，请重新分析。', 409);
        if(input.baseReport && (c.currentReportId!==input.baseReport.id || JSON.stringify(reportOf(c)?.sections)!==JSON.stringify(input.baseReport.sections)))throw new AppError('分析期间报告已修订，未覆盖教师修改，请重新生成细分内容。',409);
        const r = { id: id(), transcriptId: input.transcript.id, courseVersion: input.courseVersion, course: input.course, ...result, stale: false, createdAt: new Date().toISOString() };
        if(input.baseReport){
          r.sections=clone(input.baseReport.sections);
          for(const key of input.options.requestedSections)r.sections[key]=result.sections[key];
          r.mode='overview';r.parentReportId=input.baseReport.id;r.detailRequest=input.options.request;
          r.detailSections=[...new Set([...(input.baseReport.detailSections||[]),...input.options.requestedSections])];
        }
        c.reports.push(r); c.currentReportId = r.id;
        const job = c.jobs.find(j => j.id === jobId);
        Object.assign(job, { stage: 'completed', resultId: r.id, completedParts:job.totalParts }); delete job.error; return c;
      });
      await rm(store.file(progressKey(jobId)),{force:true});
    } catch (error) { if(!signal.aborted)await updateJob(jobId, { stage: 'failed', error: error.message }); }
  }
  async function cleanupAudioFiles(){
    await store.update('classroom',undefined,emptyClassroom(),async raw=>{
      const c=migrateClassroom(raw), keep=new Set(pendingAudio);
      const audios=[c.audio,...c.transcriptVersions.map(t=>t.audio),...c.jobs.filter(j=>j.input&&!['cancelled','completed'].includes(j.stage)).map(j=>j.audio)];
      for(const a of audios)if(a&&!a.deleted){keep.add(a.file);if(a.playbackFile)keep.add(a.playbackFile);}
      for(const file of await readdir(audioDir).catch(()=>[]))if(/^[a-f0-9-]+(?:\.(?:wav|mp3|m4a|webm|ogg)|\.play\.mp3)$/.test(file)&&!keep.has(file))await rm(path.join(audioDir,file),{force:true});
      return raw;
    },{skipUnchanged:true});
  }
  async function uploadAudio(req, url, res) {
    const name = url.searchParams.get('name') || '', extension = path.extname(name).toLowerCase();
    if (!['.wav','.mp3','.m4a','.webm','.ogg'].includes(extension) || name.length > 255) throw new AppError('请上传 WAV、MP3、M4A 或浏览器录音 WebM/OGG。', 415);
    const audioId = id(), file = audioId + extension, temp = path.join(audioDir, file + '.tmp'), target = path.join(audioDir, file);
    const playbackFile=audioId+'.play.mp3';
    const limits=audioLimits(process.env),maxBytes=limits.maxBytes,revisionText=url.searchParams.get('revision');
    const before=await classroom();
    if(!revisionText || !/^\d+$/.test(revisionText)||Number(revisionText)!==before.revision){req.resume();throw new AppError('课堂记录已更新或版本参数无效，请刷新后重试；未替换录音。',409);}
    if(before.jobs.some(activeClassJob)){req.resume();throw new AppError('任务进行中，请先暂停再更换录音。',409);}
    if (Number(req.headers['content-length']) > maxBytes) { req.resume(); throw new AppError(`音频超过 ${Number((maxBytes/1024/1024).toFixed(2))} MiB 上传限制。`, 413); }
    await mkdir(audioDir, { recursive: true });
    let bytes = 0;
    const uploadController=new AbortController(),abortUpload=()=>{if(!res.writableEnded)uploadController.abort();};
    req.once('aborted',abortUpload);res.once('close',abortUpload);
    pendingAudio.add(file);pendingAudio.add(playbackFile);
    try {
      // Drain a chunked oversized request while keeping disk use bounded.
      // Throwing inside pipeline destroys the HTTP socket before it can return
      // the useful 413 response to the client.
      await pipeline(req, new Transform({ transform(chunk, _, cb) { bytes += chunk.length;cb(null,bytes>maxBytes?undefined:chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if(bytes>maxBytes)throw new AppError('音频超过上传大小限制，请缩小文件后重试。',413);
      if (!bytes) throw new AppError('录音文件为空。', 400);
      const metadata = await speechCall('probe', temp,()=>{},{signal:uploadController.signal});
      const formats={'.wav':['wav'],'.mp3':['mp3'],'.m4a':['mov','mp4','m4a'],'.webm':['matroska','webm'],'.ogg':['ogg']};
      if(!formats[extension].some(format=>String(metadata.format||'').split(',').includes(format)))throw new AppError('实际音频容器与扩展名不一致，请转换为对应格式；不要仅改文件名。',415);
      if(!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>limits.maxSeconds)throw new AppError(`音频时长无效或超过 ${limits.maxSeconds} 秒限制。`,422);
      const browserCodecs=new Set(['mp3','aac','opus','vorbis','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_u8','pcm_alaw','pcm_mulaw']);
      if(metadata.codec && !browserCodecs.has(metadata.codec)){
        await speechCall('playback',temp,()=>{},{signal:uploadController.signal,playbackPath:path.join(audioDir,playbackFile)});metadata.playbackFile=playbackFile;
      }
      if(req.aborted || res.destroyed)throw new AppError('上传已取消，未替换原录音。',499);
      await rename(temp, target);
      const result = await saveClass(undefined, c => {
        if(req.aborted || res.destroyed)throw new AppError('上传已取消，未替换原录音。',499);
        if(c.audioGeneration!==before.audioGeneration || c.audio?.id!==before.audio?.id || c.currentTranscriptId!==before.currentTranscriptId)throw new AppError('上传期间录音或转写已更新，未覆盖原成果，请重试。',409);
        if (c.jobs.some(j => ['queued','processing','transcribing','loading-model'].includes(j.stage) && j.type === 'transcribe')) throw new AppError('转写进行中，完成后再更换录音。', 409);
        c.audio = { id: audioId, file, name: path.basename(name), bytes, ...metadata, source: url.searchParams.get('source') === 'recording' ? 'recording' : 'upload', createdAt: new Date().toISOString() };
        c.currentTranscriptId = null;c.audioGeneration++; invalidateReports(c); return c;
      });
      json(res, result);
      await cleanupAudioFiles().catch(()=>{});
    } catch (error) { await rm(target, { force: true });await rm(path.join(audioDir,playbackFile),{force:true}); throw error; }
    finally { req.removeListener('aborted',abortUpload);res.removeListener('close',abortUpload);pendingAudio.delete(file);pendingAudio.delete(playbackFile);await rm(temp, { force: true }); }
  }
  return async function api(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    // Importing the module or failing to bind a port must not modify live data.
    // Recovery begins only once this server receives an actual API request.
    ready ||= recoverInterrupted();
    await ready;
    // A foreign web page cannot mutate a loopback app or spend its model key.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) throw new AppError('拒绝外部来源请求。', 403);
    const p = url.pathname;
    if (p === '/api/model-settings' && req.method === 'GET') { json(res, modelSettings.public(await modelSettings.read())); return true; }
    if (p === '/api/model-settings' && req.method === 'POST') { json(res, modelSettings.public(await modelSettings.save(await bodyJSON(req)))); return true; }
    if (p === '/api/model-settings/test' && req.method === 'POST') {
      const b = await bodyJSON(req), current = await modelSettings.read();
      if (b.revision !== current.revision) throw new AppError('模型配置已在其他页面更新，请重新载入后测试。', 409);
      const config = validateModelSettings(current, b), started = Date.now();
      await modelCall('连接测试：仅返回 JSON {"ok":true}。', { task: 'connection-test' }, config);
      json(res, { ok: true, model: config.model, elapsedMs: Date.now() - started }); return true;
    }
    if (req.method === 'GET' && p === '/api/status') { const limits=audioLimits(process.env), config=await modelSettings.read();json(res, { teachingAgent: 'conversation-tools', contextStrategy:'bounded-readback',classroomEvaluation:'overview-on-demand',textModelConfigured: Boolean(config.apiKey), model:config.model, maxInputChars:config.maxInputChars, speech: 'local-python', audioMaxBytes: limits.maxBytes,audioLimits:limits }); return true; }
    if (p === '/api/workspace/agent' && req.method === 'POST') {
      const b = await bodyJSON(req);
      if (typeof b.request !== 'string' || !b.request.trim() || b.request.length > 10000 || !Number.isSafeInteger(b.revision)) throw new AppError('请输入有效的消息。', 400);
      let job;
      const state = await store.update('workspace', b.revision, emptyWorkspace(), c => {
        if (c.messages.some(m => m.status === 'processing' && m.mode !== 'task')) throw new AppError('上一轮消息正在回应，请稍候再发送。', 409);
        if (b.resourceId && currentVersion(findResource(c, b.resourceId)).id !== b.baseVersionId) throw new AppError('资源版本已变化，请刷新后重试。', 409);
        job = newAgentJob(c, b.request, b.resourceId, b.pageId); job.messageId = id();
        c.messages.push({ id: job.messageId, jobId: job.id, role: 'user', text: b.request, status: 'processing', mode:'conversation', resourceId: b.resourceId || null, baseVersionId: b.baseVersionId || null }); return c;
      });
      await saveAgentJob(job); launchAgent(job); json(res, { workspace: state, job: publicAgentJob(job) }, 202); return true;
    }
    const agentRoute = p.match(/^\/api\/workspace\/agent\/([a-f0-9-]{36})(?:\/(pause|resume|draft))?$/);
    if (agentRoute) {
      const job = await store.read('agent-' + agentRoute[1], null); if (!job) throw new AppError('任务不存在。', 404);
      if (req.method === 'GET' && !agentRoute[2]) { json(res, publicAgentJob(job)); return true; }
      if(req.method==='GET' && agentRoute[2]==='draft'){
        json(res,{job:publicAgentJob(job),resources:job.drafts.map(r=>({id:r.id,name:r.name,type:r.type,content:currentVersion(r).content}))});return true;
      }
      if (req.method === 'POST' && agentRoute[2] === 'pause') {
        if (['completed','failed','paused'].includes(job.stage)) { json(res, publicAgentJob(job)); return true; }
        const controller = agentRuns.get(job.id); if (!controller) throw new AppError('任务正在恢复，请刷新后重试。', 409);
        controller.abort(); json(res, { ...publicAgentJob(job), detail: '正在暂停，草稿会保留' }, 202); return true;
      }
      if (req.method === 'POST' && agentRoute[2] === 'resume') {
        if (agentRuns.has(job.id) || !['paused','failed'].includes(job.stage)) throw new AppError('该任务不能重复启动。', 409);
        // Old versions planned even greetings. If such a job never executed a
        // batch, an explicit resume should reconsider the original message.
        // Jobs with actual progress retain their plan and drafts unchanged.
        const reconsider=!job.mode && job.cursor===0 && !job.drafts.length;
        const state = await store.update('workspace', undefined, emptyWorkspace(), c => {
          checkAgentBase(c, job);
          if (c.messages.some(m => m.status === 'processing')) throw new AppError('已有任务正在执行，请先暂停。', 409);
          const m = c.messages.find(m => m.id === job.messageId); if (!m) throw new AppError('任务对话已移除，请重新提出要求。', 409);
          m.status = 'processing'; if(reconsider)m.mode='conversation'; delete m.error; return c;
        });
        if(reconsider){job.mode='conversation';job.plan=null;job.tasks=[];delete job.directCandidate;delete job.pendingCandidate;}
        job.stage = 'queued'; job.resumedAt = new Date().toISOString();if(job.tasks[job.cursor])job.tasks[job.cursor].attempts=0; delete job.error; await saveAgentJob(job); launchAgent(job);
        json(res, { workspace: state, job: publicAgentJob(job) }, 202); return true;
      }
      throw new AppError('任务操作方法无效。', 405);
    }
    if (p === '/api/workspace' && req.method === 'GET') { json(res, await ws()); return true; }
    if (p === '/api/workspace' && req.method === 'POST') {
      const b = await bodyJSON(req);
      if(b.action==='clearConversation'&&(!Number.isSafeInteger(b.revision)||b.revision<0))throw new AppError('清空上下文需要有效的工作空间版本，请刷新后重试。',400);
      json(res, await store.update('workspace', b.revision, emptyWorkspace(), c => applyWorkspaceCommand(c, b))); return true;
    }
    if (p === '/api/workspace/sample' && req.method === 'POST') {
      const b = await bodyJSON(req);
      if (!Number.isSafeInteger(b.revision) || b.revision < 0) throw new AppError('示例载入版本参数无效。', 400);
      // This operation only adds missing fixtures or removes exact untouched
      // duplicates. Serialize against the latest state so concurrent clicks
      // with the same revision can safely return the existing sample set.
      json(res, await store.update('workspace', undefined, emptyWorkspace(), async c => {
        if (b.revision > c.revision) throw new AppError('工作空间版本无效，请刷新后重试。', 409);
        const before = clone(c), result = loadSampleWorkspace(c);
        if (b.revision !== before.revision && JSON.stringify(c) !== JSON.stringify(before)) throw new AppError('工作空间已在其他操作中更新，请刷新后重试；本次未更改内容。', 409);
        if (result.removedMaterials || result.removedResources) {
          const backups = path.join(store.root, 'backups'); await mkdir(backups, { recursive: true });
          await writeFile(path.join(backups, 'workspace-before-sample-dedup-' + id() + '.json'), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
        }
        return c;
      }, { skipUnchanged: true })); return true;
    }
    if (p === '/api/workspace/chat' && req.method === 'POST') {
      const b = await bodyJSON(req);
      if (typeof b.request !== 'string' || !b.request.trim() || b.request.length > 10000) throw new AppError('请输入有效的生成或修改要求。', 400);
      const messageId = id();
      const base = await store.update('workspace', b.revision, emptyWorkspace(), c => {
        if (c.messages.some(m => m.status === 'processing')) throw new AppError('已有对话正在处理，请稍候。', 409);
        if (b.resourceId && currentVersion(findResource(c, b.resourceId)).id !== b.baseVersionId) throw new AppError('资源版本已变化。', 409);
        c.messages.push({ id: messageId, role: 'user', text: b.request, status: 'processing', resourceId: b.resourceId || null, baseVersionId: b.baseVersionId || null }); return c;
      });
      try {
        const job = newAgentJob(base, b.request, b.resourceId, b.pageId); job.messageId = messageId;
        const candidate = await runTeachingAgent(job, { config: { ...await modelSettings.read(), allowDirectCandidate: true }, call: modelCall, runtimeCheck });
        const result = await finishCandidate(job, candidate);
        json(res, result);
      } catch (error) {
        const retained = await store.update('workspace', undefined, emptyWorkspace(), c => { const m = c.messages.find(m => m.id === messageId); if (m) { m.status = 'failed'; m.error = error.message; } return c; });
        json(res, { error: error.message, state: retained }, error.statusCode || 502);
      }
      return true;
    }
    if (p === '/api/classroom' && req.method === 'GET') { json(res, await classroom()); return true; }
    if (p === '/api/classroom' && req.method === 'POST') {
      const b = await bodyJSON(req), before = await classroom();
      const result = await saveClass(b.revision, c => applyClassroomCommand(c, b));
      if (b.action === 'deleteAudio' && before.audio) {await rm(path.join(audioDir, before.audio.file), { force: true });if(before.audio.playbackFile)await rm(path.join(audioDir,before.audio.playbackFile),{force:true});}
      if (b.action === 'clear') {
        const runs=[...classroomRuns.values()];runs.forEach(r=>r.controller.abort('cancel'));await Promise.all(runs.map(r=>r.task));
        await rm(audioDir, { recursive: true, force: true });
        for(const j of before.jobs){await rm(speechCheckpoint(j.id),{force:true});await rm(store.file(progressKey(j.id)),{force:true});}
      }
      json(res, result); return true;
    }
    if (p === '/api/classroom/audio' && req.method === 'POST') { await uploadAudio(req, url, res); return true; }
    if (p === '/api/classroom/audio' && ['GET','HEAD'].includes(req.method)) {
      const c = await classroom(), audioId = url.searchParams.get('id');
      const audio = c.audio?.id === audioId ? c.audio : c.transcriptVersions.find(t => t.audio?.id === audioId)?.audio;
      if (!audio || !/^[a-f0-9-]+\.(wav|mp3|m4a|webm|ogg)$/.test(audio.file)) throw new AppError('原录音不存在或已删除，无法回放。', 404);
      const playback=audio.playbackFile || audio.file;
      if(audio.deleted || !/^[a-f0-9-]+(?:\.(?:wav|mp3|m4a|webm|ogg)|\.play\.mp3)$/.test(playback))throw new AppError('原录音已删除，无法回放。',404);
      const file = path.join(audioDir, playback), info = await stat(file).catch(() => { throw new AppError('原录音已删除，无法回放。', 404); });
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match) throw new AppError('音频范围无效。', 416);
        start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
        if (start > end || start >= info.size || end >= info.size) throw new AppError('音频范围超出文件。', 416);
        status = 206;
      }
      const types = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg' };
      res.writeHead(status, { 'Content-Type': types[path.extname(file)], 'Content-Length': end-start+1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
      if (req.method === 'HEAD') res.end(); else createReadStream(file, { start, end }).pipe(res); return true;
    }
    if (p === '/api/classroom/transcribe' && req.method === 'POST') {
      const b = await bodyJSON(req), jobId = id(); let audio;
      const state = await saveClass(b.revision, c => {
        if (!c.audio) throw new AppError('请先上传或停止并保存录音。');
        if (hasClassroomTask(c)) throw new AppError('已有任务，请等待或暂停。', 409);
        audio = clone(c.audio); c.jobs.push({ id: jobId, type: 'transcribe', audioId: audio.id,audio, input:{audioId:audio.id},stage: 'queued',createdAt:new Date().toISOString() }); return c;
      });
      launchClassroom(state.jobs.at(-1),{audio});
      json(res, state, 202); return true;
    }
    if(p==='/api/classroom/chat'&&req.method==='POST'){
      const b=await bodyJSON(req),before=await classroom();
      if(b.revision!==before.revision)throw new AppError('课堂已变化，请保存最新内容后重试。',409);
      if(typeof b.request!=='string'||!b.request.trim()||b.request.length>2000)throw new AppError('请输入复盘问题，最多2000字。');
      const config=await modelSettings.read(),decision=await classroomConversation(before,b.request,modelCall,config);let input,job;
      const result=await saveClass(undefined,c=>{
        if(c.conversationGeneration!==before.conversationGeneration)throw new AppError('讨论上下文已清空，本次旧回复已丢弃，请重新发送。',409);
        if(decision.action!=='reply'&&(c.audio?.id!==before.audio?.id||c.currentTranscriptId!==before.currentTranscriptId||c.currentReportId!==before.currentReportId||c.courseVersion!==before.courseVersion||JSON.stringify(reportOf(c)?.sections)!==JSON.stringify(reportOf(before)?.sections)))throw new AppError('课堂或报告在讨论期间改变，未覆盖教师修改，请重试。',409);
        if(decision.action==='edit')for(const op of decision.operations)c=applyClassroomCommand(c,{action:'reportItem',reportId:c.currentReportId,...op});
        if(decision.action==='analyze'){
          if(hasClassroomTask(c))throw new AppError('已有任务，请等待或暂停再重新分析。',409);
          const t=transcriptOf(c),mode=decision.section==='overview'?'overview':'details',baseReport=mode==='details'?reportOf(c):null;
          if(!analysisSegments(t).length)throw new AppError('尚无有效转写，请先完成转写。');
          if(mode==='details'&&(!baseReport||baseReport.stale||baseReport.mode!=='overview'))throw new AppError('先生成当前课堂的整体复盘，再补充细分内容。',409);
          input={course:clone(c.course),courseVersion:c.courseVersion,transcript:clone(t),audioId:c.audio?.id,modelConfig:config,baseReport:clone(baseReport),options:{mode,requestedSections:mode==='overview'?['summary','suggestions']:[decision.section],request:b.request}};
          job={id:id(),type:'analysis',mode,section:decision.section,stage:'queued',transcriptId:t.id,createdAt:new Date().toISOString(),input:{transcriptId:t.id,courseVersion:c.courseVersion,audioId:c.audio?.id,options:input.options,baseReportId:baseReport?.id,baseSections:baseReport?.sections}};c.jobs.push(job);
        }
        c.conversation.push({id:id(),role:'user',text:b.request,createdAt:new Date().toISOString()},{id:id(),role:'assistant',text:decision.reply,createdAt:new Date().toISOString(),reportId:before.currentReportId});return c;
      });
      if(job)launchClassroom(job,input);json(res,{state:result,reply:decision.reply});return true;
    }
    if (p === '/api/classroom/analyze' && req.method === 'POST') {
      const b = await bodyJSON(req), jobId = id(), modelConfig = await modelSettings.read(); let input;
      const mode=b.mode??'overview';
      if(!['overview','details'].includes(mode)||b.request!==undefined&&(typeof b.request!=='string'||b.request.length>1000))throw new AppError('分析模式或细分要求无效。',400);
      if(mode==='details'&&!['knowledge','emphasis','difficulties','observations'].includes(b.section))throw new AppError('请选择有效的细分分析内容。',400);
      const state = await saveClass(b.revision, c => {
        const transcript = transcriptOf(c);
        if (!transcript || !analysisSegments(transcript).length) throw new AppError('请先完成真实转写与文字校正，至少保留一个有效片段。');
        if (hasClassroomTask(c)) throw new AppError('已有任务，请等待或暂停。', 409);
        const baseReport=mode==='details'?reportOf(c):null;
        if(mode==='details'&&(!baseReport||baseReport.mode!=='overview'||baseReport.stale||baseReport.id!==b.reportId))throw new AppError('请先生成当前课堂的统一总结与建议，再选择细分分析。',409);
        input = { course: clone(c.course), courseVersion: c.courseVersion, transcript: clone(transcript), audioId: c.audio?.id, modelConfig, baseReport:clone(baseReport),options:{mode,requestedSections:mode==='details'?[b.section]:['summary','suggestions'],request:b.request||''} };
        c.jobs.push({ id: jobId, type: 'analysis', mode, section:mode==='details'?b.section:null,stage: 'queued', transcriptId: transcript.id,createdAt:new Date().toISOString(),input:{transcriptId:transcript.id,courseVersion:c.courseVersion,audioId:c.audio?.id,options:input.options,baseReportId:baseReport?.id,baseSections:baseReport?.sections} }); return c;
      });
      launchClassroom(state.jobs.at(-1),input); json(res, state, 202); return true;
    }
    const taskAction=p.match(/^\/api\/classroom\/jobs\/([a-f0-9-]+)\/(pause|resume|cancel)$/);
    if(taskAction && req.method==='POST'){
      const [,jobId,action]=taskAction,b=await bodyJSON(req);let resumeInput;
      const result=await saveClass(b.revision,async c=>{
        const j=c.jobs.find(j=>j.id===jobId);if(!j)throw new AppError('任务不存在。',404);
        if(action==='resume'){
          if(!j.input || !['paused','failed'].includes(j.stage))throw new AppError('该任务无法继续，请重新提交。',409);
          if(classroomRuns.has(jobId))throw new AppError('任务正在停止，请稍后点击继续。',409);
          if(hasClassroomTask(c))throw new AppError('已有任务，请先暂停。',409);
          if(j.type==='transcribe'){
            if(c.audio?.id!==j.input.audioId)throw new AppError('当前录音已变化，请选择原录音对应的转写版本，或启动新转写。',409);
            await stat(path.join(audioDir,c.audio.file)).catch(()=>{throw new AppError('原录音已删除，请上传后新建转写。',404);});resumeInput={audio:clone(c.audio)};
          }else{
            if(c.currentTranscriptId!==j.input.transcriptId||c.courseVersion!==j.input.courseVersion||c.audio?.id!==j.input.audioId)throw new AppError('课程、转写或录音已变化，请启动新的分析。',409);
            const baseReport=j.input.baseReportId?reportOf(c):null;
            if(j.input.baseReportId&&(baseReport?.id!==j.input.baseReportId||JSON.stringify(baseReport.sections)!==JSON.stringify(j.input.baseSections)))throw new AppError('报告已修订，请重新生成细分内容。',409);
            resumeInput={course:clone(c.course),courseVersion:c.courseVersion,transcript:clone(transcriptOf(c)),audioId:c.audio?.id,modelConfig:await modelSettings.read(),baseReport:clone(baseReport),options:j.input.options};
          }
          j.stage='queued';delete j.error;
        }else{
          if(['completed','cancelled'].includes(j.stage))throw new AppError('任务已结束。',409);
          j.stage=action==='pause'?'paused':'cancelled';delete j.error;
        }
        return c;
      });
      if(action==='resume')launchClassroom(result.jobs.find(j=>j.id===jobId),resumeInput);
      else classroomRuns.get(jobId)?.controller.abort(action);
      if(action==='cancel'){
        const running=classroomRuns.get(jobId);if(running)await running.task;
        await rm(speechCheckpoint(jobId),{force:true});await rm(store.file(progressKey(jobId)),{force:true});await cleanupAudioFiles();
      }
      json(res,result);return true;
    }
    if (p === '/api/classroom/report' && req.method === 'GET') {
      const c=await classroom();
      if(url.searchParams.has('revision')&&Number(url.searchParams.get('revision'))!==c.revision||url.searchParams.has('reportId')&&url.searchParams.get('reportId')!==c.currentReportId)throw new AppError('报告已变化，请保存最新内容后重新导出。',409);
      const markdown = buildClassroomReport(c);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="classroom-report.md"' }); res.end(markdown); return true;
    }
    if (p === '/api/workspace/html' && req.method === 'GET') {
      const w = await ws(), r = findResource(w, url.searchParams.get('resourceId')), v = r.versions.find(v => v.id === url.searchParams.get('versionId'));
      if (r.type === 'ppt' || !v) throw new AppError('互动版本不存在。', 404);
      const draft = url.searchParams.get('draft') !== 'false';
      if (!draft && (v.id !== r.currentVersionId || !v.confirmed)) throw new AppError('当前版本确认后才能正式导出。');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="activity.html"' });
      res.end(renderActivity(v.content, { draft, version: v.id, source: r.origin })); return true;
    }
    // Existing parsing / analysis routes are handled by the original server.
    return false;
  };
}
