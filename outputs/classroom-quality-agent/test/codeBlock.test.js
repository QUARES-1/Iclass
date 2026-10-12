import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCodeBlock,splitCodeSource,codeDisplayRows} from '../src/codeBlock.js';
import {emptyWorkspace,createResource,currentVersion,applyPptOperations,commitResource,applyWorkspaceCommand} from '../src/workspace.js';
import {slidesToExportModel} from '../src/pptExport.js';
import {toMarkdown} from '../src/pptGenerator.js';

test('代码按完整行分页，保留缩进、空行、运算符与尾部换行，输出不混入源码',()=>{
  const source='#include <iostream>\n\n'+Array.from({length:45},(_,i)=>'    // 行 '+i+'：x < 3 && y >= 1\n').join('')+'int main() { std::cout << "ok"; }\n';
  assert.equal(splitCodeSource(source).join(''),source);
  const state=emptyWorkspace(),r=createResource(state,'ppt','实现',{slides:[{title:'原理与实现',bullets:['核心函数与调用'],notes:[],example:'验证一次',code:{language:'cpp',source,expectedOutput:'ok\n'}}]});
  const pages=currentVersion(r).content.slides,codePages=pages.filter(p=>p.code&&p.code.kind!=='output');
  assert.equal(codePages.map(p=>p.code.source).join(''),source);assert.equal(new Set(codePages.map(p=>p.code.blockId)).size,1);
  assert.equal(pages.filter(p=>p.example).length,1);assert.equal(pages[0].code,undefined);
  assert.equal(pages.at(-1).code.kind,'output');assert.equal(pages.at(-1).code.source,'ok\n');
  assert.equal(slidesToExportModel(pages,{canonical:true}).length,pages.length);
  const md=toMarkdown(pages);assert.match(md,/```cpp\n#include <iostream>/);assert.match(md,/x < 3 && y >= 1/);assert.match(md,/预期运行输出/);
});

test('普通续页不复制示例和反例，人工修改后的分页也一致',()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','原理',{slides:[{title:'结构原理',bullets:Array.from({length:9},(_,i)=>'原理'+i),notes:[],example:'一个验证输入',counterExample:'一个必要边界'}]});
  assert.equal(currentVersion(r).content.slides.filter(s=>s.example).length,1);
  const first=currentVersion(r).content.slides[0];
  const edit=applyPptOperations(r,[{action:'update',slideId:first.id,patch:{bullets:Array.from({length:9},(_,i)=>'新原理'+i)}}]);commitResource(r,edit.content,'改写');
  assert.equal(currentVersion(r).content.slides.filter(s=>s.example).length,1);assert.equal(currentVersion(r).content.slides.filter(s=>s.counterExample).length,1);
});

test('代码修改保留语言与分组，清除代码后恢复普通布局；拒绝非法或超长代码',()=>{
  const state=emptyWorkspace(),r=createResource(state,'ppt','代码',{slides:[{title:'函数',bullets:[],notes:[],code:{language:'cpp',source:'int f() { return 1; }'}}]});
  const first=currentVersion(r).content.slides[0],edit=applyPptOperations(r,[{action:'update',slideId:first.id,patch:{code:{source:'int f() { return 2; }'}}}]);commitResource(r,edit.content,'改代码');
  const code=currentVersion(r).content.slides[0].code;assert.equal(code.language,'cpp');assert.equal(code.blockId,first.code.blockId);
  const removed=applyPptOperations(r,[{action:'update',slideId:first.id,patch:{code:null}}]);commitResource(r,removed.content,'清除');assert.equal(currentVersion(r).content.slides[0].code,undefined);assert.notEqual(currentVersion(r).content.slides[0].layout,'code');
  for(const code of [{source:''},{source:'a'.repeat(60001)},{source:'a',language:'cpp\ncode'},{source:'a',expectedOutput:42}])assert.throws(()=>validateCodeBlock(code));
  assert.throws(()=>splitCodeSource('a'.repeat(2000)),/单行过长/);
});

test('概念页替换整份程序时清理旧代码续页，单独编辑代码分段保留其它段',()=>{
  const state=emptyWorkspace(),source='int main() {\n'+Array.from({length:30},()=> '    // 实现说明\n').join('')+'    return 0;\n}\n';
  const r=createResource(state,'ppt','实现',{slides:[{title:'核心原理',bullets:['一种表示'],notes:[],code:{language:'cpp',source}}]});
  const head=currentVersion(r).content.slides[0],oldPages=currentVersion(r).content.slides;
  assert.equal(head.code,undefined);assert.ok(oldPages.filter(s=>s.code).length>1);
  const replacement='int main() { return 1; }\n';
  const edit=applyPptOperations(r,[{action:'update',slideId:head.id,patch:{code:{language:'cpp',source:replacement}}}]);commitResource(r,edit.content,'重写');
  const pages=currentVersion(r).content.slides;assert.equal(pages.filter(s=>s.code).length,1);assert.equal(pages.find(s=>s.code).code.source,replacement);assert.ok(pages.every(s=>s.paginationRootId===head.id));
});

test('代码末页不足三行时均衡相邻两页，避免一页只有括号而不改源码',()=>{
  const source=Array.from({length:40},(_,i)=>'    // line '+i+'\n').join('')+'}\n',parts=splitCodeSource(source);
  assert.equal(parts.join(''),source);assert.equal(parts.length,3);assert.ok(parts.at(-1).split('\n').length>4);
});

test('第一代码段可原子替换整份程序和输出，保留原理及无关页，限制范围不能越界',()=>{
  const state=emptyWorkspace(),source=Array.from({length:40},(_,i)=>'// old '+i+'\n').join('');
  const r=createResource(state,'ppt','替换',{slides:[{title:'原理',bullets:['数据表示'],notes:[],code:{language:'cpp',source,expectedOutput:'old output'}},{title:'无关讲解',bullets:['保留'],notes:[]}]});
  const old=currentVersion(r).content.slides,first=old.find(s=>s.code?.kind!=='output'&&s.code),op={action:'update',slideId:first.id,patch:{code:{source:'int main() { return 0; }\n',expectedOutput:'new output',replaceBlock:true}}};
  assert.throws(()=>applyPptOperations(r,[op],[first.id]),/续页/);
  const edit=applyPptOperations(r,[op]);commitResource(r,edit.content,'整体替换');
  const pages=currentVersion(r).content.slides;assert.deepEqual(pages[0],old[0]);assert.deepEqual(pages.at(-1),old.at(-1));
  assert.equal(pages.filter(s=>s.code?.kind!=='output'&&s.code).map(s=>s.code.source).join(''),'int main() { return 0; }\n');
  assert.equal(pages.find(s=>s.code?.kind==='output').code.source,'new output');assert.ok(pages.every(s=>!s.code?.source.includes('old')));
});

test('优先放下一个或多个完整函数，稍长函数整体保留，注释和字符串括号不误分',()=>{
  const f=name=>'int '+name+'() {\n'+Array.from({length:12},()=> '    // } 并不是函数结尾\n').join('')+'    const char* s = "{ }";\n    return 1;\n}\n';
  const source='#include <iostream>\n\n'+f('first')+'\n'+f('second')+'\nint last() { return 3; }\n',parts=splitCodeSource(source,20,'cpp');
  assert.equal(parts.join(''),source);
  for(const name of ['first','second']){const body=f(name);assert.ok(parts.some(p=>p.includes(body)),name+'完整函数应在一页');}
  assert.ok(parts.length>=2);assert.ok(parts.every(p=>codeDisplayRows(p)<=28));
  const longer='void longFunction() {\n'+Array.from({length:22},()=> '    work();\n').join('')+'}\n';
  assert.ok(splitCodeSource(longer,20,'cpp').some(p=>p===longer));
});

test('类方法、构造器、原始字符串与JavaScript正则均按完整部分分页',()=>{
  const source='struct Demo {\n    int value;\n    Demo() : value{0}\n    { value = 1; }\n'+Array.from({length:3},(_,i)=>'    void f'+i+'() {\n        auto s = R"tag( } /* { )tag";\n'+Array.from({length:8},()=> '        value++;\n').join('')+'    }\n').join('')+'};\n';
  const parts=splitCodeSource(source,20,'cpp');assert.equal(parts.join(''),source);
  assert.ok(parts.some(p=>p.includes('Demo() : value{0}\n    { value = 1; }')));
  for(let i=0;i<3;i++)assert.ok(parts.some(p=>p.includes('void f'+i+'() {')&&p.includes('value++;\n    }')));
  const js='function first() {\n    const pattern = /}/;\n'+Array.from({length:12},()=> '    console.log("}");\n').join('')+'}\n\nfunction second() {\n    return 2;\n}\n';
  assert.ok(splitCodeSource(js,20,'javascript').some(p=>p.includes(js.slice(0,js.indexOf('\n\nfunction second')))));
});

test('Python函数含装饰器、嵌套函数和三引号字符串时不在函数内硬拆',()=>{
  const first='@decorator\ndef first(x):\n    """}\n    {\n    """\n    def inner():\n        return x\n'+Array.from({length:9},()=> '    x += 1\n').join('')+'    return inner()\n';
  const source='import math\n\n'+first+'\ndef second():\n    return 2\n',parts=splitCodeSource(source,20,'python');
  assert.equal(parts.join(''),source);assert.ok(parts.some(p=>p.includes(first)));
});

test('确实过长的函数按完整语句分段，保留源码并限制单页容量',()=>{
  const source='void run() {\n'+Array.from({length:60},()=> '    work();\n').join('')+'}\n',parts=splitCodeSource(source,20,'cpp');
  assert.equal(parts.join(''),source);assert.ok(parts.length>1);assert.ok(parts.every(p=>codeDisplayRows(p)<=28));
  assert.ok(parts.slice(0,-1).every(p=>p.endsWith('work();\n')));
});

test('旧的硬切代码可重新按函数排页，原稿、备注、输出、互动和其它页面保留；重复整理不增版本',()=>{
  const source='int first() {\n'+Array.from({length:12},()=> '    work();\n').join('')+'    return 1;\n}\n\nint second() {\n'+Array.from({length:12},()=> '    work();\n').join('')+'    return 2;\n}\n';
  const lines=source.match(/[^\n]*\n/g),pieces=[lines.slice(0,10).join(''),lines.slice(10,20).join(''),lines.slice(20).join('')],state=emptyWorkspace();
  const r=createResource(state,'ppt','旧分页',{slides:[...pieces.map((source,i)=>({title:'代码'+i,bullets:[],notes:['备注'+i],code:{language:'cpp',blockId:'legacy-code',source,part:i+1,parts:3}})),{title:'输出',bullets:[],notes:[],code:{language:'text',blockId:'legacy-code',kind:'output',source:'1 2'}},{title:'无关原理',bullets:['保留'],notes:['教师输入']}]});
  const old=currentVersion(r);old.content.slides[2].attachment={title:'已关联互动',versionId:'activity-version'};const snapshot=structuredClone(old);
  applyWorkspaceCommand(state,{action:'reflowCode',resourceId:r.id,baseVersionId:old.id});
  const pages=currentVersion(r).content.slides,codePages=pages.filter(p=>p.code?.kind!=='output'&&p.code);
  assert.equal(codePages.map(p=>p.code.source).join(''),source);assert.equal(codePages.length,2);
  assert.ok(codePages[0].code.source.includes('int first() {')&&codePages[0].code.source.includes('return 1;\n}'));
  assert.ok(codePages[1].code.source.includes('int second() {')&&codePages[1].code.source.includes('return 2;\n}'));
  assert.deepEqual(codePages[0].notes,['备注0','备注1','备注2']);assert.ok(pages.some(p=>p.attachment?.title==='已关联互动'));
  assert.deepEqual(pages.find(p=>p.title==='无关原理'),snapshot.content.slides.at(-1));assert.equal(pages.find(p=>p.code?.kind==='output').code.source,'1 2');assert.deepEqual(r.versions[0],snapshot);
  const count=r.versions.length;applyWorkspaceCommand(state,{action:'reflowCode',resourceId:r.id,baseVersionId:r.currentVersionId});assert.equal(r.versions.length,count);
});
