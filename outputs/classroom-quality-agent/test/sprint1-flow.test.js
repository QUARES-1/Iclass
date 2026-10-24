import test from 'node:test';
import assert from 'node:assert/strict';
import {newAgentJob, runTeachingAgent, commitAgentDrafts} from '../src/agent.js';
import {emptyWorkspace, createResource, currentVersion, applyWorkspaceCommand} from '../src/workspace.js';

import { analyzeMaterials } from '../src/analyzer.js';
import { matchSupplements } from '../src/frontier.js';
import { generateOutline, toMarkdown } from '../src/pptGenerator.js';
import { deriveCoverContent, slidesToExportModel } from '../src/pptExport.js';
import {
  confirmAllSlides,
  isReviewComplete,
  setSlideStatus,
  updateSlide,
  SLIDE_STATUS,
} from '../src/review.js';

test('Sprint 1 主流程：资料解析到正式课件导出', () => {
  const materials = [{
    type: '教案',
    title: '线性表讲解',
    content: [
      '第2章 线性表',
      '教学目标：理解线性表的逻辑结构。',
      '教学重点：顺序表的插入与删除。',
      '教学难点：链表指针操作。',
      '知识点',
      '1. 线性表的定义',
      '2. 顺序表',
      '3. 链表',
    ].join('\n'),
  }];

  const analysis = analyzeMaterials(materials);
  assert.deepEqual(analysis.chapters, ['第2章 线性表']);
  assert.equal(analysis.knowledgePoints.length, 3);

  const supplements = matchSupplements(analysis.knowledgePoints);
  assert.ok(supplements.length > 0);
  assert.ok(supplements.some((item) => item.type === '技术' || item.type === '案例'));

  let slides = generateOutline(analysis, supplements);
  assert.equal(slides[0].section, '导入');
  assert.equal(slides.at(-1).section, '总结');
  assert.ok(slides.every((slide) => slide.status === SLIDE_STATUS.PENDING));

  const editedId = slides.find((slide) => slide.section === '讲解').id;
  const deletedId = slides.find((slide) => slide.section === '互动').id;
  slides = updateSlide(slides, editedId, { title: '线性表核心概念' });
  slides = setSlideStatus(slides, deletedId, SLIDE_STATUS.DELETED);
  slides = confirmAllSlides(slides);
  assert.equal(isReviewComplete(slides), true);

  const cover = deriveCoverContent(analysis, slides);
  const model = slidesToExportModel(slides, { ...cover, confirmedOnly: true });
  assert.equal(model[0].section, '封面');
  assert.equal(model[0].title, '第2章 线性表');
  assert.ok(model.some((slide) => slide.title === '线性表核心概念'));
  assert.ok(!model.some((slide) => slide.section === '互动'));

  const markdown = toMarkdown(slides, { confirmedOnly: true });
  assert.ok(markdown.includes('线性表核心概念'));
  assert.ok(!markdown.includes('课堂互动与讨论'));
});

test('重复资料不会在后续课件中制造重复知识页', () => {
  const materials = [
    { content: '第2章 线性表\n知识点：顺序表' },
    { content: '第2章 线性表\n知识点：顺序表' },
  ];
  const analysis = analyzeMaterials(materials);
  const slides = generateOutline(analysis, []);
  assert.equal(analysis.knowledgePoints.length, 1);
  assert.equal(slides.filter((slide) => slide.section === '讲解').length, 1);
});

const agentConfig = {batchPages: 1, maxAgentCalls: 100, maxPlanSteps: 60, maxRepairs: 99, maxInputChars: 115000};
const passed = {action: 'review', passed: true, reply: '检查通过', issues: [], repairSteps: []};
const slide = title => ({section: '讲解', title, bullets: ['原理说明'], notes: ['教师备注']});
const step = overrides => ({id: 'create-lesson', title: '生成课件', tool: 'ppt.create', resourceId: 'current',
  targetIds: [], instructions: '讲解知识点', topics: [], sourceIds: [], minutes: 45, pages: 1, ...overrides});
