import test from 'node:test';import assert from 'node:assert/strict';
import {classroomConversation} from '../src/classroomConversation.js';import {emptyClassroom} from '../src/classroom.js';
const state=()=>({...emptyClassroom(),currentTranscriptId:'t',transcriptVersions:[{id:'t',segments:[{id:'one',start:10,end:20,text:'提问与比较'},{id:'two',start:20,end:30,text:'讲解'}]}]});
test('复盘助手按需检索真实片段后回答，不读取Sprint1资料',async()=>{
  let calls=0;const s=state();s.workspace={secret:'不可见'};const result=await classroomConversation(s,'提问发生在哪？',async(_,input)=>{
    assert.equal(input.workspace,undefined);calls++;if(!input.toolResults.length)return {action:'tool',tool:'transcript.search',args:{query:'提问'}};
    assert.deepEqual(input.toolResults[0].data.items.map(s=>s.id),['one']);return {action:'reply',reply:'00:10—00:20有一段提问。'};
  },{});assert.equal(result.action,'reply');assert.equal(calls,2);
});
test('复盘对话拒绝未读取、越界或重复的报告修改目标',async()=>{
  const s=state();s.currentReportId='r';s.reports=[{id:'r',sections:{summary:[{id:'a',text:'总结'}],suggestions:[],knowledge:[{id:'detail',text:'详细知识'}]}}];
  for(const id of ['missing','detail'])await assert.rejects(classroomConversation(s,'改一下',async()=>({action:'edit',reply:'修改',operations:[{section:'knowledge',itemId:id,text:'修改后'}]}),{}),/实际读取/);
});
