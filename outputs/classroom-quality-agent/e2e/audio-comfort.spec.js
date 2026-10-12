import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const wav=path.resolve('artifacts/audio/asr-example-zh.wav');
async function fixture(request,count=1){
  const old=await(await request.get('/api/classroom')).json();await request.post('/api/classroom',{data:{revision:old.revision,action:'clear'}});
  let state=await(await request.post('/api/classroom/audio?name=fixture.wav&revision='+ (await(await request.get('/api/classroom')).json()).revision,{data:await fs.readFile(wav),headers:{'Content-Type':'application/octet-stream'}})).json();
  const segments=Array.from({length:count},(_,i)=>({id:'seg-'+i,start:i*.1,end:i*.1+.08,text:'教学片段'+i,timestampSource:'fixture'}));
  state.transcriptVersions=[{id:'raw',audioId:state.audio.id,audio:state.audio,source:'asr',original:true,createdAt:new Date().toISOString(),segments}];state.currentTranscriptId='raw';
  state.reports=[{id:'report',transcriptId:'raw',courseVersion:state.courseVersion,course:state.course,mode:'overview',stale:false,createdAt:new Date().toISOString(),detailSections:[],sections:{summary:[{id:'summary',text:'完整课堂的统一总结',kind:'transcript',evidenceIds:['seg-0'],confirmed:false,edited:false}],suggestions:[{id:'suggestion',text:'改进建议',kind:'ai-inference',evidenceIds:['seg-0'],confirmed:false,edited:false}],knowledge:[],emphasis:[],difficulties:[],observations:[]}}];state.currentReportId='report';
  await fs.writeFile(path.resolve('artifacts/browser-data/classroom.json'),JSON.stringify(state));return state;
}
test('更换录音先保存转写草稿，历史校正版和原稿都能恢复',async({page,request})=>{
  await fixture(request);await page.goto('/public/sprint2.html');await page.locator('#transcript-panel > summary').click();await page.locator('[data-segment]').fill('尚未手动保存的正确术语');
  await page.locator('#audio-file').setInputFiles(wav);await expect(page.locator('#upload-status')).toContainText('完整录音已保存');
  const saved=await(await request.get('/api/classroom')).json();expect(saved.transcriptVersions).toHaveLength(2);expect(saved.transcriptVersions[1].segments[0].text).toBe('尚未手动保存的正确术语');expect(saved.transcriptVersions[0].segments[0].text).toBe('教学片段0');
  await page.locator('#classroom-history > summary').click();await page.locator('#transcript-history').selectOption(saved.transcriptVersions[1].id);await page.locator('#restore-transcript').click();await expect(page.locator('[data-segment]')).toHaveValue('尚未手动保存的正确术语');await expect(page.locator('#save-status')).toContainText('已保存');
});
test('导出等待期间继续打字会阻止旧稿下载，重试导出包含最新文字',async({page,request})=>{
  await fixture(request);await page.goto('/public/sprint2.html');const summary=page.locator('[data-report-item=summary]');await summary.getByText('修订与确认',{exact:true}).click();
  let unblock;const gate=new Promise(r=>unblock=r);let requested;const reached=new Promise(r=>requested=r);
  await page.route('**/api/classroom/report?*',async route=>{const response=await route.fetch();requested();await gate;await route.fulfill({response});});
  const downloads=[];page.on('download',dl=>downloads.push(dl));await page.locator('#export-report').click();await reached;await summary.locator('textarea').fill('导出期间新增的总结文字');unblock();
  await expect(page.locator('#notice')).toContainText('又有修改');expect(downloads).toHaveLength(0);await page.unroute('**/api/classroom/report?*');
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#export-report').click()]);const file=await dl.path();expect(await fs.readFile(file,'utf8')).toContain('导出期间新增的总结文字');
});
test('删除未保存结论不会遗留脏状态，历史恢复拿回删除前的内容',async({page,request})=>{
  await fixture(request);await page.goto('/public/sprint2.html');const summary=page.locator('[data-report-item=summary]');await summary.getByText('修订与确认',{exact:true}).click();await summary.locator('textarea').fill('不需要保存的草稿');await summary.locator('[data-item-delete]').click();await expect(summary).toHaveCount(0);await expect(page.locator('#save-status')).toContainText('已保存');
  const saved=await(await request.get('/api/classroom')).json();await page.locator('#classroom-history > summary').click();await page.locator('#report-history').selectOption('report:'+saved.reports[0].history[0].id);await page.locator('#restore-report').click();await expect(summary.locator('.report-text')).toHaveText('完整课堂的统一总结');
});
test('翻页与搜索保留未保存校正，排除误识别不改变原稿与时间',async({page,request})=>{
  await fixture(request,125);await page.goto('/public/sprint2.html');await page.locator('#transcript-panel > summary').click();await expect(page.locator('[data-segment]')).toHaveCount(60);await page.locator('[data-segment=seg-0]').fill('老师修正术语');await page.locator('#transcript-next').click();await page.locator('[data-segment=seg-60]').fill('第二页的修订');
  await page.locator('#transcript-search').fill('老师修正');await expect(page.locator('[data-segment]')).toHaveCount(1);await expect(page.locator('[data-segment]')).toHaveValue('老师修正术语');await page.locator('[data-exclude=seg-0]').check();await page.locator('#save-transcript').click();
  const saved=await(await request.get('/api/classroom')).json(),t=saved.transcriptVersions.at(-1);expect(t.segments[0].excluded).toBe(true);expect(t.segments[60].text).toBe('第二页的修订');expect(t.segments[0].start).toBe(0);expect(saved.transcriptVersions[0].segments[0].text).toBe('教学片段0');
  await page.locator('#transcript-time').fill('00:12');await page.locator('#jump-transcript').click();await expect(page.locator('#transcript-page-meta')).toContainText('121—125');
});
test('片段停止后播放整段不受旧截止时间影响，原生跳转清除片段限制',async({page,request})=>{
  await fixture(request);await page.goto('/public/sprint2.html');await page.locator('#transcript-panel > summary').click();await page.locator('[data-play]').click();await expect(page.locator('#audio-player')).toHaveJSProperty('paused',true);
  await page.locator('#play-full').click();await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);await expect.poll(()=>page.locator('#audio-player').evaluate(p=>p.currentTime)).toBeGreaterThan(.5);
  await page.locator('[data-play]').click();await page.locator('#audio-player').evaluate(p=>{p.currentTime=1;});await page.locator('#play-full').click();await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);
});
test('问候直接回复，讨论可以修改总结并按要求补充单类分析',async({page,request})=>{
  await fixture(request);await page.goto('/public/sprint2.html');await page.locator('#classroom-discussion > summary').click();await page.locator('#classroom-request').fill('你好');await page.locator('#classroom-send').click();await expect(page.locator('#classroom-messages')).toContainText('你好！');expect((await(await request.get('/api/classroom')).json()).jobs).toHaveLength(0);
  await page.locator('#classroom-request').fill('把总结改成教师的新总结');await page.locator('#classroom-send').click();await expect(page.locator('[data-report-item=summary] .report-text')).toHaveText('教师的新总结');await expect(page.locator('[data-report-item=suggestion] .report-text')).toHaveText('改进建议');
  await page.locator('#classroom-request').fill('补充提问与时间节奏分析');await page.locator('#classroom-send').click();await expect(page.locator('#report-detail-observations')).toHaveCount(1);await expect(page.locator('[data-report-item=summary] .report-text')).toHaveText('教师的新总结');
  await page.locator('#clear-classroom-conversation').click();await expect(page.locator('#classroom-messages')).toBeEmpty();await expect(page.locator('[data-report-item=summary] .report-text')).toHaveText('教师的新总结');
});
test('手机先看到整体总结，滚动后播放器仍可操作，兼容副本能播放ADPCM录音',async({page,request})=>{
  await fixture(request);await page.setViewportSize({width:390,height:844});await page.goto('/public/sprint2.html');expect((await page.locator('.audio-review').boundingBox()).y).toBeLessThan(200);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#audio-file').setInputFiles(path.resolve('artifacts/audio/adpcm_ima_wav.wav'));await expect(page.locator('#upload-status')).toContainText('完整录音已保存');const state=await(await request.get('/api/classroom')).json();expect(state.audio.playbackFile).toMatch(/\.play\.mp3$/);
  await page.locator('#play-full').click();await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);expect(await page.locator('#audio-player').evaluate(p=>p.error)).toBeNull();await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));expect((await page.locator('#player-dock').boundingBox()).y).toBeLessThan(844);await page.screenshot({path:'artifacts/browser/audio-comfort-mobile.png'});
});
test('完整转写独立显示全部片段，搜索分页不截断全文，未保存校正进入导出并可切换原稿',async({page,request})=>{
  await fixture(request,125);await page.goto('/public/sprint2.html');await page.locator('#transcript-full > summary').click();await expect(page.locator('#transcript-full-text')).toHaveValue(/教学片段124/);
  await page.locator('#transcript-panel > summary').click();await page.locator('[data-segment=seg-0]').fill('全文第一段教师修正');await page.locator('#transcript-search').fill('教学片段124');await expect(page.locator('[data-segment]')).toHaveCount(1);
  await expect(page.locator('#transcript-full-text')).toHaveValue(/全文第一段教师修正/);await expect(page.locator('#transcript-full-text')).toHaveValue(/教学片段60/);
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#export-transcript').click()]);const text=await fs.readFile(await dl.path(),'utf8');expect(text).toContain('片段数：125');expect(text).toContain('全文第一段教师修正');expect(text).toContain('教学片段124');
  const saved=await(await request.get('/api/classroom')).json();expect(saved.transcriptVersions.at(-1).segments[0].text).toBe('全文第一段教师修正');await page.locator('#transcript-full-source').selectOption('original');await expect(page.locator('#transcript-full-text')).toHaveValue(/^教学片段0 /);await page.locator('#transcript-full-times').check();await expect(page.locator('#transcript-full-text')).toHaveValue(/^\[00:00—00:00\]/);
});
test('已有繁体转写可以保存教师校正后统一简体，原稿和完成报告保留且导出为简体',async({page,request})=>{
  const state=await fixture(request);state.transcriptVersions[0].segments[0].text='這是課堂錄音與網絡節點。';state.reports[0].sections.summary[0].text='課堂講解網絡節點。';state.reports[0].sections.summary[0].confirmed=true;await fs.writeFile(path.resolve('artifacts/browser-data/classroom.json'),JSON.stringify(state));
  await page.goto('/public/sprint2.html');await page.locator('#transcript-panel > summary').click();await page.locator('[data-segment]').fill('這是教師手動校正，C++ split/merge。');await page.locator('#save-transcript').click();
  // The teacher edit legitimately invalidates the report; regenerating restores
  // alignment before pure script conversion, which must not invalidate it again.
  await page.locator('#analyze').click();await expect(page.locator('#jobs')).toContainText('已完成');await page.locator('#simplify-transcript').click();await expect(page.locator('[data-segment]')).toHaveValue('这是教师手动校正，C++ split/merge。');await expect(page.locator('#transcript-meta')).toContainText('简体转写');await expect(page.locator('#report-meta')).toContainText('对应当前输入');
  await page.locator('#transcript-full > summary').click();const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#export-transcript').click()]);expect(await fs.readFile(await dl.path(),'utf8')).toContain('这是教师手动校正，C++ split/merge。');await page.locator('#transcript-full-source').selectOption('original');await expect(page.locator('#transcript-full-text')).toHaveValue('這是課堂錄音與網絡節點。');
  const saved=await(await request.get('/api/classroom')).json();expect(saved.transcriptVersions).toHaveLength(3);expect(saved.transcriptVersions[1].segments[0].text).toBe('這是教師手動校正，C++ split/merge。');expect(saved.reports.at(-1).textNormalization.sourceReportId).toBe(saved.reports.at(-2).id);
});
test('生成七条较完整的改进建议，页面、导出与刷新均保留全部内容',async({page,request})=>{
  const state=await fixture(request);state.course.title='建议展开验证';await fs.writeFile(path.resolve('artifacts/browser-data/classroom.json'),JSON.stringify(state));await page.goto('/public/sprint2.html');await page.locator('#analyze').click();await expect(page.locator('[data-report-section=suggestions] .report-item')).toHaveCount(7);await expect(page.locator('[data-report-section=summary] .report-item')).toHaveCount(1);
  const texts=await page.locator('[data-report-section=suggestions] .report-text').allTextContents();expect(texts.every(t=>t.length>240)).toBe(true);const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#export-report').click()]);const exported=await fs.readFile(await dl.path(),'utf8');for(const text of texts)expect(exported).toContain(text);
  await page.reload();await expect(page.locator('[data-report-section=suggestions] .report-item')).toHaveCount(7);expect(await page.locator('[data-report-section=suggestions] .report-text').allTextContents()).toEqual(texts);
});
