import {test,expect} from '@playwright/test';
async function create(request,title){const b=await(await request.get('/api/feedback/bootstrap')).json(),r=await request.post('/api/feedback/sessions',{data:{title,templateId:b.templates.versions[0].id}});expect(r.ok()).toBe(true);return r.json();}
async function open(page,c){await page.goto('/public/sprint3.html');await expect(page.locator('#save-status')).not.toHaveText('正在读取…');await page.locator('[data-class="'+c.id+'"]').click();await expect(page.locator('#class-title')).toHaveText(c.title);}
test('创建课堂等待期间保留下一条标题，并保护原课堂输入与对话草稿',async({page,request})=>{
  const original=await create(request,'创建等待保护原课堂');await open(page,original);await page.locator('#feedback-request').fill('原课堂未发送的要求');
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  await page.route('**/api/feedback/sessions',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});
  await page.locator('#new-title').fill('已提交的新课堂');await page.locator('#new-class button').click();await started;
  await expect(page.locator('#class-work')).toHaveAttribute('inert','');await page.locator('#new-title').fill('等待期间填写的下一堂课');release();
  await expect(page.locator('#class-title')).toHaveText('已提交的新课堂');await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');await expect(page.locator('#class-work')).not.toHaveAttribute('inert','');await expect(page.locator('#new-title')).toHaveValue('等待期间填写的下一堂课');
  await page.locator('[data-class="'+original.id+'"]').click();await expect(page.locator('#feedback-request')).toHaveValue('原课堂未发送的要求');await page.unrouteAll({behavior:'wait'});
});
test('报告保存遇到临时失败时保留草稿，重试只生成一次实际修订',async({page,request})=>{
  let c=await create(request,'保存重试保护课堂');const answers=Object.fromEntries(c.template.questions.map(q=>[q.id,q.type==='rating'?4:q.type==='multiple'?[q.options[0].id]:q.options?q.options[0].id:'合成意见'])),url='/api/feedback/sessions/'+c.id;
  const p=await(await request.post(url+'/preview',{data:{data:{records:[{id:'retry-one',answers}]}}})).json();expect((await request.post(url+'/import',{data:{revision:c.revision,previewId:p.id}})).ok()).toBe(true);await open(page,c);
  await page.locator('#analyze-feedback').click();await expect(page.locator('#report-text')).toHaveValue(/整体总结/);await expect(page.locator('#job-detail')).toHaveText('已完成');let fail=true;
  await page.route('**/api/feedback/sessions/'+c.id,async route=>{if(fail&&route.request().method()==='POST'&&route.request().postDataJSON()?.action==='report'){fail=false;await route.fulfill({status:503,json:{error:'测试临时保存失败，请重试。'}});}else await route.continue();});
  await page.locator('#report-text').fill('教师需要保留的修订');await page.locator('#save-report').click();await expect(page.locator('#notice')).toContainText('临时保存失败');await expect(page.locator('#report-text')).toHaveValue('教师需要保留的修订');await expect(page.locator('#save-status')).toContainText('未保存');
  await page.locator('#save-report').click();await expect(page.locator('#save-status')).toHaveText('已保存');c=await(await request.get(url)).json();const report=c.reports.find(r=>r.id===c.currentReportId);expect(report.text).toBe('教师需要保留的修订');expect(report.version).toBe(2);expect(report.history).toHaveLength(1);await page.unrouteAll({behavior:'wait'});
});
test('建议载入失败可原地重试，已有草稿刷新恢复，已发送的要求不会刷新复活',async({page,request})=>{
  let c=await create(request,'交接失败恢复课堂'),url='/api/feedback/sessions/'+c.id;
  c=await(await request.post(url,{data:{revision:c.revision,action:'suggestions',suggestions:[{id:'handoff-retry',text:'下节课演示完整函数及调用。',evidenceIds:[]}]}})).json();const handoff=await(await request.post(url+'/handoff',{data:{revision:c.revision,ids:['handoff-retry']}})).json();let fail=true,calls=0;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/workspace/agent'))calls++;});
  await page.route('**/api/feedback/handoffs/*',async route=>{if(fail){fail=false;await route.fulfill({status:503,json:{error:'测试临时连接失败'}});}else await route.continue();});
  await page.goto(handoff.url);await expect(page.getByRole('button',{name:'重试载入建议'})).toBeVisible();await page.locator('#request').fill('已有的备课草稿');await page.getByRole('button',{name:'重试载入建议'}).click();await expect(page.locator('.feedback-handoff-card')).toHaveCount(1);await expect(page.locator('#request')).toHaveValue('已有的备课草稿');expect(calls).toBe(0);
  await page.reload();await expect(page.locator('.feedback-handoff-card')).toBeVisible();await expect(page.locator('#request')).toHaveValue('已有的备课草稿');await page.locator('#request').fill('你好');await page.locator('#send').click();await expect(page.locator('#messages')).toContainText('你好！');await expect(page.locator('#request')).toHaveValue('');expect(calls).toBe(1);
  await page.reload();await expect(page.locator('.feedback-handoff-card')).toBeVisible();await expect(page.locator('#request')).toHaveValue('');expect(calls).toBe(1);await page.unrouteAll({behavior:'wait'});
});
