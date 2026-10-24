import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store, AppError} from '../src/store.js';
import {ModelSettings} from '../src/modelSettings.js';
import {FeedbackService} from '../src/feedbackService.js';
import {FeedbackAgent} from '../src/feedbackAgent.js';

// External provider/model fixtures only; persistence, validation, jobs,
// report versions and handoff use the production services.
const template = {
  title: '二叉树课后反馈', description: 'Sprint 3 流程测试', questions: [
    {id: 'pace', type: 'single', label: '节奏', required: true,
      options: [{id: 'fast', label: '偏快'}, {id: 'ok', label: '合适'}]},
    {id: 'rating', type: 'rating', label: '讲解清晰度', max: 5},
    {id: 'comment', type: 'text', label: '改进意见'},
  ],
};
const entries = [3, 4, 5].map((rating, i) => ({
  serial_number: i + 1, created_at: '2026-10-24T03:00:00Z',
  field_1: i === 1 ? '合适' : '偏快', field_2: String(rating),
  field_3: ['补充栈变化过程', '增加逐步代码演示', '增加课堂练习'][i],
}));

async function fixture(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sprint3-flow-'));
  const provider = {form: null, creates: 0, failSecondPage: false,
    entries: structuredClone(entries), pages: [], changedStructure: false};
  const model = {unavailable: false, invalidEvidence: false};
  const analysisInputs = [];
  const store = new Store(dir);
  const settings = new ModelSettings(dir, {LLM_API_KEY: 'isolated-test-key'});
  const service = new FeedbackService({store, modelSettings: settings, providerIntervalMs: 0,
    clientFactory: () => ({
      getMe: async () => ({id: 'sprint3-account'}),
      createForm: async payload => {
        provider.creates++;
        provider.form = {token: 'sprint3-form', url: 'https://example.test/f/sprint3',
          fields: payload.fields.map((field, i) => ({['field_' + (i + 1)]: {
            ...field,
            type: {RadioButton: 'single_choice', RatingField: 'rating', TextArea: 'multi_line_text'}[field.type],
            ...(field.choices ? {choices: field.choices.map(choice => ({name: choice.value, value: choice.api_code}))} : {}),
          }}))};
        return provider.form;
      },
      getForm: async () => provider.changedStructure ? {...provider.form, fields: []} : provider.form,
      listEntries: async (_token, options) => {
        provider.pages.push(options?.next || 'first');
        if (options?.next) {
          if (provider.failSecondPage) throw new Error('模拟第二页读取失败');
          return {data: provider.entries.slice(2), next: null};
        }
        return {data: provider.entries.slice(0, 2), next: 'second-page'};
      },
    }),
    modelCall: async (_system, input) => {
      if (input.phase === 'feedback-decide') return input.toolResults.length
        ? {action: 'reply', reply: '综合报告和建议已保存。'}
        : {action: 'tool', tool: 'analysis.generate'};
      analysisInputs.push(structuredClone(input));
      if (model.unavailable) throw new AppError('模拟模型暂不可用', 503);
      return {
        summary: '问卷清晰度均分4；课堂录音说明非递归遍历尚未展开。',
        findings: [
          {text: '三份有效反馈清晰度均分4。', kind: 'observation', evidenceIds: ['stat:rating']},
          {text: '教师尚未展开非递归遍历。', kind: 'observation', evidenceIds: [model.invalidEvidence ? 'segment:missing' : 'segment:seg-1']},
        ],
        suggestions: [{text: '在原课件中补充非递归遍历与栈状态演示。',
          evidenceIds: ['feedback:online-1', 'segment:seg-1', 'page:page-1']}],
      };
    },
  });
  const wait = async key => {
    const task = service.runs.get(key);
    if (task) await task.promise;
  };
  const sync = async id => {
    service.launchSync(id);
    await wait('sync-' + id);
    return service.read(id);
  };
  try {
    await service.saveConfig({revision: 0, accessToken: 'isolated-provider-key'});
    const initial = await service.templates();
    const saved = await service.saveTemplate({revision: initial.revision, template});
    let c = await service.create({title: '二叉树遍历', date: '2026-10-24', templateId: saved.versions.at(-1).id});
    if (options.deadline) c = await service.command(c.id, {revision: c.revision, action: 'update', deadline: options.deadline});
    await service.end(c.id, c.revision);
    await wait('publish-' + c.id);
    c = await service.read(c.id);
    assert.equal(c.publish.status, 'published');
    await run({service, store, provider, model, analysisInputs, c, wait, sync});
  } finally {
    for (const task of service.runs.values()) task.controller.abort();
    await Promise.all([...service.runs.values()].map(task => task.promise));
    await rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}

const mean = c => c.stats.questions.find(q => q.id === 'rating').mean;

async function linkMaterials(service, store, c) {
  await store.update('classroom', undefined, {revision: 0}, () => ({
    course: {title: '二叉树遍历'}, reports: [],
    transcriptVersions: [{id: 'transcript-1', audioId: 'audio-1', segments: [
      {id: 'seg-1', start: 0, end: 8, text: '非递归遍历和栈的变化过程还没有展开。'},
    ]}],
  }));
  await store.update('workspace', undefined, {revision: 0}, () => ({resources: [{
    id: 'ppt-1', name: '原始PPT', type: 'ppt', currentVersionId: 'v1',
    versions: [{id: 'v1', content: {slides: [{id: 'page-1', title: '递归遍历', bullets: ['递归实现']} ]}}],
  }]}));
  c = await service.command(c.id, {revision: c.revision, action: 'linkAudio', transcriptId: 'transcript-1'});
  return service.command(c.id, {revision: c.revision, action: 'linkPpt', resourceId: 'ppt-1'});
}

async function analyze(service, store, c, wait) {
  const job = await new FeedbackAgent(service).start(c.id, {revision: c.revision, request: '结合问卷、课堂转写和PPT生成综合报告与改进建议'});
  await wait('agent-' + job.id);
  return store.read('feedback-job-' + job.id, null);
}

test('Sprint 3：发布→分页同步与清洗→问卷及转写综合报告→导出与PPT建议交接', async () => fixture(async ctx => {
  const {service, store, provider, analysisInputs, wait, sync} = ctx;
  let c = await sync(ctx.c.id);
  assert.equal(c.sync.status, 'complete');
  assert.equal(c.records.length, 3);
  assert.ok(c.records.every(r => Number.isInteger(r.answers.rating)));
  assert.equal(mean(service.public(c)), 4);
  assert.deepEqual(provider.pages, ['first', 'second-page']);
  const version = c.dataVersion;
  c = await sync(c.id);
  assert.equal(c.dataVersion, version);
  await service.end(c.id, c.revision);
  await wait('publish-' + c.id);
  assert.equal(provider.creates, 1);

  c = await service.read(c.id);
  c = await service.command(c.id, {revision: c.revision, action: 'exclude', recordId: 'online-1', excluded: true, reason: '测试排除'});
  c = await sync(c.id);
  assert.equal(mean(service.public(c)), 4.5);
  assert.equal(c.records.find(r => r.id === 'online-1').reason, '测试排除');
  c = await service.command(c.id, {revision: c.revision, action: 'exclude', recordId: 'online-1', excluded: false});
  c = await linkMaterials(service, store, c);
  const originalPpt = await store.read('workspace', null);
  const agent = new FeedbackAgent(service);
  const job = await agent.start(c.id, {revision: c.revision, request: '结合问卷、课堂转写和PPT生成综合报告与改进建议'});
  await wait('agent-' + job.id);
  assert.equal((await store.read('feedback-job-' + job.id, null)).status, 'completed');
  assert.ok(analysisInputs.length > 0);
  const modelContext = JSON.stringify(analysisInputs);
  assert.match(modelContext, /补充栈变化过程/);
  assert.match(modelContext, /非递归遍历和栈的变化过程还没有展开/);
  assert.match(modelContext, /递归实现/);
  const input = await service.readInput(job.id);
  assert.equal(input.stats.eligible, 3);
  assert.equal(input.source.transcript.segments[0].id, 'seg-1');
  assert.equal(input.ppt.content.slides[0].id, 'page-1');
  c = await service.read(c.id);
  const report = c.reports.find(r => r.id === c.currentReportId);
  assert.match(report.text, /均分4/);
  assert.match(report.text, /非递归遍历/);
  assert.ok(report.findings.some(f => f.evidenceIds.includes('segment:seg-1')));
  c = await service.command(c.id, {revision: c.revision, action: 'report', reportId: report.id,
    baseVersion: report.version, text: report.text + '\n教师复核：增加课堂练习。'});
  const revised = c.reports.find(r => r.id === report.id);
  c = await service.command(c.id, {revision: c.revision, action: 'report', reportId: revised.id, baseVersion: revised.version, confirm: true});
  assert.match(await service.reportMarkdown(c.id, revised.id, revised.version), /教师复核：增加课堂练习/);
  const handoff = await service.handoff(c.id, {revision: c.revision, ids: c.suggestions.map(s => s.id)});
  assert.match(handoff.request, /栈状态演示/);
  assert.equal(handoff.target.resourceId, 'ppt-1');
  assert.equal((await service.getHandoff(handoff.id)).targetStatus, 'current');
  assert.deepEqual(await store.read('workspace', null), originalPpt, '交接只保存建议，不自动改写原PPT');

  // A later feedback update invalidates the report but keeps its historical evidence.
  provider.entries[0].field_2 = '1';
  c = await sync(c.id);
  assert.equal(c.reports.find(r => r.id === report.id).stale, true);
  assert.equal((await service.readInput(job.id)).records.find(r => r.id === 'online-1').answers.rating, 3);
  assert.equal(c.records.find(r => r.id === 'online-1').answers.rating, 1);
}));

test('Sprint 3：分页中途失败保留全部旧统计，恢复后一次提交并去重', async () => fixture(async ({service, provider, c: initial, sync}) => {
  let c = await sync(initial.id);
  const previous = structuredClone(c.records), version = c.dataVersion;
  provider.entries[0].field_2 = '1';
  provider.failSecondPage = true;
  c = await sync(c.id);
  assert.equal(c.sync.status, 'failed');
  assert.deepEqual(c.records, previous);
  assert.equal(c.dataVersion, version);
  assert.equal(mean(service.public(c)), 4);
  provider.failSecondPage = false;
  c = await sync(c.id);
  assert.equal(c.records.length, 3);
  assert.equal(mean(service.public(c)), 10 / 3);
  assert.equal(c.records.find(r => r.id === 'online-1').answers.rating, 1);
  const recoveredVersion = c.dataVersion;
  c = await sync(c.id);
  assert.equal(c.dataVersion, recoveredVersion);
}));

test('Sprint 3：混合错误导入须明确确认有效项，重复导入不增加份数', async () => fixture(async ({service, c: initial, sync}) => {
  let c = await sync(initial.id);
  const data = {classId: c.id, records: [
    {id: 'local-good', answers: {pace: 'ok', rating: 2}},
    {id: 'local-bad-rating', answers: {pace: 'ok', rating: 99}},
    {id: 'local-bad-option', answers: {pace: 'missing', rating: 4}},
  ]};
  const preview = await service.previewImport(c.id, {data});
  assert.equal(preview.valid, 1);
  assert.equal(preview.errors.length, 2);
  await assert.rejects(service.commitImport(c.id, c.revision, preview.id, false), /仅导入有效/);
  assert.equal((await service.read(c.id)).records.length, 3);
  c = await service.commitImport(c.id, c.revision, preview.id, true);
  assert.equal(c.records.length, 4);
  assert.equal(mean(service.public(c)), 3.5);
  const version = c.dataVersion;
  const repeated = await service.previewImport(c.id, {data});
  c = await service.commitImport(c.id, c.revision, repeated.id, true);
  assert.equal(c.dataVersion, version);
  assert.equal(c.records.length, 4);
}));

test('Sprint 3：预览后在线回答更新，旧导入不能覆盖最新统计', async () => fixture(async ({service, provider, c: initial, sync}) => {
  let c = await sync(initial.id);
  const preview = await service.previewImport(c.id, {data: {records: [{id: 'local-new', answers: {pace: 'ok', rating: 5}}]}});
  provider.entries[0].field_2 = '1';
  c = await sync(c.id);
  await assert.rejects(service.commitImport(c.id, c.revision, preview.id, false), /重新预览/);
  const latest = await service.read(c.id);
  assert.equal(latest.records.length, 3);
  assert.equal(latest.records[0].answers.rating, 1);
}));

test('Sprint 3：截止前有效、截止时晚到、缺时区待核对，晚到和未知时间不参与均分', async () => fixture(async ({service, provider, c: initial, sync}) => {
  provider.entries[0].created_at = '2099-10-24T11:59:59+08:00';
  provider.entries[1].created_at = '2099-10-24T12:00:00+08:00';
  provider.entries[2].created_at = '2099-10-24T11:59:59';
  let c = await sync(initial.id);
  const stats = service.public(c).stats;
  assert.equal(stats.eligible, 1);
  assert.equal(stats.late, 1);
  assert.equal(stats.unknownTime, 1);
  assert.equal(mean(service.public(c)), 3);
  const version = c.dataVersion;
  c = await sync(c.id);
  assert.equal(c.dataVersion, version);
  assert.equal(c.records.length, 3);
}, {deadline: '2099-10-24T12:00:00+08:00'}));

test('Sprint 3：远端改题阻止同步覆盖，恢复原结构后才能更新回答', async () => fixture(async ({service, provider, c: initial, sync}) => {
  let c = await sync(initial.id);
  const records = structuredClone(c.records), version = c.dataVersion;
  provider.changedStructure = true;
  provider.entries[0].field_2 = '1';
  c = await sync(c.id);
  assert.equal(c.sync.status, 'failed');
  assert.deepEqual(c.records, records);
  assert.equal(c.dataVersion, version);
  provider.changedStructure = false;
  c = await sync(c.id);
  assert.equal(c.sync.status, 'complete');
  assert.equal(c.records[0].answers.rating, 1);
}));

test('Sprint 3：模型失败保留已确认报告，恢复同一任务后只新增一份成果', async () => fixture(async ({service, store, model, c: initial, sync, wait}) => {
  let c = await linkMaterials(service, store, await sync(initial.id));
  const first = await analyze(service, store, c, wait);
  assert.equal(first.status, 'completed', first.error);
  c = await service.read(c.id);
  const report = c.reports.find(r => r.id === c.currentReportId);
  c = await service.command(c.id, {revision: c.revision, action: 'report', reportId: report.id, baseVersion: report.version, confirm: true});
  const savedReports = structuredClone(c.reports), savedSuggestions = structuredClone(c.suggestions);
  model.unavailable = true;
  const failed = await analyze(service, store, c, wait);
  assert.equal(failed.status, 'failed');
  c = await service.read(c.id);
  assert.deepEqual(c.reports, savedReports);
  assert.deepEqual(c.suggestions, savedSuggestions);
  assert.equal(c.writerJobId, null);
  model.unavailable = false;
  await new FeedbackAgent(service).control(c.id, failed.id, 'resume');
  await wait('agent-' + failed.id);
  assert.equal((await store.read('feedback-job-' + failed.id, null)).status, 'completed');
  c = await service.read(c.id);
  assert.equal(c.reports.length, 2);
  assert.deepEqual(c.reports.find(r => r.id === report.id), savedReports[0]);
}));

test('Sprint 3：模型引用不存在的转写片段，任务失败且不提交无依据报告', async () => fixture(async ({service, store, model, c: initial, sync, wait}) => {
  const c = await linkMaterials(service, store, await sync(initial.id));
  model.invalidEvidence = true;
  const job = await analyze(service, store, c, wait);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /证据标识无效/);
  const saved = await service.read(c.id);
  assert.equal(saved.reports.length, 0);
  assert.equal(saved.suggestions.length, 0);
  assert.equal(saved.writerJobId, null);
}));

