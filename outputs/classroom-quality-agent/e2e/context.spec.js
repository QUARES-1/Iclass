import {test,expect} from '@playwright/test';
test.beforeEach(async({request})=>{const s=await(await request.get('/api/workspace')).json();await request.post('/api/workspace',{data:{revision:s.revision,action:'clear'}});});
test('清空上下文支持取消，保留资源、设置和未保存编辑，刷新后历史不恢复且可继续对话',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/public/index.html');await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#sample').click();await expect(page.locator('#resources .resource')).toHaveCount(5);
  await page.locator('#request').fill('新建排序课件');await page.locator('#send').click();await expect(page.locator('#agent-stage')).toHaveText('执行完成');
  await expect(page.locator('#send')).toBeEnabled();const before=await(await request.get('/api/workspace')).json();expect(before.messages).toHaveLength(3);
  const card=page.locator('.slide-card').first();await card.locator('.slide-edit summary').click();await card.locator('[data-field=notes]').fill('未保存教师备注');
  await page.locator('#request').fill('输入中的新要求');page.once('dialog',d=>d.dismiss());await page.locator('#clear-context').click();await expect(page.locator('#messages .message')).toHaveCount(before.messages.length);
  page.once('dialog',d=>d.accept());await page.locator('#clear-context').click();await expect(page.locator('#messages .message')).toHaveCount(0);await expect(page.locator('#agent-progress')).toBeHidden();
  await expect(page.locator('#request')).toHaveValue('输入中的新要求');await expect(card.locator('[data-field=notes]')).toHaveValue('未保存教师备注');
  const after=await(await request.get('/api/workspace')).json();for(const key of ['requirements','materials','analysis','supplements','resources','selectedId'])expect(after[key]).toEqual(before[key]);expect(after.messages).toEqual([]);
  await card.locator('[data-save-slide]').click();await expect(page.locator('#save-status')).toContainText('已保存');await page.reload();await expect(page.locator('#send')).toBeEnabled();await expect(page.locator('#messages .message')).toHaveCount(0);await expect(page.locator('#agent-progress')).toBeHidden();
  await expect(page.locator('.slide-card').first().locator('[data-field=notes]')).toHaveValue('未保存教师备注');
  await page.locator('#clear-context').click();await expect(page.locator('#notice')).toContainText('没有历史对话');
  await page.locator('#request').fill('新建另一个PPT');await page.locator('#send').click();await expect(page.locator('#agent-stage')).toHaveText('执行完成');await expect(page.locator('#messages .message')).toHaveCount(2);
  const next=await(await request.get('/api/workspace')).json();expect(next.messages[0].text).toBe('新建另一个PPT');expect(next.resources).toHaveLength(before.resources.length+1);expect(errors).toEqual([]);
  await page.setViewportSize({width:390,height:844});await page.locator('[data-tab=chat]').click();await expect(page.locator('#clear-context')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('运行时提示先暂停，暂停后清空同时收起任务，刷新后无法继续旧任务',async({page,request})=>{
  await page.goto('/public/index.html');await expect(page.locator('#send')).toBeEnabled();await page.locator('#request').fill('新建长课件慢速');await page.locator('#send').click();await expect(page.locator('#agent-count')).toContainText(/[12]\/3 批/);
  await page.locator('#clear-context').click();await expect(page.locator('#notice')).toContainText('先暂停');await expect(page.locator('#messages .message')).toHaveCount(1);
  await page.locator('#agent-pause').click();await expect(page.locator('#agent-stage')).toHaveText('已暂停');await expect(page.locator('#send')).toBeEnabled();
  const old=await(await request.get('/api/workspace')).json(),jobId=old.messages[0].jobId;
  page.once('dialog',d=>d.accept());await page.locator('#clear-context').click();await expect(page.locator('#agent-progress')).toBeHidden();await expect(page.locator('#messages .message')).toHaveCount(0);
  await page.reload();await expect(page.locator('#send')).toBeEnabled();await expect(page.locator('#agent-progress')).toBeHidden();
  const resumed=await request.post('/api/workspace/agent/'+jobId+'/resume',{data:{}});expect(resumed.status()).toBe(409);expect((await(await request.get('/api/workspace')).json()).messages).toEqual([]);
});
