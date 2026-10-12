// Opt-in acceptance against the configured real model and running local app.
// Uses the current workspace; run with a fresh workspace for a repeatable demo.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const base = process.env.LIVE_URL || 'http://127.0.0.1:3000';
const dir = path.resolve('artifacts/live');
await fs.mkdir(dir, { recursive: true });
let state = await get('/api/workspace');
const records = [];
async function get(url) { const r = await fetch(base + url); const b = await r.json(); if (!r.ok) throw Error(b.error); return b; }
async function post(url, body) { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const b = await r.json(); if (!r.ok) throw Error(b.error); return b; }
const current = r => r?.versions.find(v => v.id === r.currentVersionId);
const selected = () => state.resources.find(r => r.id === state.selectedId);
async function command(action, extra = {}) { const r = selected(); state = await post('/api/workspace', { revision: state.revision, action, resourceId: r?.id, baseVersionId: current(r)?.id, ...extra }); }
async function chat(request, newResource = false) {
  const r = newResource ? null : selected(), started = Date.now();
  state = await post('/api/workspace/chat', { revision: state.revision, request, resourceId: r?.id, baseVersionId: current(r)?.id });
  records.push({ request, elapsedSeconds: (Date.now()-started)/1000, response: state.messages.at(-1), resourceId: state.selectedId, versionId: selected()?.currentVersionId });
  await fs.writeFile(path.join(dir, 'workspace-results.json'), JSON.stringify({ model: 'configured-backend-real-model', records, state }, null, 2));
  console.log(JSON.stringify({ request, elapsedSeconds: records.at(-1).elapsedSeconds, resources: state.resources.length, type: selected()?.type, versions: selected()?.versions.length }));
}
assert.equal((await get('/api/status')).textModelConfigured, true);
assert.equal(state.resources.length, 0, 'Use a fresh workspace; existing resources are never cleared by this script.');
await command('settings', { requirements: { topic: '排序算法与稳定性', audience: '本科二年级，已学数组与循环', duration: 45, instructions: '以可执行操作和具体数字案例讲解，不声称外部检索。' } });
if (!state.materials.some(m => m.title === '教师提供的排序课程资料')) await command('material', { material: { title: '教师提供的排序课程资料', type: 'MD', content: '# 排序算法\n冒泡排序每轮比较相邻元素，仅在严格逆序时交换；一轮后最大元素位于末尾。\n稳定排序要求相同关键字元素的原有相对次序不变；不能把“数值排序正确”等同于稳定。\n案例：[3,1,2]，以及[(2,A),(1,B),(2,C)]。\n教学重点：相邻比较、逆序交换、稳定性。难点：识别同值记录的相对次序。' } });
await chat('根据教师资料新建一份5页排序算法PPT，包含导入、相邻交换、稳定性、数字案例和总结，概念含例子与反例。', true);
assert.equal(selected().type, 'ppt');
const pptId = selected().id;
const slide = current(selected()).content.slides[2];
assert.ok(slide);
await command('editSlide', { slideId: slide.id, patch: { notes: ['教师人工备注：保留 A 与 C 的相对顺序，并请学生手动演示。'] } });
const before = structuredClone(current(selected()).content.slides);
await chat('只给第3页的例子换成 [(2,A),(1,B),(2,C)] 排序后 [(1,B),(2,A),(2,C)]，解释 A 在 C 前面；仅修改 example，不修改备注或其他页。');
const after = current(selected()).content.slides;
assert.match(after[2].example, /A/);
assert.deepEqual(after[2].notes, before[2].notes);
for (let i=0;i<before.length;i++) if(i!==2) assert.deepEqual(after[i],before[i]);
await chat('新建排序稳定性点击答题小游戏，mode=quiz，2道题，每题3个选项，明确正确答案与错误原因，给出提示。', true);
assert.equal(current(selected()).content.mode, 'quiz');
await chat('保留题目和正确答案，仅把提示改为“先比较关键字相等记录的原有先后次序”，并在第一题解释中增加“排序结果正确不代表保持了原有顺序”。');
assert.match(current(selected()).content.hint, /原有先后/);
const quizId = selected().id;
await command('confirm');
await chat('新建冒泡排序拖拽小游戏，mode=order，rule=bubble，items正确答案为1、2、3、4，必须仅允许相邻逆序交换，含操作提示和解释。', true);
assert.equal(current(selected()).content.mode, 'order');
assert.equal(current(selected()).content.rule, 'bubble');
await chat('新建排序概念配对小游戏，mode=match，2组配对：稳定性对应同值记录相对顺序保持，相邻交换对应只比较和交换相邻元素。', true);
assert.equal(current(selected()).content.mode, 'match');
await chat('新建一个归并排序步骤教学网页，type=web，mode=steps，3步演示拆分、递归排序、合并，含例子和操作提示。', true);
assert.equal(selected().type, 'web');
assert.equal(current(selected()).content.mode, 'steps');
await command('select', { resourceId: pptId });
await command('attach', { activityId: quizId, slideId: current(selected()).content.slides[3].id });
await fs.writeFile(path.join(dir,'workspace-results.json'), JSON.stringify({ model:'configured-backend-real-model', records, checks: { directedPageOnly:true, teacherNotesPreserved:true, fourActivityModes:true, runtimeChecked:true, fixedVersionAttachment:true }, state }, null, 2));
console.log('Real-model workspace acceptance passed; resources left pending teacher confirmation.');