const plan = steps => ({action: 'plan', goal: '完成教学课件', reply: '开始执行', steps});
const create = input => ({action: 'create', type: 'ppt', name: '排序课件', reply: '本批完成',
  content: {slides: Array.from({length: input.task.pageCount}, (_, i) => slide('第' + (input.task.pageStart + i) + '页'))}});

function repairReview(job) {
  const resource = job.drafts[0], page = currentVersion(resource).content.slides[0];
  return {action: 'review', passed: false, reply: '需补充说明', issues: ['当前页面缺少已要求的说明'],
    repairSteps: [step({id: 'repair-page', title: '补充原页', tool: 'ppt.update', resourceId: resource.id,
      targetIds: [page.id], pages: 1, minutes: 0})]};
}
const repairPage = input => ({action: 'update', reply: '修正原页', operations: [{action: 'update',
  slideId: input.task.targetIds[0], patch: {title: '第' + input.task.id + '次修订', bullets: ['补充说明 ' + input.task.taskId]}}]});

test('Sprint 1 新智能体主流程：分批生成、提交、人工确认、局部修改后重新确认与导出', async () => {
  const state = emptyWorkspace(), job = newAgentJob(state, '生成两页排序课件');
  let batches = 0;
  await runTeachingAgent(job, {config: agentConfig, call: async (_system, input) => {
    if (input.phase === 'decide') return plan([step({pages: 2})]);
    if (input.phase === 'review') return passed;
    batches++;
    return input.task.tool === 'ppt.create' ? create(input) : {action: 'update', reply: '补充第二页',
      operations: [{action: 'add', slide: slide('第二页排序演示')}]};
  }});
  assert.equal(batches, 2);
  assert.equal(state.resources.length, 0, '检查通过前只保留任务草稿');
  const {target} = commitAgentDrafts(state, job);
  assert.equal(target.versions.length, 1);
  assert.equal(currentVersion(target).content.slides.length, 2);
  assert.equal(isReviewComplete(currentVersion(target).content.slides), false);
  applyWorkspaceCommand(state, {action: 'confirm', resourceId: target.id, baseVersionId: target.currentVersionId});
  assert.equal(isReviewComplete(currentVersion(target).content.slides), true);
  const confirmed = structuredClone(currentVersion(target));
  assert.equal(slidesToExportModel(confirmed.content.slides, {confirmedOnly: true, canonical: true}).length, 2);
  applyWorkspaceCommand(state, {action: 'editSlide', resourceId: target.id, baseVersionId: target.currentVersionId,
    slideId: confirmed.content.slides[0].id, patch: {title: '教师补充边界条件'}});
  assert.equal(isReviewComplete(currentVersion(target).content.slides), false);
  assert.equal(currentVersion(target).content.slides[1].status, 'confirmed');
  assert.deepEqual(target.versions.find(v => v.id === confirmed.id), confirmed);
  applyWorkspaceCommand(state, {action: 'confirm', resourceId: target.id, baseVersionId: target.currentVersionId});
  const exported = slidesToExportModel(currentVersion(target).content.slides, {confirmedOnly: true, canonical: true});
  assert.equal(isReviewComplete(currentVersion(target).content.slides), true);
  assert.equal(exported[0].title, '教师补充边界条件');
  assert.equal(exported[1].title, '第二页排序演示');
});

test('Sprint 1 修正轮次超过5仍可继续，最终只提交一个课件版本', async () => {
  const state = emptyWorkspace(), job = newAgentJob(state, '生成并完善一页课件');
  let executions = 0;
  await runTeachingAgent(job, {config: agentConfig, call: async (_system, input) => {
    if (input.phase === 'decide') return plan([step()]);
    if (input.phase === 'review') return job.repairRound < 6 ? repairReview(job) : passed;
    executions++;
    return job.repairRound ? repairPage(input) : create(input);
  }});
  assert.equal(job.repairRound, 6);
  assert.equal(executions, 7);
  assert.equal(job.review.passed, true);
  assert.equal(state.resources.length, 0);
  const result = commitAgentDrafts(state, job);
  assert.equal(state.resources.length, 1);
  assert.equal(result.target.versions.length, 1);
  assert.equal(currentVersion(result.target).content.slides.length, 1);
});

