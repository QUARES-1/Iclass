import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { emptyWorkspace, createResource, currentVersion, applyWorkspaceCommand, applyPptOperations, commitResource } from '../src/workspace.js';
import { slidesToExportModel } from '../src/pptExport.js';
import { sampleActivities } from '../src/samples.js';
import { renderActivity,validateActivity } from '../src/interactive.js';
import { requestJSON } from '../src/model.js';
function fixture(){const s=emptyWorkspace();const r=createResource(s,'ppt','排序',{slides:[{title:'第一页面',section:'讲解',bullets:['第一要点'],notes:['人工备注']},{title:'第二页面',section:'讲解',bullets:['第二要点'],notes:[]},{title:'第三页面',section:'总结',bullets:['总结'],notes:[]}]});return {s,r};}
function cmd(s,r,action,extra={}){return applyWorkspaceCommand(s,{action,resourceId:r.id,baseVersionId:currentVersion(r).id,...extra});}
test('定向AI修改只提交指定页面字段，保留人工备注和其他页面',()=>{const {s,r}=fixture();const original=structuredClone(currentVersion(r).content);cmd(s,r,'confirm');const edit=applyPptOperations(r,[{action:'update',slideId:original.slides[1].id,patch:{example:'用四个数字举例'}}],[original.slides[1].id]);commitResource(r,edit.content,edit.summary,'llm');assert.equal(currentVersion(r).content.slides[1].status,'pending');assert.equal(currentVersion(r).content.slides[0].status,'confirmed');assert.deepEqual(currentVersion(r).content.slides[0].notes,['人工备注']);assert.equal(currentVersion(r).content.slides[2].title,original.slides[2].title);assert.throws(()=>applyPptOperations(r,[{action:'delete',slideId:original.slides[0].id}],[original.slides[1].id]),/范围/);});
test('恢复建立新版本，历史分支保留，后续编辑以恢复内容为准',()=>{const {s,r}=fixture();const base=currentVersion(r);cmd(s,r,'editSlide',{slideId:base.content.slides[0].id,patch:{title:'修改后'}});const changed=currentVersion(r);cmd(s,r,'undo');const restored=currentVersion(r);assert.equal(restored.content.slides[0].title,'第一页面');assert.notEqual(restored.id,base.id);assert.equal(r.versions.length,3);assert.ok(r.versions.includes(changed));assert.equal(restored.content.slides[0].status,'pending');cmd(s,r,'editSlide',{slideId:base.content.slides[0].id,patch:{example:'恢复后的例子'}});assert.equal(currentVersion(r).content.slides[0].title,'第一页面');});
test('互动正式确认绑定当前版本，修改后需要重新确认',()=>{const s=emptyWorkspace(),r=createResource(s,'game','示例',sampleActivities[0]);cmd(s,r,'confirm');assert.equal(currentVersion(r).confirmed,true);cmd(s,r,'editActivity',{title:'更难的测验',description:'修改规则说明'});assert.equal(currentVersion(r).confirmed,false);});
test('分页在资源创建时完成，导出canonical不会产生新页码',()=>{const s=emptyWorkspace(),r=createResource(s,'ppt','分页',{slides:[{title:'概念',section:'讲解',bullets:Array.from({length:9},(_,i)=>'要点'+i),notes:[]}]});const c=currentVersion(r).content;assert.equal(c.slides.length,3);assert.equal(new Set(c.slides.map(s=>s.id)).size,3);assert.equal(slidesToExportModel(c.slides,{canonical:true}).length,3);});
test('关联互动固定内容与版本，互动继续修改不改变PPT快照',()=>{const {s,r}=fixture(),g=createResource(s,'game','互动',sampleActivities[0]);const gv=currentVersion(g);cmd(s,r,'attach',{activityId:g.id,slideId:currentVersion(r).content.slides[0].id});cmd(s,g,'editActivity',{title:'新名称',description:'新的说明'});const a=currentVersion(r).content.slides[0].attachment;assert.equal(a.versionId,gv.id);assert.equal(a.content.title,gv.content.title);assert.ok(a.fileName.includes(gv.id));});
test('保存后重启可读，过期revision拒绝覆盖，保存失败保留原始文件',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'classroom-store-'));try{const store=new Store(root);let s=await store.update('workspace',0,emptyWorkspace(),c=>{c.requirements.topic='已保存';return c;});assert.equal((await new Store(root).read('workspace',{})).requirements.topic,'已保存');await assert.rejects(()=>store.update('workspace',0,emptyWorkspace(),c=>c),/已在其他操作/);await assert.rejects(()=>store.update('workspace',s.revision,emptyWorkspace(),()=>{throw new Error('失败');}));assert.equal((await store.read('workspace',{})).revision,s.revision);}finally{await rm(root,{recursive:true,force:true});}});
test('并发保存串行且不能覆盖同一基准版本',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'classroom-race-'));try{const store=new Store(root);const results=await Promise.allSettled([store.update('workspace',0,emptyWorkspace(),c=>c),store.update('workspace',0,emptyWorkspace(),c=>c)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);}finally{await rm(root,{recursive:true,force:true});}});
test('互动字符串按数据编码，不能注入脚本；禁止网络和父工作台访问',()=>{const a={...sampleActivities[0],title:'</script><script>fetch("/api/workspace")</script>'};const html=renderActivity(a);assert.ok(html.includes('sandbox')===false);assert.ok(html.includes("connect-src 'none'"));assert.ok(!html.includes(a.title));assert.ok(html.includes('\\u003c'));assert.throws(()=>validateActivity({...a,mode:'raw-html'}));});
test('模型失败抛出真实错误，不返回本地模板',async()=>{await assert.rejects(()=>requestJSON('test',{}, {apiKey:'unit-only',fetch:async()=>({ok:false,status:503})}),/HTTP 503/);await assert.rejects(()=>requestJSON('test',{}, {apiKey:'unit-only',fetch:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})})}),/缩小生成批次/);});

