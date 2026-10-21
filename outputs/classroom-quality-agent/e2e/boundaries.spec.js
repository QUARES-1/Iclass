import { test,expect } from '@playwright/test';
import path from 'node:path';
import { emptyClassroom } from '../src/classroom.js';
const wav=path.resolve('artifacts/audio/asr-example-zh.wav');
test.beforeEach(async({request})=>{for(const name of ['workspace','classroom']){const s=await(await request.get('/api/'+name)).json();expect((await request.post('/api/'+name,{data:{revision:s.revision,action:'clear'}})).ok()).toBe(true);}});
async function ready(page,url='/public/index.html'){await page.goto(url);await expect(page.locator('#save-status')).toContainText(/已恢复|已保存/);}

test('试玩进度在保存教学要求后保留',async({page})=>{
  await ready(page);await page.locator('#sample').click();await page.locator('#resources .resource').filter({hasText:'点击答题'}).click();await expect(page.locator('#preview-status')).toContainText('已初始化');
  const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'相同关键字元素的相对顺序保持',exact:true}).click();await expect(frame.locator('#feedback')).toContainText('回答正确');
  await page.locator('#topic').fill('已完成试玩的课程');await page.locator('#save-settings').click();await expect(page.locator('#save-status')).toContainText('已保存');await expect(frame.locator('#feedback')).toContainText('回答正确');
});

test('保存期间继续输入，保留最新文字、展开状态和光标',async({page})=>{
  await ready(page);await page.locator('#sample').click();await page.locator('#resources .resource').filter({hasText:'示例 PPT'}).click();const card=page.locator('.slide-card').first();await card.locator('summary').click();
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  await page.route('**/api/workspace',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='editSlide'){entered();await gate;}await route.continue();});
  const notes=card.locator('[data-field=notes]');await notes.fill('第一版教师备注');await card.locator('[data-save-slide]').click();await start;await notes.fill('请求发出后继续输入的第二版备注');await notes.focus();release();
  await expect(page.locator('#save-status')).toContainText('有未保存修改');await expect(notes).toHaveValue('请求发出后继续输入的第二版备注');await expect(notes).toBeVisible();await expect(notes).toBeFocused();
  const state=await(await page.request.get('/api/workspace')).json(),r=state.resources.find(r=>r.id===state.selectedId);expect(r.versions.find(v=>v.id===r.currentVersionId).content.slides[0].notes).toEqual(['第一版教师备注']);
  await card.locator('[data-save-slide]').click();await expect(page.locator('#save-status')).toContainText('已保存');await page.reload();await card.locator('summary').click();await expect(notes).toHaveValue('请求发出后继续输入的第二版备注');
});

