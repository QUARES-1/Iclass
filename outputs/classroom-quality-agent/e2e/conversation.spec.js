import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
test.beforeEach(async({request})=>{const s=await(await request.get('/api/workspace')).json();await request.post('/api/workspace',{data:{revision:s.revision,action:'clear'}});});
async function say(page,text){await expect(page.locator('#send')).toBeEnabled();await page.locator('#request').fill(text);await page.locator('#send').click();await expect(page.locator('#messages .assistant').last()).toBeVisible();await expect(page.locator('#send')).toBeEnabled();}

test('问候、概念解释和澄清只展示回复，刷新保留对话，小屏简洁且不溢出',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/public/index.html');
  await say(page,'你好');await expect(page.locator('#messages')).toContainText('你好！有什么想一起讨论的？');await expect(page.locator('#agent-progress')).toBeHidden();await expect(page.locator('#notice')).toBeHidden();
  await say(page,'平衡树是什么？');await expect(page.locator('#messages')).toContainText('平衡树通过维护');
  await say(page,'帮我改一下');await expect(page.locator('#messages')).toContainText('要修改哪份资源的哪一部分？');await expect(page.locator('#agent-progress')).toBeHidden();
  const state=await(await request.get('/api/workspace')).json();expect(state.resources).toHaveLength(0);expect(state.messages).toHaveLength(6);
  for(const m of state.messages.filter(m=>m.role==='user')){const job=await(await request.get('/api/workspace/agent/'+m.jobId)).json();expect(job.mode).toBe('conversation');expect(job.calls).toBe(1);expect(job.plan).toBeNull();expect(job.totalBatches).toBe(0);}
  await page.reload();await expect(page.locator('#messages .message')).toHaveCount(6);await expect(page.locator('#agent-progress')).toBeHidden();
  await page.setViewportSize({width:390,height:844});await page.locator('[data-tab=chat]').click();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await fs.mkdir('artifacts/conversation',{recursive:true});await page.screenshot({path:'artifacts/conversation/chat-mobile.png',fullPage:true});expect(errors).toEqual([]);
});

test('查看指定页再解释不产生版本，直接修改只改目标页，执行详情默认折叠',async({page,request})=>{
  const current=await(await request.get('/api/workspace')).json();let sample=await(await request.post('/api/workspace/sample',{data:{revision:current.revision}})).json();const r=sample.resources.find(r=>r.type==='ppt');
  sample=await(await request.post('/api/workspace',{data:{revision:sample.revision,action:'select',resourceId:r.id}})).json();await page.goto('/public/index.html');
  await say(page,'解释第二页内容');await expect(page.locator('#messages')).toContainText('第二页内容：');await expect(page.locator('#agent-progress')).toBeHidden();
  let state=await(await request.get('/api/workspace')).json();expect(state.resources).toEqual(sample.resources);
  await say(page,'第2页标题改为关键操作');await expect(page.locator('#agent-stage')).toHaveText('执行完成');await expect(page.locator('#notice')).toContainText('成果已保存');
  expect(await page.locator('#agent-progress details[open]').count()).toBe(0);await page.getByText('查看执行计划',{exact:true}).click();await expect(page.locator('#agent-plan')).toContainText('直接执行');
  state=await(await request.get('/api/workspace')).json();const edited=state.resources.find(x=>x.id===r.id),v=edited.versions.find(v=>v.id===edited.currentVersionId),old=r.versions.find(v=>v.id===r.currentVersionId);expect(edited.versions).toHaveLength(r.versions.length+1);expect(v.content.slides[1].title).toBe('关键操作');expect(v.content.slides[0]).toEqual(old.content.slides[0]);
  const job=await(await request.get('/api/workspace/agent/'+state.messages.filter(m=>m.role==='user').at(-1).jobId)).json();expect(job.execution).toBe('direct');expect(job.plan).toBeNull();expect(job.calls).toBe(3);
  await say(page,'你好');await expect(page.locator('#agent-progress')).toBeHidden();await page.reload();await expect(page.locator('#agent-progress')).toBeHidden();await expect(page.locator('#messages')).toContainText('你好！');
});

