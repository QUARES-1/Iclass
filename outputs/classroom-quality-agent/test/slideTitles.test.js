import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanSlideTitle,slidesToExportModel,buildPresentation} from '../src/pptExport.js';
import {codeFunctionNames} from '../src/codeBlock.js';
import {emptyWorkspace,createResource,currentVersion,applyPptOperations,commitResource,applyWorkspaceCommand} from '../src/workspace.js';

test('清除末尾嵌套分页标记，保留数学括号、语言和教师的章节编号',()=>{
  assert.equal(cleanSlideTitle('分类（续 2）（续2）'),'分类');
  assert.equal(cleanSlideTitle('完整函数（代码 2/3）'),'完整函数');
  for(const title of ['复杂度 O(n log n)','关键性质（1）','实现（C++17）','第2章：数据结构'])assert.equal(cleanSlideTitle(title),title);
});

test('程序标题提取忽略字符串、注释和控制流，不执行或更改源码',()=>{
  const source='// void fake() {}\nint real(int x) { if (x) { return 1; } return 0; }\nconst char* s = "int other() {}";\n';
  assert.deepEqual(codeFunctionNames(source,'cpp'),['real']);
  assert.deepEqual(codeFunctionNames('def solve(x):\n    return x\n','python'),['solve']);
});

test('解释、完整函数与输出有各自标题，编辑分页内容不再次叠加续页编号',()=>{
  const state=emptyWorkspace(),source='int add(int a, int b) {\n    return a + b;\n}\n';
  const r=createResource(state,'ppt','标题验证',{slides:[{title:'操作实现（续 2）',bullets:['理解可加性'],notes:['教师备注'],code:{language:'cpp',source,expectedOutput:'3'}}]});
  let pages=currentVersion(r).content.slides;
  assert.equal(new Set(pages.map(s=>s.title)).size,pages.length);assert.ok(pages.every(s=>!/[（(](?:续|代码)\s*\d/.test(s.title)));
  assert.match(pages.find(s=>s.code?.kind!=='output'&&s.code).title,/add/);assert.match(pages.at(-1).title,/运行输出/);
  const code=pages.find(s=>s.code?.kind!=='output'&&s.code);
  let edit=applyPptOperations(r,[{action:'update',slideId:code.id,patch:{title:'教师指定的函数标题'}}]);commitResource(r,edit.content,'改标题');
  assert.equal(currentVersion(r).content.slides.find(s=>s.id===code.id).title,'教师指定的函数标题');
  const first=currentVersion(r).content.slides[0];edit=applyPptOperations(r,[{action:'update',slideId:first.id,patch:{bullets:Array.from({length:9},(_,i)=>'不同要点'+i)}}]);commitResource(r,edit.content,'增加内容');
  pages=currentVersion(r).content.slides;assert.ok(pages.every(s=>!/[（(](?:续|代码)\s*\d/.test(s.title)));assert.equal(pages.filter(s=>s.code&&s.code.kind!=='output').map(s=>s.code.source).join(''),source);
});

test('批量标题保存只有一个版本，稳定页ID、正文、源码、备注与无关确认不变，可撤销',()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','标题验证',{slides:[{title:'原理',bullets:['定义'],notes:['教师备注']},{title:'代码',bullets:[],notes:[],code:{language:'cpp',source:'int f() { return 1; }'}},{title:'保留页',bullets:['保留']}]});
  const command=extra=>applyWorkspaceCommand(state,{resourceId:r.id,baseVersionId:currentVersion(r).id,...extra});command({action:'confirm'});
  const old=structuredClone(currentVersion(r));command({action:'editSlideTitles',titles:old.content.slides.slice(0,2).map((s,i)=>({slideId:s.id,title:i?'f 函数实现':'核心定义'}))});
  const next=currentVersion(r);assert.equal(r.versions.length,2);assert.equal(next.parentId,old.id);
  assert.deepEqual(next.content.slides.map(s=>s.id),old.content.slides.map(s=>s.id));
  for(let i=0;i<next.content.slides.length;i++){const {title,status,...before}=old.content.slides[i],{title:afterTitle,status:afterStatus,...after}=next.content.slides[i];assert.deepEqual(after,before);}
  assert.equal(next.content.slides[2].status,'confirmed');command({action:'undo'});assert.deepEqual(currentVersion(r).content.slides.map(s=>s.title),old.content.slides.map(s=>s.title));
});

test('非法标题、重复目标、越界ID与非重复删除均原子拒绝；同主题重复正文可安全合并',()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','验证',{slides:[{title:'保留',bullets:['内容'],notes:['备注']}]});
  const page=currentVersion(r).content.slides[0],before=JSON.stringify(r);
  for(const titles of [[],[{slideId:page.id,title:''}],[{slideId:page.id,title:'a'},{slideId:page.id,title:'b'}],[{slideId:'missing',title:'a'}]]){
    assert.throws(()=>applyWorkspaceCommand(state,{action:'editSlideTitles',resourceId:r.id,baseVersionId:r.currentVersionId,titles}));assert.equal(JSON.stringify(r),before);
  }
  assert.throws(()=>applyWorkspaceCommand(state,{action:'editSlideTitles',resourceId:r.id,baseVersionId:r.currentVersionId,titles:[{slideId:page.id,title:'新标题'}],removeDuplicateIds:[page.id]}),/只能合并/);assert.equal(JSON.stringify(r),before);
  const content=structuredClone(currentVersion(r).content);content.slides.push({...structuredClone(page),id:'duplicate',title:'重复页',bullets:['内','容']});commitResource(r,content,'构造重复页');
  applyWorkspaceCommand(state,{action:'editSlideTitles',resourceId:r.id,baseVersionId:r.currentVersionId,titles:[{slideId:page.id,title:'核心内容'}],removeDuplicateIds:['duplicate']});
  assert.equal(currentVersion(r).content.slides.length,1);assert.deepEqual(currentVersion(r).content.slides[0].notes,['备注']);
});

test('旧分页标题在导出的大标题中也去掉标记，不改存储中的页面字段',()=>{
  const model=slidesToExportModel([{title:'整体二分（续2）（续 2）',bullets:['说明'],notes:[]}],{canonical:true});
  const texts=[];class Fake{constructor(){this.ShapeType={line:'line'};}defineLayout(){}addSlide(){return {addText:(text,options)=>texts.push({text,options}),addShape(){},addNotes(){}};}}
  buildPresentation(model,Fake);assert.ok(texts.some(t=>t.text==='整体二分'&&t.options.fontSize===31));assert.ok(!texts.some(t=>/（续/.test(t.text)));assert.equal(model[0].title,'整体二分（续2）（续 2）');
});