test('超长资料截取状态刷新保留，仍能理解；批量超额在上传前说明',async({page})=>{
  await ready(page);await page.locator('#files').setInputFiles({name:'long.txt',mimeType:'text/plain',buffer:Buffer.from('教学重点：稳定性\n'+'课'.repeat(250010))});
  await expect(page.locator('#materials .material > .muted').first()).toContainText('截取');await page.reload();await expect(page.locator('#materials .material > .muted').first()).toContainText('截取');await page.getByText('知识点与前沿补充',{exact:true}).click();await page.locator('#understand').click();await expect(page.locator('#analysis-source')).toContainText('本地规则解析');
  let uploads=0;page.on('request',r=>{if(r.url().includes('/api/extract-file'))uploads++;});
  await page.locator('#files').setInputFiles(Array.from({length:20},(_,i)=>({name:`lesson-${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('课堂资料')})));
  await expect(page.locator('#parse-status')).toContainText('剩余 19');expect(uploads).toBe(0);await expect(page.locator('#materials .material')).toHaveCount(1);
});

test('音频上传可见等待并可取消，取消不替换原录音；同一坏文件可重选',async({page})=>{
  await ready(page,'/public/sprint2.html');await page.locator('#audio-file').setInputFiles(wav);await expect(page.locator('#audio-info')).toContainText('已保存');const before=await(await page.request.get('/api/classroom')).json();
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);await page.route('**/api/classroom/audio?**',async route=>{if(route.request().method()==='POST'){entered();await gate;try{await route.continue();}catch{}}else await route.continue();});
  await page.locator('#audio-file').setInputFiles(wav);await start;await expect(page.locator('#transcribe')).toBeDisabled();await expect(page.locator('#upload-status')).toContainText(/上传|检查/);await page.locator('#cancel-audio-upload').click();release();await expect(page.locator('#upload-status')).toContainText('取消');await expect(page.locator('#transcribe')).toBeEnabled();expect((await(await page.request.get('/api/classroom')).json()).audio.id).toBe(before.audio.id);
  await page.unroute('**/api/classroom/audio?**');for(let i=0;i<2;i++){await page.locator('#audio-file').setInputFiles({name:'broken.wav',mimeType:'audio/wav',buffer:Buffer.from('broken')});await expect(page.locator('#notice')).toContainText('音频');await expect(page.locator('#audio-file')).toHaveValue('');}expect((await(await page.request.get('/api/classroom')).json()).audio.id).toBe(before.audio.id);
});

test('模型任务完成时，未保存课程草稿保留且报告自动出现',async({page})=>{
  const state=emptyClassroom(),t={id:'t1',audioId:'a1',source:'asr',original:true,segments:[{id:'seg',start:1,end:2,text:'课堂内容',timestampSource:'fixture'}]};state.audio={id:'a1',name:'fixture.wav',duration:3,bytes:100};state.transcriptVersions=[t];state.currentTranscriptId=t.id;state.jobs=[{id:'job',type:'analysis',stage:'analyzing'}];let finish=false;
  await page.route(/\/api\/classroom(?:\?.*)?$/,async route=>{const next=structuredClone(state);if(finish){next.revision=1;next.jobs[0].stage='completed';next.currentReportId='report';next.reports=[{id:'report',transcriptId:t.id,stale:false,sections:Object.fromEntries(['summary','knowledge','emphasis','difficulties','observations','suggestions'].map(k=>[k,[{id:k,text:'完成后的报告',kind:k==='difficulties'?'hypothesis':k==='emphasis'?'ai-inference':'transcript',evidenceIds:['seg'],confirmed:false}]]))}];}await route.fulfill({json:next});});
  await ready(page,'/public/sprint2.html');await page.locator('#course-options > summary').click();await page.locator('#course-description').fill('任务完成时正在输入的草稿');await page.locator('#course-description').focus();finish=true;
  await expect(page.locator('#report .report-item')).toHaveCount(6,{timeout:8000});await expect(page.locator('#course-description')).toHaveValue('任务完成时正在输入的草稿');await expect(page.locator('#course-description')).toBeFocused();await expect(page.locator('#analyze')).toBeEnabled();
});


test('不支持、空白及超大资料在上传前提示，混合批次中的正常文件仍保存',async({page})=>{
  await ready(page);let uploads=0;page.on('request',r=>{if(r.url().includes('/api/extract-file'))uploads++;});
  await page.locator('#files').setInputFiles([{name:'old.doc',mimeType:'application/msword',buffer:Buffer.from('old')},{name:'empty.md',mimeType:'text/plain',buffer:Buffer.alloc(0)},{name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(15*1024*1024+1,65)},{name:'valid.TXT',mimeType:'text/plain',buffer:Buffer.from('排序与稳定性')}]);
  await expect(page.locator('#parse-status')).toContainText('成功 1，失败 3');expect(uploads).toBe(1);await expect(page.locator('#materials .material')).toHaveCount(4);await expect(page.locator('#files')).toHaveValue('');
  await page.reload();await expect(page.locator('#materials .material')).toHaveCount(4);await expect(page.locator('#materials')).toContainText('另存为');await expect(page.locator('#materials')).toContainText('15 MiB');
});

test('麦克风权限等待防止重复启动，停止后可放弃录音再上传文件',async({page})=>{
  await page.addInitScript(()=>{window.micCalls=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async args=>{window.micCalls++;await new Promise(r=>window.releaseMic=r);return original(args);};});
  await ready(page,'/public/sprint2.html');await page.locator('#record-options > summary').click();await page.locator('#record-start').click();await expect(page.locator('#record-start')).toBeDisabled();await expect(page.locator('#audio-file')).toBeDisabled();expect(await page.evaluate(()=>window.micCalls)).toBe(1);await page.evaluate(()=>window.releaseMic());await expect(page.locator('#record-stop')).toBeEnabled();await page.waitForTimeout(1100);await page.locator('#record-stop').click();await expect(page.locator('#discard-recording')).toBeVisible();await expect(page.locator('#audio-file')).toBeDisabled();await page.locator('#discard-recording').click();await expect(page.locator('#audio-file')).toBeEnabled();await expect(page.locator('#save-recording')).toBeHidden();await page.locator('#audio-file').setInputFiles(wav);await expect(page.locator('#audio-info')).toContainText('已保存');
});

test('手机宽度完成上传、理解、生成、编辑、确认、导出，没有横向溢出',async({page})=>{
  await page.setViewportSize({width:390,height:844});await ready(page);await page.locator('[data-tab=sources]').click();await page.locator('#files').setInputFiles({name:'lesson.txt',mimeType:'text/plain',buffer:Buffer.from('章节：排序算法\n教学重点：稳定排序\n难点：同值元素的相对顺序')});await expect(page.locator('#parse-status')).toContainText('成功 1');await page.getByText('知识点与前沿补充',{exact:true}).click();await page.locator('#understand').click();await expect(page.locator('#analysis-source')).toContainText('本地规则解析');await page.locator('[data-tab=chat]').click();await page.locator('#request').fill('新建排序课程PPT');await page.locator('#send').click();await expect(page.locator('.slide-card')).toHaveCount(3);await page.locator('[data-tab=preview]').click();const card=page.locator('.slide-card').first();await card.locator('summary').click();await card.locator('[data-field=example]').fill('移动端修改：同值元素保持顺序');await card.locator('[data-save-slide]').click();await expect(page.locator('#save-status')).toContainText('已保存');await card.locator('[data-field=example]').focus();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/boundaries/mobile-edit.png',fullPage:true});await page.locator('#btn-confirm-all').click();await expect(page.locator('#export-final')).toBeEnabled();const download=page.waitForEvent('download');await page.locator('#export-final').click();expect((await download).suggestedFilename()).toMatch(/\.pptx$/);
});


test('AI等待期间新输入的下一条要求不被清空或覆盖',async({page})=>{
  await ready(page);let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  await page.route('**/api/workspace/agent',async route=>{entered();await gate;await route.continue();});
  await page.locator('#request').fill('新建排序PPT');await page.locator('#send').click();await start;await page.locator('#request').fill('下一条：补充课堂案例');release();await expect(page.locator('.slide-card')).toHaveCount(3);await expect(page.locator('#request')).toHaveValue('下一条：补充课堂案例');
});

test('确认保存过程中新增编辑，保留草稿并阻止确认旧内容',async({page})=>{
  await ready(page);await page.locator('#sample').click();await page.locator('#resources .resource').filter({hasText:'示例 PPT'}).click();const card=page.locator('.slide-card').first();await card.locator('summary').click();
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);await page.route('**/api/workspace',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='editSlide'){entered();await gate;}await route.continue();});
  await card.locator('[data-field=notes]').fill('准备确认的备注');await page.locator('#btn-confirm-all').click();await start;await card.locator('[data-field=notes]').fill('保存过程中追加的备注');release();await expect(page.locator('#notice')).toContainText('又有新修改');await expect(card.locator('[data-field=notes]')).toHaveValue('保存过程中追加的备注');await expect(page.locator('#export-final')).toBeDisabled();
});

test('音频扩展名伪装被真实解码检查拒绝，原录音保留',async({page})=>{
  await ready(page,'/public/sprint2.html');await page.locator('#audio-file').setInputFiles(wav);await expect(page.locator('#audio-info')).toContainText('已保存');const original=await(await page.request.get('/api/classroom')).json();
  const fs=await import('node:fs/promises');await page.locator('#audio-file').setInputFiles({name:'fake.mp3',mimeType:'audio/mpeg',buffer:await fs.readFile(wav)});await expect(page.locator('#notice')).toContainText('扩展名');await expect(page.locator('#audio-file')).toHaveValue('');expect((await(await page.request.get('/api/classroom')).json()).audio.id).toBe(original.audio.id);
});


test('理解资料期间移除输入，不会将旧结果保存到新上下文',async({page})=>{
  await ready(page);await page.locator('#files').setInputFiles({name:'lesson.txt',mimeType:'text/plain',buffer:Buffer.from('教学重点：稳定排序')});await expect(page.locator('#parse-status')).toContainText('成功 1');await page.getByText('知识点与前沿补充',{exact:true}).click();
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);await page.route('**/api/analyze-materials',async route=>{entered();await gate;await route.continue();});
  let releaseRemoval,removalStarted;const removalGate=new Promise(r=>releaseRemoval=r),removalStart=new Promise(r=>removalStarted=r);await page.route('**/api/workspace',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().action==='removeMaterial'){removalStarted();await removalGate;}await route.continue();});
  await page.locator('#understand').click();await start;await expect(page.locator('#understand')).toBeDisabled();await page.locator('[data-remove-material]').click();await removalStart;release();await page.waitForResponse('**/api/analyze-materials');releaseRemoval();await expect(page.locator('#materials .material')).toHaveCount(0);await expect(page.locator('#notice')).toContainText('本次结果未应用');await expect(page.locator('#analysis-source')).toBeEmpty();await expect(page.locator('#understand')).toBeEnabled();expect((await(await page.request.get('/api/workspace')).json()).analysis).toBeNull();
});

test('反复载入本地示例不重复、不清空知识点或备注、不重置试玩',async({page})=>{
  await ready(page);await page.locator('#sample').click();await expect(page.locator('#resources .resource')).toHaveCount(5);await page.locator('#resources .resource').filter({hasText:'点击答题'}).click();await expect(page.locator('#preview-status')).toContainText('已初始化');const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'相同关键字元素的相对顺序保持',exact:true}).click();await expect(frame.locator('#feedback')).toContainText('回答正确');
  await page.locator('#instructions').fill('仍在输入的教学要求');const original=await(await page.request.get('/api/workspace')).json();for(let i=0;i<6;i++){await page.locator('#sample').click();await expect(page.locator('#notice')).toContainText('没有重复添加');}
  await expect(page.locator('#materials .material')).toHaveCount(4);await expect(page.locator('#resources .resource')).toHaveCount(5);await expect(page.locator('#instructions')).toHaveValue('仍在输入的教学要求');await expect(frame.locator('#feedback')).toContainText('回答正确');expect(await(await page.request.get('/api/workspace')).json()).toEqual(original);
});

test('示例载入等待期间按钮禁用，重复点击不排队追加',async({page})=>{
  await ready(page);let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);let calls=0;await page.route('**/api/workspace/sample',async route=>{calls++;entered();await gate;await route.continue();});await page.locator('#sample').click();await start;await expect(page.locator('#sample')).toBeDisabled();await expect(page.locator('#sample')).toHaveText('正在载入…');await page.locator('#sample').dispatchEvent('click');expect(calls).toBe(1);release();await expect(page.locator('#resources .resource')).toHaveCount(5);await expect(page.locator('#sample')).toBeEnabled();await expect(page.locator('#sample')).toHaveText('载入本地示例');
});
