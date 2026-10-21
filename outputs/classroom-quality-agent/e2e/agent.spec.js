import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
test.beforeEach(async({request})=>{const s=await(await request.get('/api/workspace')).json();await request.post('/api/workspace',{data:{revision:s.revision,action:'clear'}});});
test('自主修正输出页时保留已有程序，needsCode不要求重复返回源码，检查后正常提交',async({page,request})=>{
  await page.goto('/public/index.html');await expect(page.locator('#send')).toBeEnabled();await page.locator('#request').fill('新建输出修正验证课件');await page.locator('#send').click();await expect(page.locator('#agent-stage')).toHaveText('执行完成');await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('.slide-card')).toHaveCount(2);const state=await(await request.get('/api/workspace')).json(),r=state.resources[0],v=r.versions.find(v=>v.id===r.currentVersionId),job=await(await request.get('/api/workspace/agent/'+state.messages[0].jobId)).json();
  expect(job.repairRound).toBe(1);expect(job.calls).toBe(5);expect(job.review.passed).toBe(true);expect(r.versions).toHaveLength(1);expect(v.content.slides.find(s=>s.code.kind==='output').code.source).toBe('9');expect(v.content.slides.find(s=>s.code.kind!=='output').code.source).toBe('int square(int x) { return x * x; }\n');
  await page.reload();await expect(page.locator('.slide-card')).toHaveCount(2);await expect(page.locator('#agent-stage')).toHaveText('执行完成');await expect(page.locator('#messages')).not.toContainText('没有返回code.source');
});
test('智能体自动拆批、检查修正、草稿原子提交，计划与完整页导航可查看',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/public/index.html');await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#request').fill('新建长课件自动，讲清楚并可实操');await page.locator('#send').click();
  await expect(page.locator('#agent-stage')).toHaveText('执行完成');await expect(page.locator('.slide-card')).toHaveCount(7);
  await page.getByText('查看执行计划',{exact:true}).click();await page.getByText('查看执行与修正记录',{exact:true}).click();await expect(page.locator('#agent-plan')).toContainText('教学内容');await expect(page.locator('#agent-observations')).toContainText('模型本次输出未完整返回');
  const [draft]=await Promise.all([page.waitForEvent('popup'),page.locator('#agent-draft').click()]);await expect(draft.locator('#draft-stage')).toContainText('任务已完成');await expect(draft.locator('.draft-page')).toHaveCount(7);await draft.setViewportSize({width:390,height:844});await draft.evaluate(()=>{const p=document.createElement('p');p.textContent='compareAndSwap_'.repeat(100);document.querySelector('.draft-page').append(p);});expect(await draft.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await draft.close();
  const s=await(await request.get('/api/workspace')).json(),r=s.resources[0],j=await(await request.get('/api/workspace/agent/'+s.messages[0].jobId)).json();
  expect(j.repairRound).toBe(1);expect(j.completedBatches).toBe(5);expect(r.versions).toHaveLength(1);expect(j.review.passed).toBe(true);
  expect(r.versions[0].content.slides.at(-1).example).toContain('[3, 1, 2]');
  await page.locator('#page-jump').selectOption(r.versions[0].content.slides.at(-1).id);await expect(page.locator('.slide-card').last()).toBeInViewport();expect(errors).toEqual([]);
});
test('执行途中暂停，刷新保留计划与草稿，继续后不重复创建资源',async({page,request})=>{
  await page.goto('/public/index.html');await expect(page.locator('#send')).toBeEnabled();await page.locator('#request').fill('新建长课件慢速');await page.locator('#send').click();
  await expect(page.locator('#agent-count')).toContainText(/[12]\/3 批/);await page.locator('#agent-pause').click();await expect(page.locator('#agent-stage')).toHaveText('已暂停');
  let s=await(await request.get('/api/workspace')).json();expect(s.resources).toHaveLength(0);
  const [draft]=await Promise.all([page.waitForEvent('popup'),page.locator('#agent-draft').click()]);await expect(draft.locator('#draft-stage')).toContainText('尚未完成最终检查');await expect(draft.locator('.draft-page').first()).toBeVisible();await draft.close();
  await page.reload();await expect(page.locator('#agent-resume')).toBeVisible();await page.locator('#agent-resume').click();await expect(page.locator('#agent-stage')).toHaveText('执行完成');
  await expect(page.locator('.slide-card')).toHaveCount(7);s=await(await request.get('/api/workspace')).json();expect(s.resources).toHaveLength(1);expect(s.resources[0].versions).toHaveLength(1);
});
test('首页设置入口可点击，桌面和手机布局没有横向溢出',async({page})=>{
  await fs.mkdir('artifacts/agent',{recursive:true});await page.goto('/');await expect(page.getByRole('heading',{name:'我的课程'})).toBeVisible();const settings=page.getByRole('link',{name:'模型与提示词设置',exact:true});await expect(settings).toBeVisible();
  await page.screenshot({path:'artifacts/agent/home-desktop.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await settings.click();await expect(page.locator('#prompt-agent')).toBeVisible();await expect(page.locator('#batch-pages')).toHaveValue('3');
  await page.goto('/');await page.setViewportSize({width:390,height:844});await expect(settings).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/agent/home-mobile.png',fullPage:true});
});
