import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi, json } from '../src/api.js';
import { transcriptOf, reportOf } from '../src/classroom.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const segments = [
  { id: 'seg-1', start: 2, end: 8, text: '冒泡排序通过比较相邻元素来交换位置。', timestampSource: 'fixture-alignment' },
  { id: 'seg-2', start: 12, end: 20, text: '为什么一轮比较能把最大值放到末尾？', timestampSource: 'fixture-alignment' },
];

// Only the external speech/model calls are fixtures. HTTP, jobs, validation,
// versions, disk persistence and export all use the production implementation.
async function speechCall(mode) {
  if (mode === 'probe') return { duration: 30, format: 'wav', codec: 'pcm_s16le', sampleRate: 16000 };
  assert.equal(mode, 'transcribe');
  return { segments: structuredClone(segments), chunks: [{ start: 0, end: 30 }] };
}

function modelCall(_system, input) {
  const evidenceIds = [input.segments?.[0].id || input.partials[0].ids[0]];
  return { sections: Object.fromEntries(input.requestedSections.map(section => [section, [{
    text: section === 'suggestions' ? '用三个数字演示相邻交换，并解释每轮比较的结果。' : '课堂围绕相邻比较与交换展开。',
    kind: section === 'suggestions' ? 'ai-inference' : section === 'difficulties' ? 'hypothesis' : 'transcript',
    evidenceIds,
  }]])) };
}