test('未改变内容的教师保存保留确认，AI无实际修改不能报告成功',()=>{const {s,r}=fixture();cmd(s,r,'confirm');const v=currentVersion(r);cmd(s,r,'editSlide',{slideId:v.content.slides[0].id,patch:{title:v.content.slides[0].title}});assert.equal(r.currentVersionId,v.id);assert.equal(currentVersion(r).content.slides[0].status,'confirmed');assert.throws(()=>commitResource(r,structuredClone(v.content),'无实际改变','llm'),/实际修改/);});

test('理解来源随知识点保存，人工改动更新来源，移除资料清空来源',()=>{
  const s=emptyWorkspace(),analysis={chapters:[],objectives:[],knowledgePoints:['稳定性'],keyPoints:[],difficultPoints:[]};
  applyWorkspaceCommand(s,{action:'material',material:{title:'课堂',content:'稳定性'}});
  applyWorkspaceCommand(s,{action:'context',analysis,supplements:[],source:'local'});assert.equal(s.analysisSource,'local');
  applyWorkspaceCommand(s,{action:'context',analysis,supplements:[{title:'补充'}]});assert.equal(s.analysisSource,'local');
  applyWorkspaceCommand(s,{action:'context',analysis:{...analysis,keyPoints:['相等时不交换']},supplements:[]});assert.equal(s.analysisSource,'teacher');
  applyWorkspaceCommand(s,{action:'removeMaterial',materialId:s.materials[0].id});assert.equal(s.analysis,null);assert.equal(s.analysisSource,null);
});

test('AI详细扩写自动紧接原页分页，保留稳定ID、教师备注、关联和其他页确认',()=>{
  const {s,r}=fixture();cmd(s,r,'confirm');const original=structuredClone(currentVersion(r).content),first=original.slides[0];
  first.attachment={title:'固定关联',resourceId:'resource-1',versionId:'version-1',content:{mode:'steps'}};
  currentVersion(r).content.slides[0].attachment=structuredClone(first.attachment);
  const bullets=Array.from({length:13},(_,i)=>'可执行的步骤 '+i),edit=applyPptOperations(r,[{action:'update',slideId:first.id,patch:{bullets}}],[first.id]);
  assert.match(edit.summary,/自动分页新增 3 页/);commitResource(r,edit.content,edit.summary,'llm');
  const pages=currentVersion(r).content.slides;assert.equal(pages.length,6);assert.equal(pages[0].id,first.id);
  assert.deepEqual(pages.slice(0,4).flatMap(p=>p.bullets),bullets);assert.equal(new Set(pages.map(p=>p.id)).size,6);
  for(const page of pages.slice(0,4)){assert.equal(page.status,'pending');assert.deepEqual(page.notes,first.notes);}
  assert.deepEqual(pages[0].attachment,first.attachment);assert.ok(pages.slice(1,4).every(p=>!p.attachment));
  assert.deepEqual(pages.slice(4),original.slides.slice(1));assert.equal(slidesToExportModel(pages,{canonical:true}).length,6);
  assert.throws(()=>applyPptOperations(r,[{action:'add',slide:{title:'范围外',bullets:[]}}],[first.id]),/范围/);
});

test('新增详解页可插入原页后，连续插入顺序稳定；错误位置不提交',()=>{
  const {r}=fixture(),before=structuredClone(currentVersion(r)),anchor=before.content.slides[0].id;
  const added=title=>({action:'add',afterSlideId:anchor,slide:{section:'讲解',title,bullets:['详解'],notes:[]}});
  const edit=applyPptOperations(r,[added('原理推导'),added('逐步演算')]);
  assert.deepEqual(edit.content.slides.map(s=>s.title),['第一页面','原理推导','逐步演算','第二页面','第三页面']);
  assert.throws(()=>applyPptOperations(r,[{...added('错误插入'),afterSlideId:'missing'}]),/插入位置/);assert.deepEqual(currentVersion(r),before);
});

test('不再有15或150页的课件数量上限，教师手动扩写也自动分页',()=>{
  const s=emptyWorkspace(),r=createResource(s,'ppt','完整长课',{slides:Array.from({length:160},(_,i)=>({title:'主题 '+i,section:'讲解',bullets:['原理'],notes:[]}))});
  assert.equal(currentVersion(r).content.slides.length,160);
  const first=currentVersion(r).content.slides[0];cmd(s,r,'editSlide',{slideId:first.id,patch:{bullets:Array.from({length:9},(_,i)=>'步骤 '+i)}});
  assert.equal(currentVersion(r).content.slides.length,162);assert.equal(currentVersion(r).content.slides[0].id,first.id);
});
