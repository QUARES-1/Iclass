import test from 'node:test';
import assert from 'node:assert/strict';
import {simplifiedChinese,simplifiedTranscript} from '../src/chineseText.js';
import {emptyClassroom,applyClassroomCommand,migrateClassroom} from '../src/classroom.js';
test('简体规范只转换中文字形，完整保留英文、数字、标点和代码',()=>{
  assert.equal(simplifiedChinese('這個課堂的網絡節點與資料結構，為什麼？C++ split/merge 2026\nint main() { return 0; }'),'这个课堂的网络节点与资料结构，为什么？C++ split/merge 2026\nint main() { return 0; }');
  assert.equal(simplifiedChinese('简体中文，API 123'), '简体中文，API 123');
});
test('简体转写是独立版本，原稿、教师校正、片段ID和时间排除状态不改写',()=>{
  const original={id:'raw',source:'teacher',original:false,audioId:'audio',segments:[{id:'s',start:1,end:5,text:'教師校正過的網絡與著作。',excluded:true,timestampSource:'alignment'}]};
  const before=structuredClone(original),normalized=simplifiedTranscript(original);assert.deepEqual(original,before);assert.equal(normalized.parentId,'raw');assert.equal(normalized.source,'simplified');assert.equal(normalized.segments[0].text,'教师校正过的网络与著作。');
  assert.deepEqual({...normalized.segments[0],text:original.segments[0].text},original.segments[0]);assert.equal(simplifiedTranscript(normalized),null);
});
test('已生成报告随纯字形规范形成可追溯版本，确认和全部证据保留，不重跑模型',()=>{
  const s=emptyClassroom();s.transcriptVersions=[{id:'raw',source:'asr',segments:[{id:'s',start:1,end:4,text:'課堂講解網絡節點。'}]}];s.currentTranscriptId='raw';
  s.reports=[{id:'r',transcriptId:'raw',courseVersion:0,course:s.course,mode:'overview',stale:false,sections:{summary:[{id:'i',text:'這節課說明網絡節點。',kind:'transcript',evidenceIds:['s'],confirmed:true,edited:true,timeEvidence:[]}],suggestions:[],knowledge:[],emphasis:[],difficulties:[],observations:[]}}];s.currentReportId='r';
  const result=applyClassroomCommand(s,{action:'simplifyTranscript',transcriptId:'raw'}),report=result.reports.at(-1);assert.equal(s.reports[0].sections.summary[0].text,'這節課說明網絡節點。');assert.equal(result.transcriptVersions[0].segments[0].text,'課堂講解網絡節點。');assert.equal(report.transcriptId,result.currentTranscriptId);assert.equal(report.sections.summary[0].text,'这节课说明网络节点。');assert.equal(report.sections.summary[0].confirmed,true);assert.equal(report.stale,false);assert.equal(report.parentReportId,'r');assert.deepEqual(report.sections.summary[0].evidenceIds,['s']);
  assert.equal(migrateClassroom(result).reports.at(-1).textNormalization.sourceReportId,'r');const again=applyClassroomCommand(result,{action:'simplifyTranscript',transcriptId:result.currentTranscriptId});assert.equal(again.transcriptVersions.length,2);assert.equal(again.reports.length,2);
});
test('已有过期报告不因字形转换变成当前报告，任务运行中禁止转换',()=>{
  const s=emptyClassroom();s.transcriptVersions=[{id:'raw',source:'asr',segments:[{id:'s',start:1,end:4,text:'課堂'}]}];s.currentTranscriptId='raw';s.reports=[{id:'r',transcriptId:'raw',stale:true,sections:{summary:[]}}];s.currentReportId='r';
  assert.equal(applyClassroomCommand(s,{action:'simplifyTranscript',transcriptId:'raw'}).reports.length,1);s.jobs=[{id:'job',type:'analysis',stage:'summarizing'}];assert.throws(()=>applyClassroomCommand(s,{action:'simplifyTranscript',transcriptId:'raw'}),e=>e.statusCode===409);
});
