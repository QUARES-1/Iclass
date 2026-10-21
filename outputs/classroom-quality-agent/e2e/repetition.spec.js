import fs from 'node:fs/promises';
import {test,expect} from '@playwright/test';
async function classroom(page,request,title){
  const boot=await(await request.get('/api/feedback/bootstrap')).json(),response=await request.post('/api/feedback/sessions',{data:{title,templateId:boot.templates.versions[0].id}});expect(response.ok()).toBe(true);const c=await response.json();
  await page.goto('/public/sprint3.html');await expect(page.locator('#save-status')).not.toHaveText('正在读取…');
  await page.locator('[data-class="'+c.id+'"]').click();await expect(page.locator('#class-title')).toHaveText(title);return c.id;
}
test('连续增加及复制题目和选项，在页面内达到配置上限即停止追加',async({page,request})=>{
  await page.route('**/api/feedback/bootstrap',async route=>{const response=await route.fetch(),data=await response.json();data.limits.questions=12;data.limits.options=6;await route.fulfill({response,json:data});});
  await classroom(page,request,'编辑器连续操作上限');await page.locator('#template-panel > summary').click();
  await page.evaluate(()=>{for(let i=0;i<100;i++)document.querySelector('[data-o-add]').click();});await expect(page.locator('.question-editor').first().locator('[data-option]')).toHaveCount(6);await expect(page.locator('[data-o-add]').first()).toBeDisabled();
  await page.evaluate(()=>{for(let i=0;i<100;i++){document.querySelector('#add-question').click();document.querySelector('[data-q-copy]').click();}});await expect(page.locator('.question-editor')).toHaveCount(12);await expect(page.locator('#add-question')).toBeDisabled();await expect(page.locator('[data-q-copy]').first()).toBeDisabled();
  await page.locator('[data-q-delete]').last().click();await expect(page.locator('#add-question')).toBeEnabled();await page.locator('#add-question').click();await expect(page.locator('.question-editor')).toHaveCount(12);
});
test('慢网络连续轮询只保留一个后台读取，快速搜索合并请求',async({page,request})=>{
  const classId=await classroom(page,request,'慢请求堆积检查');let initial=true,polls=0,release;const gate=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);
  await page.route('**/api/feedback/sessions/'+classId,async route=>{
    const response=await route.fetch();if(route.request().method()!=='GET'){await route.fulfill({response});return;}
    const data=await response.json();data.sync={status:'syncing'};
    if(initial){initial=false;await route.fulfill({response,json:data});return;}
    polls++;entered();await gate;await route.fulfill({response,json:data});
  });
  await page.locator('#reload-feedback').click();await started;await page.waitForTimeout(5800);expect(polls).toBe(1);release();await page.unrouteAll({behavior:'wait'});
  let searches=0;page.on('request',r=>{if(r.url().includes('/records?'))searches++;});
  await page.locator('#records-panel > summary').click();await page.locator('#record-search').evaluate(input=>{for(let i=0;i<500;i++){input.value='快速输入'+i;input.dispatchEvent(new Event('input',{bubbles:true}));}});
  await expect.poll(()=>searches).toBe(1);await page.waitForTimeout(400);expect(searches).toBe(1);
});
test('任务进度迟迟不返回时，反复刷新也复用同一个进度请求',async({page,request})=>{
  const classId=await classroom(page,request,'任务请求复用压力');let reads=0,release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  await page.route('**/api/feedback/sessions/'+classId,async route=>{const response=await route.fetch(),data=await response.json();data.activeJobId='slow-job';data.jobIds=['slow-job'];await route.fulfill({response,json:data});});
  await page.route('**/api/feedback/sessions/'+classId+'/job?*',async route=>{reads++;entered();await gate;await route.fulfill({json:{id:'slow-job',status:'running',detail:'等待进度',plan:[],observations:[]}});});
  await page.locator('#reload-feedback').click();await started;
  for(let i=0;i<30;i++){await page.locator('#reload-feedback').click();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');}
  expect(reads).toBe(1);release();await page.unrouteAll({behavior:'wait'});
});
test('反复切换失败的历史回听，不累积等待音频元数据的监听器',async({page,request})=>{
  const boot=await(await request.get('/api/feedback/bootstrap')).json(),ids=[];
  for(const title of ['回听压力甲','回听压力乙']){const response=await request.post('/api/feedback/sessions',{data:{title,templateId:boot.templates.versions[0].id}});ids.push((await response.json()).id);}
  await page.route('**/api/feedback/sessions/*',async route=>{const response=await route.fetch(),data=await response.json();if(ids.includes(data.id)){data.reports=[{id:'synthetic-report',version:1,text:'合成回听报告',history:[],stale:false}];data.currentReportId='synthetic-report';}await route.fulfill({response,json:data});});
  await page.route('**/api/feedback/sessions/*/evidence?*',route=>route.fulfill({json:{records:[],template:boot.templates.versions[0],findings:[],segments:[{id:'synthetic-segment',start:0,end:2,text:'仅验证播放器失败路径。'}]}}));
  await page.route('**/api/feedback/sessions/*/audio?*',route=>route.fulfill({status:404,json:{error:'测试原音频不存在'}}));
  await page.goto('/public/sprint3.html');await expect(page.locator('#save-status')).not.toHaveText('正在读取…');
  for(let i=0;i<40;i++){await page.locator('[data-class="'+ids[i%2]+'"]').click();await expect(page.locator('#class-title')).toHaveText(i%2?'回听压力乙':'回听压力甲');await page.locator('#show-evidence').click();await page.locator('#evidence summary').filter({hasText:'转写与回听'}).click();await page.locator('[data-play-segment]').click();}
  const cdp=await page.context().newCDPSession(page),target=await cdp.send('Runtime.evaluate',{expression:'document.getElementById("evidence-player")'}),events=await cdp.send('DOMDebugger.getEventListeners',{objectId:target.result.objectId});
  expect(events.listeners.filter(e=>e.type==='loadedmetadata').length).toBeLessThanOrEqual(1);
});
test('连续载入示例与刷新后课堂、DOM和回收后堆内存保持稳定',async({page,request})=>{
  test.setTimeout(180000);await classroom(page,request,'浏览器重复载入压力');await page.locator('aside details > summary').click();
  const cdp=await page.context().newCDPSession(page);await cdp.send('HeapProfiler.enable');
  async function measure(phase){await cdp.send('HeapProfiler.collectGarbage');const heap=await cdp.send('Runtime.getHeapUsage'),dom=await cdp.send('Memory.getDOMCounters'),value={phase,heapUsed:heap.usedSize,...dom,classes:await page.locator('[data-class]').count()};console.log(JSON.stringify(value));return value;}
  async function click(id){await page.locator(id).click();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');}
  for(let i=0;i<10;i++){await click('#load-feedback-samples');await click('#reload-feedback');}
  const measurements=[await measure('warmup')];
  for(let group=0;group<4;group++){for(let i=0;i<50;i++){await click('#load-feedback-samples');await click('#reload-feedback');}measurements.push(await measure('round-'+(group+1)));}
  const first=measurements[0],last=measurements.at(-1),result={sampleLoads:210,refreshes:210,measurements,heapGrowth:last.heapUsed-first.heapUsed,nodeGrowth:last.nodes-first.nodes,listenerGrowth:last.jsEventListeners-first.jsEventListeners};
  await fs.mkdir('artifacts',{recursive:true});await fs.writeFile('artifacts/repetition-browser-result.json',JSON.stringify(result,null,2));
  expect(last.classes).toBe(first.classes);expect(result.nodeGrowth).toBeLessThanOrEqual(10);expect(result.listenerGrowth).toBeLessThanOrEqual(10);expect(result.heapGrowth).toBeLessThan(8*1024*1024);
});