async function withClassroom(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sprint2-flow-'));
  let server;
  const start = async () => {
    const api = createApi(root, { dataDir, speechCall, modelCall, ...options });
    server = http.createServer(async (req, res) => {
      try {
        if (!await api(req, res, new URL(req.url, 'http://' + req.headers.host))) json(res, { error: 'not found' }, 404);
      } catch (error) {
        json(res, { error: error.message }, error.statusCode || 500);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + server.address().port;
  };
  const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  let base = await start();
  const request = (url, init) => fetch(base + url, init);
  const getState = async () => {
    const response = await request('/api/classroom');
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (url, body, status = 200) => {
    const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const command = async body => post('/api/classroom', { revision: (await getState()).revision, ...body });
  const upload = async (name = 'lesson.wav') => {
    const response = await request('/api/classroom/audio?name=' + name + '&revision=' + (await getState()).revision,
      { method: 'POST', body: Buffer.from('isolated audio fixture') });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const job = async (endpoint, body = {}, expectedStage = 'completed') => {
    const started = await post('/api/classroom/' + endpoint, { revision: (await getState()).revision, ...body }, 202);
    const jobId = started.jobs.at(-1).id;
    const deadline = Date.now() + 10000;
    let current;
    do {
      current = await getState();
      const task = current.jobs.find(item => item.id === jobId);
      if (['completed', 'failed', 'cancelled', 'paused'].includes(task.stage)) {
        assert.equal(task.stage, expectedStage, JSON.stringify(task));
        return current;
      }
      await delay(10);
    } while (Date.now() < deadline);
    assert.fail('任务超时：' + JSON.stringify(current.jobs));
  };
  try {
    await run({ request, getState, post, command, upload, job, dataDir,
      restart: async () => { await stop(); base = await start(); } });
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
test('更换录音的自动清理不会删除归档或反馈课堂仍引用的音频',async()=>{
  const {writeFile}=await import('node:fs/promises');
  await withClassroom({},async api=>{
    const first=await api.upload();await writeFile(path.join(api.dataDir,'storage-archives.json'),JSON.stringify({revision:0,items:[{id:'archive',audioFiles:[first.audio.file]}]}));
    const second=await api.upload();await api.command({action:'course',course:{title:'',description:''}});assert.equal(await readFile(path.join(api.dataDir,'audio',first.audio.file),'utf8'),'isolated audio fixture');
    await writeFile(path.join(api.dataDir,'feedback-source-legacy.json'),JSON.stringify({revision:0,id:'legacy',audio:second.audio}));await writeFile(path.join(api.dataDir,'storage-audio-pins.json'),JSON.stringify({revision:0,sources:{},complete:false}));
    await api.upload();await api.command({action:'course',course:{title:'',description:''}});assert.equal(await readFile(path.join(api.dataDir,'audio',second.audio.file),'utf8'),'isolated audio fixture');
  });
});

test('清空等待旧语音进程退出期间，新上传录音及其回放文件保留，响应使用最新状态', {timeout:15000},async()=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await withClassroom({speechCall:async(mode,...args)=>{if(mode!=='transcribe')return speechCall(mode,...args);entered();await gate;return {segments};}},async api=>{
    try{
      const old=await api.upload(),started=await api.post('/api/classroom/transcribe',{revision:old.revision},202);await ready;
      await api.post('/api/classroom/jobs/'+started.jobs.at(-1).id+'/pause',{revision:(await api.getState()).revision});
      const clearing=api.command({action:'clear'});
      for(let i=0;i<200&&(await api.getState()).audio;i++)await delay(5);
      assert.equal((await api.getState()).audio,null);
      const next=await api.upload('new.wav');release();const cleared=await clearing;
      assert.equal(cleared.audio?.id,next.audio.id,'清空响应不能回滚到旧的空状态');
      const response=await api.request('/api/classroom/audio?id='+next.audio.id);assert.equal(response.status,200);assert.equal(await response.text(),'isolated audio fixture');
      await assert.rejects(readFile(path.join(api.dataDir,'audio',old.audio.file)),{code:'ENOENT'});
    }finally{release();}
  });
});
test('同一上下文的复盘并发提交只调用一次模型，完成后释放占用',async()=>{
  let entered,release,calls=0;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await withClassroom({modelCall:async()=>{calls++;entered();await gate;return {action:'reply',reply:'你好！'};}},async api=>{
    try{
      const revision=(await api.getState()).revision,first=api.post('/api/classroom/chat',{revision,request:'你好'});await ready;
      const secondPending=api.request('/api/classroom/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,request:'再问一次'})});
      // Release even on a broken implementation, so a failed assertion cannot hang teardown.
      await delay(50);release();const second=await secondPending;assert.equal(second.status,409);await first;assert.equal(calls,1);
      await api.post('/api/classroom/chat',{revision:(await api.getState()).revision,request:'接着聊'});assert.equal(calls,2);
    }finally{release();}
  });
});
test('回放范围支持尾部和超出文件末端的合法请求，拒绝空文件及无效范围',async()=>{
  await withClassroom({},async api=>{
    const state=await api.upload(),url='/api/classroom/audio?id='+state.audio.id;
    let response=await api.request(url,{headers:{Range:'bytes=-7'}});assert.equal(response.status,206);assert.equal(await response.text(),'fixture');
    response=await api.request(url,{headers:{Range:'bytes=0-999999'}});assert.equal(response.status,206);assert.equal(await response.text(),'isolated audio fixture');
    for(const range of ['bytes=-0','bytes=99-100','bytes=9-2','bytes=-','bytes=0-1,3-4'])assert.equal((await api.request(url,{headers:{Range:range}})).status,416);
    const {writeFile}=await import('node:fs/promises');await writeFile(path.join(api.dataDir,'audio',state.audio.file),'');assert.equal((await api.request(url)).status,404);
  });
});
test('反复保存课程或选择当前录音和转写，内容、修订号及报告有效性保持不变',async()=>{
  await withClassroom({},async api=>{
    await api.upload();let state=await api.job('transcribe');state=await api.job('analyze');const before=structuredClone(state);
    for(let i=0;i<100;i++)for(const command of [{action:'course',course:state.course},{action:'selectAudio',audioId:state.audio.id},{action:'selectTranscript',transcriptId:state.currentTranscriptId}])state=await api.post('/api/classroom',{revision:state.revision,...command});
    assert.deepEqual(state,before);
  });
});
test('新录音探测期间启动分析，拒绝替换或删除正在使用的原录音',async()=>{
  let probeCount=0,enterProbe,releaseProbe,enterModel,releaseModel;
  const probeReady=new Promise(r=>enterProbe=r),probeGate=new Promise(r=>releaseProbe=r),modelReady=new Promise(r=>enterModel=r),modelGate=new Promise(r=>releaseModel=r);
  await withClassroom({speechCall:async(mode,...args)=>{if(mode==='probe'&&++probeCount>1){enterProbe();await probeGate;}return speechCall(mode,...args);},modelCall:async(...args)=>{enterModel();await modelGate;return modelCall(...args);}},async api=>{
    let pending,analysis;
    try{
      await api.upload();const original=await api.job('transcribe');
      pending=api.request('/api/classroom/audio?name=new.wav&revision='+original.revision,{method:'POST',body:Buffer.from('new isolated fixture')});await probeReady;
      analysis=api.job('analyze');await modelReady;
      await api.post('/api/classroom',{revision:(await api.getState()).revision,action:'deleteAudio'},409);
      releaseProbe();assert.equal((await pending).status,409);assert.equal((await api.getState()).audio.id,original.audio.id);
      releaseModel();const state=await analysis;assert.equal(state.audio.id,original.audio.id);assert.equal(state.reports.length,1);
    }finally{releaseProbe();releaseModel();await pending?.catch(()=>{});await analysis?.catch(()=>{});}
  });
});

test('Sprint 2 主流程：上传、转写、校正、分析、人工确认、导出与重启恢复', { timeout: 20000 }, async () => {
  const inputs = [];
  await withClassroom({ modelCall: (system, input) => { inputs.push(input); return modelCall(system, input); } }, async api => {
    const workspaceBefore = await (await api.request('/api/workspace')).json();
    await api.command({ action: 'course', course: { title: '冒泡排序', description: '面向初学者讲解相邻交换。' } });
    const uploaded = await api.upload();
    assert.equal(uploaded.transcriptVersions.length, 0, '上传本身不能自动填入示例转写');
    assert.equal(uploaded.jobs.length, 0, '教师主动启动转写');
    const playback = await api.request('/api/classroom/audio?id=' + uploaded.audio.id, { headers: { Range: 'bytes=0-7' } });
    assert.equal(playback.status, 206);
    assert.equal(Buffer.from(await playback.arrayBuffer()).toString(), 'isolated');

    let state = await api.job('transcribe');
    const original = structuredClone(transcriptOf(state));
    assert.equal(original.original, true);
    assert.deepEqual(original.segments, segments);
    const correctedText = '每轮相邻比较后，当前范围的最大值到达末尾。';
    state = await api.command({ action: 'correct', transcriptId: original.id,
      segments: original.segments.map((segment, i) => ({ id: segment.id, text: i ? segment.text : correctedText })) });
    const corrected = transcriptOf(state);
    assert.notEqual(corrected.id, original.id);
    assert.equal(corrected.parentId, original.id);
    assert.deepEqual(state.transcriptVersions[0], original);
    assert.deepEqual(corrected.segments.map(({ id, start, end }) => ({ id, start, end })), segments.map(({ id, start, end }) => ({ id, start, end })));

    state = await api.job('analyze');
    assert.equal(inputs[0].segments[0].text, correctedText);
    assert.equal(inputs[0].course.title, '冒泡排序');
    assert.deepEqual(inputs[0].requestedSections, ['summary', 'suggestions']);
    let report = reportOf(state);
    assert.equal(report.transcriptId, corrected.id);
    assert.equal(report.stale, false);
    const teacherText = '教师修订：下一节先演示三个数字的比较过程。';
    await api.command({ action: 'reportItem', reportId: report.id, section: 'suggestions', itemId: report.sections.suggestions[0].id, text: teacherText });
    state = await api.command({ action: 'confirmReport', reportId: report.id });
    report = reportOf(state);
    assert.ok(Object.values(report.sections).flat().every(item => item.confirmed));
    assert.ok(report.sections.suggestions[0].edited);
    const response = await api.request('/api/classroom/report?reportId=' + report.id + '&revision=' + state.revision);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    const markdown = await response.text();
    for (const text of [teacherText, correctedText, corrected.id, '00:02—00:08', '已确认', '教师修订']) assert.ok(markdown.includes(text), text);
    assert.doesNotMatch(markdown, /headUpRate|抬头率|注意力回落|投入回升/);
    const disk = JSON.parse(await readFile(path.join(api.dataDir, 'classroom.json'), 'utf8'));
    assert.equal(disk.currentReportId, report.id);
    await api.restart();
    assert.deepEqual(await api.getState(), state);
    assert.equal(await (await api.request('/api/classroom/report')).text(), markdown);
    assert.deepEqual(await (await api.request('/api/workspace')).json(), workspaceBefore, 'Sprint 2 不修改 Sprint 1');
  });
});

for (const change of ['course', 'correct', 'audio']) {
  test(`Sprint 2 输入变更：${change} 使旧报告待更新，拒绝旧下载版本`, async () => {
    await withClassroom({}, async api => {
      await api.upload();
      await api.job('transcribe');
      const before = await api.job('analyze');
      const oldReport = reportOf(before);
      if (change === 'course') await api.command({ action: 'course', course: { title: '新课程', description: '' } });
      if (change === 'correct') await api.command({ action: 'correct', transcriptId: before.currentTranscriptId,
        segments: transcriptOf(before).segments.map(segment => ({ id: segment.id, text: segment.text + '校正' })) });
      if (change === 'audio') await api.upload('replacement.wav');
      const after = await api.getState();
      assert.equal(reportOf(after).stale, true);
      assert.deepEqual(reportOf(after).sections, oldReport.sections);
      assert.deepEqual(after.transcriptVersions[0], before.transcriptVersions[0]);
      await api.post('/api/classroom', { action: 'confirmReport', reportId: oldReport.id, revision: after.revision }, 422);
      const download = await api.request('/api/classroom/report?reportId=' + oldReport.id + '&revision=' + before.revision);
      assert.equal(download.status, 409);
      await download.text();
      if (change === 'audio') assert.equal(after.currentTranscriptId, null, '新录音不能复用旧转写');
    });
  });
}

test('Sprint 2 长转写：整课分段完整覆盖，汇总保留末段证据和时间', async () => {
  const longSegments = Array.from({ length: 12 }, (_, i) => ({
    id: 'long-' + i, start: i * 240 + 2, end: i * 240 + 180,
    text: `第${i + 1}段课堂讲解。` + '比较相邻元素并交换。'.repeat(260),
    timestampSource: 'fixture-chunk-offset',
  }));
  const seen = [];
  let summaries = 0;
  await withClassroom({
    speechCall: async mode => mode === 'probe'
      ? { duration: 2880, format: 'wav', codec: 'pcm_s16le' }
      : { segments: longSegments, chunks: Array.from({ length: 12 }, (_, i) => ({ start: i * 240, end: (i + 1) * 240 })) },
    modelCall: (system, input) => {
      const result = modelCall(system, input);
      if (input.segments) seen.push(...input.segments.map(segment => segment.id));
      else summaries++;
      const lastEvidence = input.segments?.at(-1).id || input.partials.at(-1).ids.at(-1);
      for (const items of Object.values(result.sections)) items[0].evidenceIds = [lastEvidence];
      return result;
    },
  }, async api => {
    await api.upload();
    const transcribed = await api.job('transcribe');
    assert.deepEqual(transcriptOf(transcribed).segments, longSegments);
    const state = await api.job('analyze');
    const report = reportOf(state);
    assert.ok(report.coverage.length > 1);
    assert.ok(summaries > 0);
    const ids = longSegments.map(segment => segment.id);
    assert.deepEqual(seen, ids, '分析输入按顺序覆盖每段且不重复');
    assert.deepEqual(report.coverage.flatMap(part => part.ids), ids);
    assert.ok(report.sections.summary[0].evidenceIds.includes('long-11'));
    const markdown = await (await api.request('/api/classroom/report')).text();
    assert.match(markdown, /long-11/);
    assert.match(markdown, /44:02—47:00/);
  });
});

for (const failure of ['无语音', '模型不可用', 'AI 服务失败', '无效证据']) {
  test(`Sprint 2 异常恢复：${failure} 不覆盖已有转写和报告`, async () => {
    let fail = false;
    await withClassroom({
      speechCall: async mode => {
        if (fail && mode === 'transcribe') {
          if (failure === '无语音') return { segments: [] };
          if (failure === '模型不可用') throw new Error(failure);
        }
        return speechCall(mode);
      },
      modelCall: (system, input) => {
        if (fail && failure === 'AI 服务失败') throw new Error(failure);
        const result = modelCall(system, input);
        if (fail && failure === '无效证据') result.sections.summary[0].evidenceIds = ['missing-segment'];
        return result;
      },
    }, async api => {
      await api.upload();
      await api.job('transcribe');
      const before = await api.job('analyze');
      fail = true;
      const endpoint = ['无语音', '模型不可用'].includes(failure) ? 'transcribe' : 'analyze';
      const failed = await api.job(endpoint, {}, 'failed');
      assert.ok(failed.jobs.at(-1).error);
      assert.deepEqual(failed.audio, before.audio);
      assert.deepEqual(failed.transcriptVersions, before.transcriptVersions);
      assert.deepEqual(failed.reports, before.reports);
      assert.equal(failed.currentReportId, before.currentReportId);
      fail = false;
      const retried = await api.job(endpoint);
      assert.equal(retried.jobs.at(-1).stage, 'completed');
      assert.deepEqual(retried.transcriptVersions[0], before.transcriptVersions[0]);
      assert.deepEqual(retried.reports[0], { ...before.reports[0], stale: endpoint === 'transcribe' });
    });
  });
}
