import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSampleWorkspace } from '../src/sampleWorkspace.js';
import { emptyWorkspace, applyWorkspaceCommand, currentVersion, createResource } from '../src/workspace.js';
import { sampleActivities } from '../src/samples.js';
const analysis={chapters:[],objectives:[],knowledgePoints:['教师理解'],keyPoints:[],difficultPoints:[]};
function legacy(count=3){const state=emptyWorkspace();for(let i=0;i<count;i++){const set=emptyWorkspace();loadSampleWorkspace(set);for(const row of [...set.materials,...set.resources])delete row.sampleKey;state.materials.push(...set.materials);state.resources.push(...set.resources);}state.selectedId=state.resources.at(-1).id;return state;}

test('反复载入示例保持ID、选择、确认、理解与消息，已经存在的编辑算作已载入',()=>{
  const state=emptyWorkspace();assert.deepEqual(loadSampleWorkspace(state),{addedMaterials:4,addedResources:5,removedMaterials:0,removedResources:0});
  const game=state.resources.find(r=>r.type==='game');applyWorkspaceCommand(state,{action:'editActivity',resourceId:game.id,baseVersionId:game.currentVersionId,title:'教师改名的练习',description:'教师修改后的说明'});state.selectedId=game.id;state.analysis=analysis;state.analysisSource='teacher';state.supplements=[{title:'教师补充'}];
  const before=structuredClone(state);for(let i=0;i<20;i++){assert.deepEqual(loadSampleWorkspace(state),{addedMaterials:0,addedResources:0,removedMaterials:0,removedResources:0});assert.deepEqual(state,before);}
});

test('旧版重复资料与未修改资源整理为一套，教师与AI同名内容不被去重',()=>{
  const state=legacy();const teacher={...structuredClone(state.materials[0]),id:'teacher-copy',source:'teacher'};state.materials.push(teacher);const ai=createResource(state,'game',sampleActivities[0].title,sampleActivities[0]);const selected=state.resources.find(r=>r.origin==='sample'&&r.type==='web');state.selectedId=selected.id;state.analysis=analysis;
  const result=loadSampleWorkspace(state);assert.equal(result.removedMaterials,8);assert.equal(result.removedResources,10);assert.equal(state.materials.length,5);assert.equal(state.resources.length,6);assert.equal(state.selectedId,selected.id);assert.deepEqual(state.materials.find(m=>m.id==='teacher-copy'),teacher);assert.deepEqual(state.resources.find(r=>r.id===ai.id),ai);assert.deepEqual(state.analysis,analysis);
});

test('旧版修改、确认、历史引用、消息引用及当前选择的资源全部保留',()=>{
  const state=legacy();const quizzes=state.resources.filter(r=>r.versions[0].content.mode==='quiz'),orders=state.resources.filter(r=>r.versions[0].content.mode==='order'),ppts=state.resources.filter(r=>r.type==='ppt');
  applyWorkspaceCommand(state,{action:'editActivity',resourceId:quizzes[0].id,baseVersionId:quizzes[0].currentVersionId,title:'改过的标题',description:'新说明'});applyWorkspaceCommand(state,{action:'confirm',resourceId:quizzes[1].id,baseVersionId:quizzes[1].currentVersionId});
  applyWorkspaceCommand(state,{action:'attach',resourceId:ppts[0].id,baseVersionId:ppts[0].currentVersionId,slideId:currentVersion(ppts[0]).content.slides[0].id,activityId:orders[2].id});
  state.messages.push({id:'reference',role:'user',resourceId:quizzes[2].id,status:'failed',text:'修改要求'});
  const protectedIds=[quizzes[0].id,quizzes[1].id,quizzes[2].id,orders[2].id,ppts[0].id,state.selectedId],before=new Map(protectedIds.map(id=>[id,structuredClone(state.resources.find(r=>r.id===id))]));
  loadSampleWorkspace(state);for(const [id,original] of before){const row=state.resources.find(r=>r.id===id);assert.ok(row);assert.deepEqual(row.versions,original.versions);assert.equal(row.name,original.name);}assert.equal(state.selectedId,protectedIds.at(-1));
});

test('删除部分示例后只补齐缺少的项，保留其他ID与选择',()=>{
  const state=emptyWorkspace();loadSampleWorkspace(state);state.materials.shift();state.resources.shift();state.analysis=analysis;const ids=state.resources.map(r=>r.id),selected=state.selectedId;
  const result=loadSampleWorkspace(state);assert.equal(result.addedMaterials,1);assert.equal(result.addedResources,1);assert.equal(state.materials.length,4);assert.equal(state.resources.length,5);assert.ok(ids.every(id=>state.resources.some(r=>r.id===id)));assert.equal(state.selectedId,selected);assert.equal(state.analysis,null);
});

test('资料和资源已到上限时，完整示例的重复载入仍成功且不改变数据',()=>{
  const state=emptyWorkspace();loadSampleWorkspace(state);while(state.materials.length<20)applyWorkspaceCommand(state,{action:'materialFailure',title:'失败记录',error:'格式不支持'});while(state.resources.length<60)createResource(state,'game','其他生成资源',sampleActivities[0]);const before=structuredClone(state);loadSampleWorkspace(state);assert.deepEqual(state,before);
});