test('Sprint 3：跨课堂导入和任务续跑被拒绝，不改变原课堂成果', async () => fixture(async ({service, store, c: initial, sync, wait}) => {
  let c = await linkMaterials(service, store, await sync(initial.id));
  const job = await analyze(service, store, c, wait);
  assert.equal(job.status, 'completed', job.error);
  c = await service.read(c.id);
  const other = await service.create({title: '另一课堂', templateId: c.template.id});
  await assert.rejects(service.previewImport(other.id, {data: {classId: c.id, records: c.records}}), /其他课堂/);
  const preview = await service.previewImport(c.id, {data: {records: [{id: 'new-record', answers: {pace: 'ok', rating: 4}}]}});
  await assert.rejects(service.commitImport(other.id, other.revision, preview.id, false), /预览已失效/);
  await assert.rejects(new FeedbackAgent(service).control(other.id, job.id, 'resume'), /任务不存在/);
  assert.deepEqual(await service.read(c.id), c);
  assert.equal((await service.read(other.id)).records.length, 0);
  assert.equal((await service.read(other.id)).reports.length, 0);
}));

test('Sprint 3：建议交接固定所选版本，后续编辑与PPT版本变化不会篡改旧交接', async () => fixture(async ({service, store, c: initial, sync, wait}) => {
  let c = await linkMaterials(service, store, await sync(initial.id));
  const job = await analyze(service, store, c, wait);
  assert.equal(job.status, 'completed', job.error);
  c = await service.read(c.id);
  const selected = c.suggestions[0];
  const first = await service.handoff(c.id, {revision: c.revision, ids: [selected.id]});
  c = await service.command(c.id, {revision: c.revision, action: 'suggestions', baseSuggestionVersion: c.suggestionVersion,
    suggestions: [{...selected, text: '教师修订：添加栈状态表及课堂练习'}]});
  const old = await service.getHandoff(first.id);
  assert.equal(old.stale, true);
  assert.equal(old.suggestions[0].text, selected.text);
  const second = await service.handoff(c.id, {revision: c.revision, ids: [selected.id]});
  assert.notEqual(second.id, first.id);
  assert.match(second.request, /添加栈状态表/);
  await store.update('workspace', undefined, null, state => {
    state.resources[0].versions.push({id: 'v2', content: {slides: [{id: 'page-1', title: '修改后的PPT', bullets: ['栈状态表']}]}});
    state.resources[0].currentVersionId = 'v2';
    return state;
  });
  assert.equal((await service.getHandoff(first.id)).targetStatus, 'changed');
  c = await service.refreshReferences(c.id);
  assert.equal(c.ppt.needsRefresh, true);
  assert.equal(c.reports.find(r => r.id === c.currentReportId).stale, true);
  const source = await service.readInput(job.id);
  assert.equal(source.ppt.content.slides[0].title, '递归遍历');
}));