test('Sprint 1 修正轮次耗尽：增加额度后恢复原草稿，不重复生成或覆盖已有课件', async () => {
  const state = emptyWorkspace();
  const untouched = createResource(state, 'ppt', '保留的原课件', {slides: [slide('原课件内容')]});
  const before = structuredClone(untouched);
  const job = newAgentJob(state, '另外生成一份课件');
  let generated = 0, repaired = 0;
  const call = async (_system, input) => {
    if (input.phase === 'decide') return plan([step()]);
    if (input.phase === 'review') return job.repairRound ? passed : repairReview(job);
    if (job.repairRound) { repaired++; return repairPage(input); }
    generated++; return create(input);
  };
  await assert.rejects(runTeachingAgent(job, {config: {...agentConfig, maxRepairs: 0}, call}), /自动修正轮次/);
  assert.equal(job.drafts.length, 1);
  assert.equal(job.review.passed, false);
  assert.deepEqual(state.resources, [before]);
  const draftId = job.drafts[0].id;
  await runTeachingAgent(job, {config: {...agentConfig, maxRepairs: 1}, call});
  assert.equal(generated, 1);
  assert.equal(repaired, 1);
  assert.equal(job.drafts[0].id, draftId);
  commitAgentDrafts(state, job);
  assert.equal(state.resources.length, 2);
  assert.deepEqual(state.resources.find(r => r.id === before.id), before);
});

test('Sprint 1 总调用额度独立于修正轮次，预算不足保留草稿、提高后完成修正', async () => {
  const state = emptyWorkspace(), job = newAgentJob(state, '生成一页课件并修正');
  let generated = 0, repaired = 0;
  const call = async (_system, input) => {
    if (input.phase === 'decide') return plan([step()]);
    if (input.phase === 'review') return job.repairRound ? passed : repairReview(job);
    if (job.repairRound) { repaired++; return repairPage(input); }
    generated++; return create(input);
  };
  await assert.rejects(runTeachingAgent(job, {config: {...agentConfig, maxAgentCalls: 4}, call}), /运行额度/);
  assert.equal(job.calls, 3, '剩余额度不足以安排修正和检查时提前停止');
  assert.equal(job.repairRound, 0);
  assert.equal(state.resources.length, 0);
  assert.equal(job.drafts.length, 1);
  await runTeachingAgent(job, {config: {...agentConfig, maxAgentCalls: 10}, call});
  assert.equal(generated, 1);
  assert.equal(repaired, 1);
  assert.equal(job.review.passed, true);
  assert.equal(job.calls, 6);
  commitAgentDrafts(state, job);
  assert.equal(state.resources.length, 1);
});

test('Sprint 1 实际调用次数耗尽后保留已生成页，提高额度只补最终检查', async () => {
  const state = emptyWorkspace(), job = newAgentJob(state, '生成一页课件');
  let generationAttempts = 0;
  const call = async (_system, input) => {
    if (input.phase === 'decide') return plan([step()]);
    if (input.phase === 'review') return passed;
    generationAttempts++;
    // Invalid tool responses consume calls but must not create partial resources.
    if (generationAttempts < 3) return {action: 'reply', reply: '模拟未遵守工具格式'};
    return create(input);
  };
  await assert.rejects(runTeachingAgent(job, {config: {...agentConfig, maxAgentCalls: 4}, call}), /任务达到设置中的模型调用额度/);
  assert.equal(job.calls, 4);
  assert.equal(job.cursor, 1);
  assert.equal(job.drafts.length, 1);
  assert.equal(state.resources.length, 0);
  const draft = structuredClone(currentVersion(job.drafts[0]));
  await runTeachingAgent(job, {config: {...agentConfig, maxAgentCalls: 10}, call});
  assert.equal(job.calls, 5);
  assert.equal(generationAttempts, 3);
  assert.deepEqual(currentVersion(job.drafts[0]), draft);
  const {target} = commitAgentDrafts(state, job);
  assert.equal(target.versions.length, 1);
  assert.equal(currentVersion(target).content.slides.length, 1);
});
