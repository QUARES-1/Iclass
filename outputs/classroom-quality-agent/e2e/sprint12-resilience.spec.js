import {test,expect} from '@playwright/test';

test('复盘回复迟到时保留已保存课程和等待期间新输入的下一条问题',async({page,request})=>{
  const old=await(await request.get('/api/classroom')).json();expect((await request.post('/api/classroom',{data:{revision:old.revision,action:'clear'}})).ok()).toBe(true);
  await page.goto('/public/sprint2.html');await page.locator('#classroom-discussion > summary').click();
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  await page.route('**/api/classroom/chat',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});});
  try{
    await page.locator('#classroom-request').fill('你好');await page.locator('#classroom-send').click();await ready;
    await page.locator('#classroom-request').fill('等待期间新写的问题');await page.locator('#course-options > summary').click();await page.locator('#course-title').fill('迟到回复不能覆盖的课程标题');await page.locator('#save-course').click();
    await expect(page.locator('#save-status')).toContainText('已保存');release();await expect(page.locator('#classroom-send')).toBeEnabled();
    await expect(page.locator('#course-title')).toHaveValue('迟到回复不能覆盖的课程标题');await expect(page.locator('#classroom-request')).toHaveValue('等待期间新写的问题');await expect(page.locator('#classroom-messages')).toContainText('你好！');
  }finally{release();await page.unrouteAll({behavior:'wait'});}
});
test('复盘区未发送的问题离开前受到保护，清空输入后不再提示',async({page})=>{
  await page.goto('/public/sprint2.html');await page.locator('#classroom-discussion > summary').click();await page.locator('#classroom-request').fill('尚未发送的问题');
  const prevented=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
  expect(await prevented()).toBe(true);await page.locator('#classroom-request').fill('');expect(await prevented()).toBe(false);
});
test('外部课程修改发生冲突时不自动重试覆盖，页面保留教师草稿',async({page,request})=>{
  await page.goto('/public/sprint2.html');await page.locator('#course-options > summary').click();await page.locator('#course-title').fill('本页仍待保存的草稿');
  const current=await(await request.get('/api/classroom')).json();expect((await request.post('/api/classroom',{data:{revision:current.revision,action:'course',course:{...current.course,title:'另一页面已保存的标题'}}})).ok()).toBe(true);
  await page.locator('#save-course').click();await expect(page.locator('#save-status')).toContainText('保存失败');await expect(page.locator('#course-title')).toHaveValue('本页仍待保存的草稿');
  expect((await(await request.get('/api/classroom')).json()).course.title).toBe('另一页面已保存的标题');
});
test('备课连续一千次已完成对话只保留必要的任务面板缓存',async({page})=>{
  await page.goto('/public/index.html');await expect(page.locator('#save-status')).not.toHaveText('正在读取…');
  const size=await page.evaluate(async()=>{
    const agent=await import('/public/agent-ui.js');agent.resetAgent();const original=Map.prototype.set,refs=new Set();
    Map.prototype.set=function(key,value){if(typeof key==='string'&&key.startsWith('cache-check-'))refs.add(this);return original.call(this,key,value);};
    try{
      for(let i=0;i<1000;i++)agent.renderAgent({id:'cache-check-'+i,createdAt:new Date(i*1000).toISOString(),stage:'completed',mode:i===0?'task':'conversation',completedBatches:0,totalBatches:0,observations:[],draftResources:[]});
      return Math.max(...[...refs].map(map=>map.size));
    }finally{Map.prototype.set=original;agent.resetAgent();}
  });expect(size).toBeLessThanOrEqual(2);
});
test('清空备课任务监视时立即中止未返回的进度读取，不等网络超时',async({page})=>{
  await page.goto('/public/index.html');let entered,release,aborted=0;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),jobId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  page.on('requestfailed',r=>{if(r.url().endsWith('/api/workspace/agent/'+jobId))aborted++;});
  await page.route('**/api/workspace/agent/'+jobId,async route=>{entered();await gate;await route.fulfill({json:{stage:'completed'}}).catch(()=>{});});
  try{
    await page.evaluate(async id=>{const agent=await import('/public/agent-ui.js');agent.resetAgent();agent.agentCallbacks({onEnd:async()=>{},onState:()=>{},onProgress:()=>{}});agent.watchAgent({id,createdAt:new Date().toISOString(),stage:'queued',mode:'conversation',completedBatches:0,totalBatches:0,observations:[],draftResources:[]});},jobId);await ready;
    await page.evaluate(async()=>{(await import('/public/agent-ui.js')).resetAgent();});await expect.poll(()=>aborted).toBe(1);await expect(page.locator('#agent-progress')).toBeHidden();
  }finally{release();await page.unrouteAll({behavior:'wait'});}
});
