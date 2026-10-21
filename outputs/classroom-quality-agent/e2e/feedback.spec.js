import {test,expect} from '@playwright/test';
async function create(page,title){
  await page.goto('/public/sprint3.html');await expect(page.locator('#save-status')).not.toHaveText('正在读取…');await page.locator('#new-title').fill(title);await page.locator('#new-class button').click();await expect(page.locator('#class-title')).toHaveText(title);
  // Other cases deliberately edit the global template. Each new fixture class
  // starts from the original definition so repeated runs remain independent.
  const boot=await(await page.request.get('/api/feedback/bootstrap')).json(),entry=boot.sessions.find(c=>c.title===title),c=await(await page.request.get('/api/feedback/sessions/'+entry.id)).json();
  if(c.template.id!==boot.templates.versions[0].id){expect((await page.request.post('/api/feedback/sessions/'+c.id,{data:{revision:c.revision,action:'update',templateId:boot.templates.versions[0].id}})).ok()).toBe(true);await page.locator('#reload-feedback').click();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');}
  return c.id;
}
async function provider(request){
  const current=await(await request.get('/api/feedback/settings')).json();
  const response=await request.post('/api/feedback/settings',{data:{revision:current.revision,baseUrl:'http://127.0.0.1:3108/provider',accessToken:'browser-provider-fixture'}});
  expect(response.ok()).toBe(true);
}
async function reportClass(page,request,title){
  await create(page,title);const boot=await(await request.get('/api/feedback/bootstrap')).json(),entry=boot.sessions.find(c=>c.title===title);
  let c=await(await request.get('/api/feedback/sessions/'+entry.id)).json();
  c=await(await request.post('/api/feedback/sessions/'+c.id,{data:{revision:c.revision,action:'update',templateId:boot.templates.versions[0].id}})).json();
  const preview=await(await request.post('/api/feedback/sessions/'+c.id+'/preview',{data:{data:{records:[{id:'round-one',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4}}]}}})).json();
  expect((await request.post('/api/feedback/sessions/'+c.id+'/import',{data:{revision:c.revision,previewId:preview.id}})).ok()).toBe(true);
  await page.locator('#reload-feedback').click();await page.locator('#analyze-feedback').click();await expect(page.locator('#report-text')).toHaveValue(/整体总结/);await expect(page.locator('#job-detail')).toHaveText('已完成');return c.id;
}
test('模板结构可改，下课立即发布与同步，只有问卷也能整体复盘并携建议到备课页',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await provider(request);
  await create(page,'反馈闭环测试');
  await page.locator('#template-panel > summary').click();
  const before=await page.locator('.question-editor').count();await page.locator('#add-question-type').selectOption('text');await page.locator('#add-question').click();
  await expect(page.locator('.question-editor')).toHaveCount(before+1);
  await page.locator('[data-q-label]').last().fill('希望下节课展示什么？');
  await page.locator('#save-template').click();await expect(page.locator('#notice')).toContainText('模板已保存');
  await page.locator('#template-panel > summary').click();
  await page.locator('#end-course').click();await expect(page.locator('#publish-status')).toContainText('已发布',{timeout:15000});
  await expect(page.locator('#survey-qr')).toBeVisible();
  await expect.poll(()=>page.locator('#survey-qr').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  await page.locator('#sync-feedback').click();await expect(page.locator('#statistics')).toContainText('2 份反馈',{timeout:15000});
  await expect(page.locator('#statistics')).toContainText('含无效项 0');
  await page.locator('#feedback-request').fill('你好');await page.locator('#send-feedback').click();await expect(page.locator('#feedback-messages')).toContainText('你好！');
  await expect(page.locator('#report-text')).toHaveValue('');
  await page.locator('#analyze-feedback').click();await expect(page.locator('#report-text')).toHaveValue(/整体总结/,{timeout:15000});
  await expect(page.locator('#ppt-suggestions textarea')).toHaveCount(2);
  await page.locator('#report-text').fill('教师修订的整体总结。');await page.locator('#save-report').click();await expect(page.locator('#save-status')).toContainText('已保存');
  await page.locator('#confirm-report').click();await expect(page.locator('#report-status')).toContainText('已确认');
  await page.screenshot({path:'artifacts/sprint3-desktop.png',fullPage:true});
  const download=page.waitForEvent('download');await page.locator('#export-report').click();expect((await download).suggestedFilename()).toContain('复盘');
  await page.locator('#handoff-suggestions').click();await expect(page).toHaveURL(/index.html\?feedback=/);
  await expect(page.locator('.feedback-handoff-card')).toContainText('反馈闭环测试');
  await expect(page.locator('#request')).toHaveValue(/完整函数/);
  await expect(page.locator('#messages')).not.toContainText('整体复盘与建议已保存');
  expect(errors).toEqual([]);
});
test('本地导入先预览，重复文件不重复计数，手机可查看统计与原始反馈',async({page})=>{
  await page.setViewportSize({width:390,height:844});await create(page,'手机导入课堂');
  await page.locator('summary').filter({hasText:'导入问卷结果'}).click();
  const data={records:[{id:'local-test-one',source:'local',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4,'q-comments':'需要更多代码示范。'}}]};
  const file={name:'feedback.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))};
  await page.locator('#feedback-file').setInputFiles(file);await expect(page.locator('#import-preview')).toContainText('有效 1');
  await page.locator('#commit-import').click();await expect(page.locator('#statistics')).toContainText('1 份反馈');
  await page.locator('#feedback-file').setInputFiles(file);await expect(page.locator('#import-preview')).toContainText('重复 1');
  await page.locator('#commit-import').click();await expect(page.locator('#statistics')).toContainText('1 份反馈');
  await page.locator('#records-panel > summary').click();await expect(page.locator('#feedback-records')).toContainText('local-test-one');
  await expect(page.locator('#feedback-job')).not.toBeVisible();
  await page.locator('[data-reason]').fill('等待核对的意见');await page.locator('#record-search').fill('找不到的内容');await expect(page.locator('#feedback-records')).toContainText('没有匹配');
  await page.locator('#record-search').fill('');await expect(page.locator('[data-reason]')).toHaveValue('等待核对的意见');
  await page.locator('[data-exclude]').check();await page.locator('[data-save-exclude]').click();await expect(page.locator('#statistics')).toContainText('排除 1');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/sprint3-mobile.png',fullPage:true});
});
test('无模型密钥时各入口显示可跳过向导，测试不保存，保存后不再弹出',async({page,request})=>{
  const original=await(await request.get('/api/model-settings')).json();
  try{
    await request.post('/api/model-settings',{data:{revision:original.revision,clearApiKey:true}});
    for(const path of ['home.html','index.html','sprint2.html','sprint3.html']){
      await page.goto('/public/'+path);await expect(page.locator('.api-setup')).toBeVisible();await page.locator('#setup-skip').click();await expect(page.locator('.api-setup')).not.toBeVisible();
      await page.evaluate(()=>sessionStorage.removeItem('model-setup-skipped'));
    }
    await page.reload();await expect(page.locator('.api-setup')).toBeVisible();
    await page.locator('#setup-key').fill('browser-test-fixture');await page.locator('#setup-test').click();await expect(page.locator('#setup-status')).toContainText('连接成功');
    expect((await(await request.get('/api/model-settings')).json()).apiKeyConfigured).toBe(false);
    await page.locator('#setup-form button[type=submit]').click();await expect(page.locator('.api-setup')).not.toBeVisible();
    await page.reload();await expect(page.locator('#save-status')).not.toHaveText('正在读取…');await expect(page.locator('.api-setup')).toHaveCount(0);
    const saved=await(await request.get('/api/model-settings')).json();expect(saved.apiKeyConfigured).toBe(true);expect(saved.apiKey).toBeUndefined();
  }finally{const saved=await(await request.get('/api/model-settings')).json();await request.post('/api/model-settings',{data:{revision:saved.revision,apiKey:'browser-test-fixture'}});}
});
test('更换为空文件、坏编码或错误类型后旧预览不能被误导入',async({page})=>{
  await create(page,'导入边界课堂');await page.locator('summary').filter({hasText:'导入问卷结果'}).click();
  const good={name:'feedback.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({records:[{id:'good',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4}}]}))};
  for(const file of [{name:'empty.json',mimeType:'application/json',buffer:Buffer.alloc(0)},{name:'bad.json',mimeType:'application/json',buffer:Buffer.from([0xff,0xfe,0x00])},{...good,name:'feedback.txt'}]){
    await page.locator('#feedback-file').setInputFiles(good);await expect(page.locator('#commit-import')).toBeEnabled();
    await page.locator('#feedback-file').setInputFiles(file);await expect(page.locator('#commit-import')).toBeDisabled();await expect(page.locator('#import-preview')).toContainText('预览未完成');
  }
  await expect(page.locator('#statistics')).toContainText('0 份反馈');
});
test('建议异步载入和刷新保留教师输入，重复插入不重复、不调用模型或修改课件',async({page,request})=>{
  await create(page,'交接草稿课堂');const title=await page.locator('#class-title').textContent(),boot=await(await request.get('/api/feedback/bootstrap')).json(),entry=boot.sessions.find(c=>c.title===title);
  let c=await(await request.get('/api/feedback/sessions/'+entry.id)).json();
  c=await(await request.post('/api/feedback/sessions/'+c.id,{data:{revision:c.revision,action:'suggestions',suggestions:[{id:'draft',text:'用完整函数示范关键操作。',evidenceIds:[]}]}})).json();
  const handoff=await(await request.post('/api/feedback/sessions/'+c.id+'/handoff',{data:{revision:c.revision,ids:['draft']}})).json();
  const before=await(await request.get('/api/workspace')).json();let calls=0;page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(chat|agent)/.test(r.url()))calls++;});
  await page.route('**/api/feedback/handoffs/*',async route=>{const response=await route.fetch();await new Promise(r=>setTimeout(r,600));await route.fulfill({response});});
  await page.goto(handoff.url);await expect(page.locator('#save-status')).toContainText(/已保存|已恢复/);await page.locator('#request').fill('教师先写好的备课要求');
  await expect(page.locator('.feedback-handoff-card')).toBeVisible();await expect(page.locator('#request')).toHaveValue('教师先写好的备课要求');
  await page.locator('[data-insert-feedback]').click();await page.locator('[data-insert-feedback]').click();expect((await page.locator('#request').inputValue()).match(/用完整函数/g)).toHaveLength(1);
  await page.locator('#request').fill('教师编辑过的完整草稿');await page.reload();await expect(page.locator('.feedback-handoff-card')).toBeVisible();await expect(page.locator('#request')).toHaveValue('教师编辑过的完整草稿');
  const after=await(await request.get('/api/workspace')).json();expect(after.revision).toBe(before.revision);expect(after.selectedId).toBe(before.selectedId);expect(calls).toBe(0);
  await page.unrouteAll({behavior:'wait'});
});
test('后台刷新和保存等待保护新编辑，模板恢复保持历史问卷不变',async({page,request})=>{
  await create(page,'编辑保护课堂');
  await page.locator('summary').filter({hasText:'课堂信息与资料'}).click();
  await page.route('**/api/feedback/sessions/*',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='update'){const result=await route.fetch();await new Promise(r=>setTimeout(r,500));await route.fulfill({response:result});}else await route.continue();
  });
  const pendingSave=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/feedback/sessions/'));
  await page.locator('#course-description').fill('第一版说明');await page.locator('#course-form button[type=submit]').click();
  await page.locator('#course-description').fill('等待期间继续输入的说明');await expect(page.locator('#save-status')).toContainText('未保存');
  await expect(page.locator('#course-description')).toHaveValue('等待期间继续输入的说明');
  await pendingSave;await page.unrouteAll({behavior:'wait'});await page.locator('#course-form button[type=submit]').click();await expect(page.locator('#save-status')).toHaveText('已保存');
  await page.locator('#template-panel > summary').click();await page.locator('[data-q-delete]').first().click();await page.locator('#save-template').click();await expect(page.locator('#notice')).toContainText('模板已保存');
  const title=await page.locator('#class-title').textContent(),bootstrap=await(await request.get('/api/feedback/bootstrap')).json(),session=bootstrap.sessions.find(s=>s.title===title);
  const saved=await(await request.get('/api/feedback/sessions/'+session.id)).json();expect(saved.template.questions.length).toBeGreaterThan(0);
  await page.locator('#restore-template').click();await expect(page.locator('.question-editor')).toHaveCount(9);
  const persisted=await(await request.get('/api/feedback/sessions/'+session.id)).json();expect(persisted.template.questions.length).toBe(saved.template.questions.length);
});
test('报告导出等待中的新编辑保留，不下载旧稿；可主动载入保存版本',async({page,request})=>{
  await create(page,'导出保护课堂');const boot=await(await request.get('/api/feedback/bootstrap')).json(),entry=boot.sessions.find(c=>c.title==='导出保护课堂');
  let c=await(await request.get('/api/feedback/sessions/'+entry.id)).json();
  c=await(await request.post('/api/feedback/sessions/'+c.id,{data:{revision:c.revision,action:'update',templateId:boot.templates.versions[0].id}})).json();
  const preview=await(await request.post('/api/feedback/sessions/'+c.id+'/preview',{data:{data:{records:[{id:'export-one',answers:{'q-difficulty':'hard','q-pace':'pace_fast','q-understanding':'understood_some','q-clarity':4,'q-interaction':'interaction_ok','q-rating':4}}]}}})).json();
  await request.post('/api/feedback/sessions/'+c.id+'/import',{data:{revision:c.revision,previewId:preview.id}});await page.locator('#reload-feedback').click();
  await page.locator('#analyze-feedback').click();await expect(page.locator('#report-text')).toHaveValue(/整体总结/);
  let downloads=0;page.on('download',()=>downloads++);
  await page.route('**/api/feedback/sessions/*/report?*',async route=>{const response=await route.fetch();await new Promise(r=>setTimeout(r,600));await route.fulfill({response});});
  await page.locator('#export-report').click();await page.locator('#report-text').fill('导出等待期间的新修订');
  await expect(page.locator('#notice')).toContainText('导出等待期间内容已变化');await expect(page.locator('#report-text')).toHaveValue('导出等待期间的新修订');expect(downloads).toBe(0);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#discard-report-edit').click();await expect(page.locator('#report-text')).toHaveValue(/整体总结/);
  await page.unrouteAll({behavior:'wait'});
});
test('保存课堂信息等待期间改截止时间或模板，仍保留未保存草稿',async({page,request})=>{
  await create(page,'截止时间草稿课堂');await page.locator('summary').filter({hasText:'课堂信息与资料'}).click();
  let release,entered;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await page.route('**/api/feedback/sessions/*',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='update'){const response=await route.fetch();entered();await gate;await route.fulfill({response});}else await route.continue();
  });
  await page.locator('#course-description').fill('已提交的课堂信息');await page.locator('#course-form button[type=submit]').click();await waiting;
  await page.locator('#course-deadline').fill('2027-01-01T19:30');release();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');
  await expect(page.locator('#course-deadline')).toHaveValue('2027-01-01T19:30');await expect(page.locator('#save-status')).toContainText('未保存');
  await page.unrouteAll({behavior:'wait'});await page.locator('#course-form button[type=submit]').click();await expect(page.locator('#save-status')).toHaveText('已保存');
  const boot=await(await request.get('/api/feedback/bootstrap')).json(),c=await(await request.get('/api/feedback/sessions/'+boot.sessions.find(c=>c.title==='截止时间草稿课堂').id)).json();expect(Date.parse(c.deadline)).toBe(Date.parse('2027-01-01T19:30:00+08:00'));
});
test('确认或携带建议保存等待期间的新编辑保留，须再次保存后操作',async({page,request})=>{
  const classId=await reportClass(page,request,'确认交接保护课堂');
  let release,entered,action='report';let waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await page.route('**/api/feedback/sessions/*',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON()?.action===action){const response=await route.fetch();entered();await gate;await route.fulfill({response});}else await route.continue();
  });
  await page.locator('#report-text').fill('第一版人工修订');await page.locator('#confirm-report').click();await waiting;await page.locator('#report-text').fill('等待确认时继续修改的版本');release();
  await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');await expect(page.locator('#report-status')).not.toContainText('已确认');await expect(page.locator('#report-text')).toHaveValue('等待确认时继续修改的版本');
  const saved=await(await request.get('/api/feedback/sessions/'+classId)).json();expect(saved.reports.find(r=>r.id===saved.currentReportId).confirmed).toBe(false);
  action='suggestions';waiting=new Promise(r=>entered=r);gate=new Promise(r=>release=r);
  await page.locator('#ppt-suggestions textarea').first().fill('第一版建议');await page.locator('#handoff-suggestions').click();await waiting;await page.locator('#ppt-suggestions textarea').first().fill('等待交接时继续修改的建议');release();
  await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');await expect(page).toHaveURL(/sprint3.html$/);await expect(page.locator('#ppt-suggestions textarea').first()).toHaveValue('等待交接时继续修改的建议');await expect(page.locator('#save-status')).toContainText('未保存');
  await page.unrouteAll({behavior:'wait'});
});
test('切换与新建课堂隔离对话草稿，返回原课堂可继续输入',async({page})=>{
  const aId=await create(page,'草稿课堂甲');await page.locator('#feedback-request').fill('甲班尚未发送的要求');
  await page.locator('#new-title').fill('草稿课堂乙');await page.locator('#new-class button').click();await expect(page.locator('#class-title')).toHaveText('草稿课堂乙');await expect(page.locator('#feedback-request')).toHaveValue('');
  const bId=await page.locator('[data-class][aria-current="true"]').getAttribute('data-class');
  await page.locator('#feedback-request').fill('乙班尚未发送的要求');await page.locator('[data-class="'+aId+'"]').click();await expect(page.locator('#class-title')).toHaveText('草稿课堂甲');await expect(page.locator('#feedback-request')).toHaveValue('甲班尚未发送的要求');
  await page.locator('[data-class="'+bId+'"]').click();await expect(page.locator('#feedback-request')).toHaveValue('乙班尚未发送的要求');
});
test('后台旧读取迟到时不覆盖已保存的新信息或降低课堂版本',async({page,request})=>{
  await create(page,'迟到刷新保护课堂');const boot=await(await request.get('/api/feedback/bootstrap')).json(),classId=boot.sessions.find(c=>c.title==='迟到刷新保护课堂').id;
  await page.locator('summary').filter({hasText:'课堂信息与资料'}).click();
  let phase='start',release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);
  await page.route('**/api/feedback/sessions/'+classId,async route=>{
    const response=await route.fetch();if(route.request().method()!=='GET'){await route.fulfill({response});return;}
    if(phase==='start'){phase='poll';const data=await response.json();data.sync={status:'syncing'};await route.fulfill({response,json:data});return;}
    if(phase==='poll'){phase='held';entered();await gate;}await route.fulfill({response});
  });
  await page.locator('#reload-feedback').click();await waiting;
  await page.locator('#course-description').fill('后台刷新之后的新版本');await page.locator('#course-form button[type=submit]').click();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/feedback/sessions/'+classId)&&r.request().method()==='GET');release();await response;await page.unrouteAll({behavior:'wait'});
  await expect(page.locator('#course-description')).toHaveValue('后台刷新之后的新版本');
  await page.locator('#course-description').fill('下一次仍可正常保存');await page.locator('#course-form button[type=submit]').click();await expect(page.locator('#save-status')).toHaveText('已保存');await expect(page.locator('#notice')).not.toContainText('冲突');
});
test('切换课堂清除旧导入预览、搜索和证据面板，不能把甲班预览导入乙班',async({page,request})=>{
  await create(page,'预览隔离甲');await page.locator('summary').filter({hasText:'导入问卷结果'}).click();
  const boot=await(await request.get('/api/feedback/bootstrap')).json(),c=await(await request.get('/api/feedback/sessions/'+boot.sessions.find(s=>s.title==='预览隔离甲').id)).json(),answers=Object.fromEntries(c.template.questions.map(q=>[q.id,q.type==='rating'?q.max:q.type==='multiple'?[q.options[0].id]:q.options?q.options[0].id:'独立课堂意见']));
  await page.locator('#feedback-file').setInputFiles({name:'preview.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({records:[{id:'preview-a',answers}]}))});
  await expect(page.locator('#commit-import')).toBeEnabled();await page.locator('#records-panel > summary').click();await page.locator('#record-search').fill('只在甲班搜索');
  await page.locator('#new-title').fill('预览隔离乙');await page.locator('#new-class button').click();await expect(page.locator('#class-title')).toHaveText('预览隔离乙');await expect(page.locator('#commit-import')).toBeDisabled();await expect(page.locator('#import-preview')).toHaveText('');await expect(page.locator('#record-search')).toHaveValue('');await expect(page.locator('#evidence')).not.toBeVisible();await expect(page.locator('#statistics')).toContainText('0 份反馈');
});
test('后台新增候选时保留旧报告编辑，并查看所编辑报告的历史依据',async({page,request})=>{
  const classId=await reportClass(page,request,'依据选择保护课堂'),firstId=await page.locator('#report-text').getAttribute('data-report');
  await page.locator('#report-text').fill('正在修订第一份报告');await page.locator('#analyze-feedback').click();
  await expect.poll(async()=>{const c=await(await request.get('/api/feedback/sessions/'+classId)).json();return c.reports.length;}).toBe(2);
  await expect(page.locator('#report-select option')).toHaveCount(3);
  await expect(page.locator('#report-status')).toContainText('未保存');await expect(page.locator('#report-text')).toHaveValue('正在修订第一份报告');
  const evidence=page.waitForRequest(r=>r.url().includes('/evidence?reportId='));await page.locator('#show-evidence').click();expect(new URL((await evidence).url()).searchParams.get('reportId')).toBe(firstId);
  await expect(page.locator('#evidence')).toBeVisible();await expect(page.locator('#report-select')).toHaveValue(firstId);
});