test('后台生成期间可以聊天和查看进度，刷新同时恢复任务进度与聊天历史',async({page,request})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/public/index.html');
  await page.locator('#request').fill('新建长课件慢速并行聊天验证');await page.locator('#send').click();await expect(page.locator('#agent-stage')).toHaveText('分批生成');await expect(page.locator('#send')).toBeEnabled();
  await say(page,'你好');await expect(page.locator('#messages')).toContainText('你好！');await expect(page.locator('#agent-pause')).toBeVisible();
  await page.reload();await expect(page.locator('#agent-pause')).toBeVisible();await expect(page.locator('#send')).toBeEnabled();
  const assistantCount=await page.locator('#messages .assistant').count();await page.locator('#request').fill('现在生成到哪里了？');await page.locator('#send').click();await expect(page.locator('#messages .assistant')).toHaveCount(assistantCount+1);await expect(page.locator('#messages')).toContainText('正在生成课件，已完成');
  await expect(page.locator('.slide-card')).toHaveCount(7,{timeout:15000});const state=await(await request.get('/api/workspace')).json();expect(state.resources).toHaveLength(1);expect(state.resources[0].versions).toHaveLength(1);expect(state.messages).toHaveLength(6);expect(errors).toEqual([]);
});

test('指定页关联、多页标题修改和300分钟课程的批量改标题均成功',async({page,request})=>{
  let state=await(await request.get('/api/workspace')).json();state=await(await request.post('/api/workspace/sample',{data:{revision:state.revision}})).json();let ppt=state.resources.find(r=>r.type==='ppt');
  state=await(await request.post('/api/workspace',{data:{revision:state.revision,action:'select',resourceId:ppt.id}})).json();
  await page.goto('/public/index.html');
  const send=async text=>{const count=await page.locator('#messages .assistant').count();await page.locator('#request').fill(text);await page.locator('#send').click();await expect(page.locator('#messages .assistant')).toHaveCount(count+1);await expect(page.locator('#agent-stage')).toHaveText('执行完成');};
  await send('把小游戏放到当前PPT第2页');state=await(await request.get('/api/workspace')).json();ppt=state.resources.find(r=>r.id===ppt.id);let version=ppt.versions.find(v=>v.id===ppt.currentVersionId);expect(version.content.slides[1].attachment).toBeTruthy();expect(version.content.slides[0].attachment).toBeUndefined();
  await send('把第2页和第3页标题分别改为第二章、第三章');state=await(await request.get('/api/workspace')).json();ppt=state.resources.find(r=>r.id===ppt.id);version=ppt.versions.find(v=>v.id===ppt.currentVersionId);expect(version.content.slides.slice(1).map(s=>s.title)).toEqual(['第二章','第三章']);
  for(let i=0;i<3;i++){state=await(await request.post('/api/workspace',{data:{revision:state.revision,action:'addSlide',resourceId:ppt.id,baseVersionId:ppt.currentVersionId}})).json();ppt=state.resources.find(r=>r.id===ppt.id);}
  state=await(await request.post('/api/workspace',{data:{revision:state.revision,action:'settings',requirements:{...state.requirements,duration:300}}})).json();
  await page.reload();await send('把当前课件所有页的标题改得简洁');state=await(await request.get('/api/workspace')).json();ppt=state.resources.find(r=>r.id===ppt.id);version=ppt.versions.find(v=>v.id===ppt.currentVersionId);expect(version.content.slides).toHaveLength(6);expect(version.content.slides.every(s=>s.title==='简洁标题')).toBe(true);expect(version.content.slides[1].attachment).toBeTruthy();
  await page.reload();await expect(page.locator('.slide-card')).toHaveCount(6);await expect(page.locator('#notice')).not.toContainText('重新安排完整课时');
});
