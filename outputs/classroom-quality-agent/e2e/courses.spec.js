import {test,expect} from '@playwright/test';

async function create(request,title='课程组织测试'){
 const id=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
 expect((await request.post('/api/courses',{data:{id,title}})).ok()).toBe(true);
 for(const [lessonId,name]of [[a,'第1讲 · 平衡树'],[b,'第2讲 · 图的遍历']])expect((await request.post('/api/courses/'+id+'/lessons',{data:{id:lessonId,title:name,date:'2026-10-21'}})).ok()).toBe(true);
 return {id,a,b};
}
async function addResource(request,courseId){
 const response=await request.post('/api/courses/'+courseId+'/resources?kind=file&name=teacher.md',{data:Buffer.from('教师自己的教学讲义：先讲清split和merge，再展示完整函数与调用。'),headers:{'Content-Type':'application/octet-stream'}});expect(response.ok()).toBe(true);return (await response.json()).resources.find(r=>r.courseId===courseId);
}
async function select(request,lessonId,resourceIds){const lesson=await(await request.get('/api/lessons/'+lessonId)).json();expect((await request.post('/api/lessons/'+lessonId,{data:{revision:lesson.revision,action:'resources',resourceIds,generatedIds:[]}})).ok()).toBe(true);}

test('课次资源操作统一呈现，键盘焦点清晰，手机长名称不挤压或横向溢出',async({page,request})=>{
 const {id,a}=await create(request);await addResource(request,id);
 let w=await(await request.get('/api/workspace?lesson='+a)).json();expect((await request.post('/api/workspace/sample?lesson='+a,{data:{revision:w.revision}})).ok()).toBe(true);
 w=await(await request.get('/api/workspace?lesson='+a)).json();expect((await request.post('/api/workspace?lesson='+a,{data:{revision:w.revision,action:'rename',resourceId:w.resources[0].id,baseVersionId:w.resources[0].currentVersionId,name:'完整函数示例'.repeat(30)}})).ok()).toBe(true);
 await page.goto('/public/lesson.html?lesson='+a);const edit=page.getByRole('link',{name:'在备课中查看与编辑'}).first();await expect(edit).toBeVisible();await expect(edit).toHaveClass('course-action');
 const style=await edit.evaluate(el=>{const s=getComputedStyle(el);return {display:s.display,color:s.color,border:s.borderTopWidth,decoration:s.textDecorationLine};});expect(style).toMatchObject({border:'1px',decoration:'none'});expect(style.color).toBe('rgb(56, 93, 120)');
 await page.keyboard.press('Tab');await edit.focus();expect(await edit.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');
 await page.screenshot({path:'artifacts/lesson-actions-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(edit).toBeVisible();expect(await edit.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/lesson-actions-mobile.png',fullPage:true});
 await page.getByRole('link',{name:'在备课中查看与编辑'}).last().click();await expect(page).toHaveURL(new RegExp('index.html\\?lesson='+a));await expect(page.locator('#resources .resource')).toHaveCount(5);await expect(page.locator('#resources .resource.selected')).toContainText('归并排序');
});

test('批量上传中途失败明确保留已完成文件，停止上传后可继续重试且不重复',async({page,request})=>{
 const {id}=await create(request);await page.goto('/public/course.html?course='+id);
 const good={name:'valid.md',mimeType:'text/markdown',buffer:Buffer.from('已完成的教师讲义')};
 await page.locator('#course-files').setInputFiles([good,{name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)}]);
 await expect(page.locator('#notice')).toContainText('empty.txt');await expect(page.locator('#resource-upload-status')).toContainText('未完成');await expect(page.locator('.library-resource')).toHaveCount(1);await expect(page.locator('#cancel-resource-upload')).toBeHidden();
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 await page.route('**/resources?kind=file&name=cancel.md',async route=>{entered();await gate;await route.abort().catch(()=>{});});
 await page.locator('#course-files').setInputFiles({name:'cancel.md',mimeType:'text/markdown',buffer:Buffer.from('取消的文件')});await started;await page.locator('#cancel-resource-upload').click();await expect(page.locator('#resource-upload-status')).toContainText('已停止');release();
 await page.locator('#course-files').setInputFiles(good);await expect(page.locator('#resource-upload-status')).toContainText('本批资料已保存');await expect(page.locator('.library-resource')).toHaveCount(1);
});

test('归档后仍能只读定位指定资源，失效资源链接给出提示且不覆盖现有资料',async({page,request})=>{
 const {id,a}=await create(request);let w=await(await request.get('/api/workspace?lesson='+a)).json();expect((await request.post('/api/workspace/sample?lesson='+a,{data:{revision:w.revision}})).ok()).toBe(true);
 w=await(await request.get('/api/workspace?lesson='+a)).json();const target=w.resources.at(-1),catalog=await(await request.get('/api/courses/'+id)).json();
 expect((await request.post('/api/courses/'+id,{data:{revision:catalog.revision,action:'archive'}})).ok()).toBe(true);
 await page.goto('/public/index.html?lesson='+a+'&resource='+target.id);await expect(page.locator('#resources .resource.selected')).toContainText(target.name);
 const after=await(await request.get('/api/workspace?lesson='+a)).json();expect(after.revision).toBe(w.revision);expect(after.resources).toEqual(w.resources);
 await page.goto('/public/index.html?lesson='+a+'&resource='+crypto.randomUUID());await expect(page.locator('#notice')).toContainText('这份资源已不存在');expect((await(await request.get('/api/workspace?lesson='+a)).json()).revision).toBe(w.revision);
});

test('从课程开始建立课次，选用教师资料后进入备课和反馈，无需先生成课件',async({page,request})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'我的课程'})).toBeVisible();
 const name='从课程开始-'+crypto.randomUUID().slice(0,6);await page.locator('#new-course-title').fill(name);await page.locator('#new-course button').click();
 const course=page.locator('.course-card').filter({hasText:name});await expect(course).toHaveCount(1);await course.click();
 await page.locator('#new-lesson-title').fill('第一课 · 教师自备讲义');await page.locator('#new-lesson button').click();
 await expect(page.locator('.lesson-card')).toHaveCount(1);
 await page.locator('#course-files').setInputFiles({name:'teacher.md',mimeType:'text/markdown',buffer:Buffer.from('教师讲义：从完整函数讲解树的分裂和合并。')});
 await expect(page.locator('#resource-upload-status')).toContainText('本批资料已保存');await expect(page.locator('.library-resource')).toHaveCount(1);
 await page.locator('.lesson-card').click();await expect(page.locator('#lesson-name')).toHaveText('第一课 · 教师自备讲义');
 await page.locator('[data-use-resource]').check();await page.locator('#save-lesson-resources').click();await expect(page.locator('#lesson-resource-status')).toContainText('已保存');
 await page.locator('[data-prepare-resource]').click();await expect(page.locator('#notice')).toContainText('重复加入不会复制');
 await page.locator('.lesson-stages a').filter({hasText:'备课'}).click();await expect(page).toHaveURL(/index.html\?lesson=/);
 await expect(page.locator('#materials')).toContainText('teacher.md');await expect(page.locator('#topic')).toHaveValue('第一课 · 教师自备讲义');await expect(page.locator('.resource')).toHaveCount(0);
 await page.locator('.lesson-navigation').getByRole('link',{name:'课后反馈',exact:true}).click();await expect(page).toHaveURL(/sprint3.html\?lesson=/);
 await expect(page.locator('#class-title')).toHaveText('第一课 · 教师自备讲义');await expect(page.locator('#new-class')).toBeHidden();await expect(page.locator('#class-work')).toBeVisible();expect(errors).toEqual([]);
});

test('两个课次的编辑、未发送草稿和反馈互相隔离，刷新后各自恢复',async({page,context,request})=>{
 const {a,b}=await create(request);await page.goto('/public/index.html?lesson='+a);await expect(page.locator('#topic')).toHaveValue('第1讲 · 平衡树');
 await page.locator('#request').fill('这是甲课次尚未发送的教学要求');
 const other=await context.newPage();await other.goto('/public/index.html?lesson='+b);await expect(other.locator('#topic')).toHaveValue('第2讲 · 图的遍历');await expect(other.locator('#request')).toHaveValue('');
 await other.locator('#topic').fill('乙课次独立主题');await other.locator('#save-settings').click();await expect(other.locator('#save-status')).toContainText('已保存');
 await expect(page.locator('#topic')).toHaveValue('第1讲 · 平衡树');await expect(page.locator('#request')).toHaveValue('这是甲课次尚未发送的教学要求');
 await other.goto('/public/sprint3.html?lesson='+b);await expect(other.locator('#class-title')).toHaveText('第2讲 · 图的遍历');
 const bootA=await(await request.get('/api/feedback/bootstrap?lesson='+a)).json(),bootB=await(await request.get('/api/feedback/bootstrap?lesson='+b)).json();expect(bootA.sessions.map(x=>x.id)).toEqual([a]);expect(bootB.sessions.map(x=>x.id)).toEqual([b]);
 page.once('dialog',d=>d.accept());await page.reload();await expect(page.locator('#request')).toHaveValue('这是甲课次尚未发送的教学要求');
});

test('重复上传不追加，说明保存等待中的新输入保留，原文件可下载',async({page,request})=>{
 const {id}=await create(request);await page.goto('/public/course.html?course='+id);const file={name:'teacher.md',mimeType:'text/markdown',buffer:Buffer.from('教师完整讲义')};
 for(let i=0;i<3;i++){await page.locator('#course-files').setInputFiles(file);await expect(page.locator('#resource-upload-status')).toContainText('本批资料已保存');await expect(page.locator('.library-resource')).toHaveCount(1);}
 const card=page.locator('.library-resource');await card.locator('summary').click();await card.locator('textarea').fill('第一版说明');
 let release;const gate=new Promise(r=>release=r);
 await page.route(/\/api\/courses\/[^/]+\/resources\/[a-f0-9]+$/,async route=>{if(route.request().method()!=='POST')return route.fallback();const response=await route.fetch();await gate;await route.fulfill({response});});
 await card.locator('[data-save-resource]').click();await card.locator('textarea').fill('等待期间继续编辑的新说明');release();
 await expect(page.locator('#notice')).toContainText('资源说明已保存');await expect(page.locator('.library-resource textarea')).toHaveValue('等待期间继续编辑的新说明');
 if(!await page.locator('.library-resource').evaluate(el=>el.open))await page.locator('.library-resource summary').click();
 const downloaded=page.waitForEvent('download');await page.getByRole('link',{name:'下载原文件'}).click();expect((await downloaded).suggestedFilename()).toBe('teacher.md');
});

test('资源选择保存等待中改变选项，保留新选择并提示再次保存',async({page,request})=>{
 const {id,a}=await create(request);await addResource(request,id);await page.goto('/public/lesson.html?lesson='+a);await expect(page.locator('[data-use-resource]')).toHaveCount(1);
 await page.locator('[data-use-resource]').check();let release;const gate=new Promise(r=>release=r);
 await page.route('**/api/lessons/'+a,async route=>{if(route.request().method()!=='POST')return route.fallback();const response=await route.fetch();await gate;await route.fulfill({response});});
 await page.locator('#save-lesson-resources').click();await page.locator('[data-use-resource]').uncheck();release();
 await expect(page.locator('#lesson-resource-status')).toContainText('有新选择');await expect(page.locator('[data-use-resource]')).not.toBeChecked();
});

test('课次导航保留归属，录音与报告请求也包含当前课次',async({page,request})=>{
 const {a,b}=await create(request);await page.goto('/public/lesson.html?lesson='+a);await expect(page.locator('.lesson-navigation')).toContainText('第1讲');
 await page.locator('.lesson-navigation').getByRole('link',{name:'课堂录音',exact:true}).click();await expect(page).toHaveURL(new RegExp('sprint2.html\\?lesson='+a));
 await expect(page.locator('#course-title')).toHaveValue('第1讲 · 平衡树');
 const audio=await(await request.get('/api/classroom?lesson='+b)).json();expect(audio.course.title).toBe('第2讲 · 图的遍历');
 for(const aLink of await page.locator('.lesson-navigation a[href*=".html?lesson="]').all())await expect(aLink).toHaveAttribute('href',new RegExp('lesson='+a));
 await expect(page.locator('header nav a[href*="settings"]')).toHaveAttribute('href',new RegExp('lesson='+a));
});

test('归档保留所有资料，恢复后可以继续选择；手机课程页和课次页无横向溢出',async({page,request})=>{
 const {id,a}=await create(request);await addResource(request,id);await select(request,a,[(await(await request.get('/api/courses/'+id)).json()).resources[0].id]);
 await page.setViewportSize({width:390,height:844});await page.goto('/public/course.html?course='+id);await expect(page.locator('#course-name')).toHaveText('课程组织测试');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'artifacts/course-mobile.png',fullPage:true});
 await page.locator('.lesson-card').first().click();await expect(page.locator('#lesson-name')).toContainText('第1讲');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 page.once('dialog',d=>d.accept());await page.locator('#archive-lesson').click();await expect(page.locator('#archive-lesson')).toHaveText('恢复课次');await expect(page.locator('[data-use-resource]')).toBeChecked();await expect(page.locator('#save-lesson-resources')).toBeDisabled();
 await page.locator('#archive-lesson').click();await expect(page.locator('#archive-lesson')).toHaveText('归档课次');await expect(page.locator('#save-lesson-resources')).toBeEnabled();await expect(page.locator('#lesson-resource-status')).not.toContainText('已归档');await page.screenshot({path:'artifacts/lesson-mobile.png',fullPage:true});
});

test('删除资源先解除课次引用，取消确认不会删除，下载和既有备课资料仍可保留',async({page,request})=>{
 const {id,a}=await create(request);const r=await addResource(request,id);await select(request,a,[r.id]);await page.goto('/public/course.html?course='+id);await page.locator('.library-resource summary').click();
 page.once('dialog',d=>d.accept());await page.locator('[data-remove-resource]').click();await expect(page.locator('#notice')).toContainText('仍有课次使用');await expect(page.locator('.library-resource')).toHaveCount(1);
 await select(request,a,[]);await page.locator('#reload-course').click();await expect(page.locator('.library-resource')).toHaveCount(1);if(!await page.locator('.library-resource').evaluate(el=>el.open))await page.locator('.library-resource summary').click();
 page.once('dialog',d=>d.dismiss());await page.locator('[data-remove-resource]').click();await expect(page.locator('.library-resource')).toHaveCount(1);
 page.once('dialog',d=>d.accept());await page.locator('[data-remove-resource]').click();await expect(page.locator('.library-resource')).toHaveCount(0);
});

test('下一课建议带入所选课次，重复刷新不自动发送或修改资源',async({page,request})=>{
 const {a,b}=await create(request);await request.get('/api/feedback/bootstrap?lesson='+a);let c=await(await request.get('/api/feedback/sessions/'+a+'?lesson='+a)).json();
 const id=crypto.randomUUID();expect((await request.post('/api/feedback/sessions/'+a+'?lesson='+a,{data:{revision:c.revision,action:'suggestions',baseSuggestionVersion:0,suggestions:[{id,text:'请在下一课补充空树情况下的完整函数调用示例。',evidenceIds:[]}]}})).ok()).toBe(true);
 await page.goto('/public/sprint3.html?lesson='+a);await expect(page.locator('[data-suggestion-select]')).toHaveCount(1);await page.locator('[data-suggestion-select]').check();await expect(page.locator('#handoff-lesson')).toBeVisible();await page.locator('#handoff-lesson').selectOption(b);
 await page.locator('#handoff-suggestions').click();await expect(page).toHaveURL(new RegExp('lesson='+b));await expect(page.locator('.feedback-handoff-card')).toHaveCount(1);await expect(page.locator('#topic')).toHaveValue('第2讲 · 图的遍历');await expect(page.locator('#request')).toHaveValue(/空树/);
 page.once('dialog',d=>d.accept());await page.reload();await expect(page.locator('.feedback-handoff-card')).toHaveCount(1);await expect(page.locator('#request')).toHaveValue(/空树/);
 const workspace=await(await request.get('/api/workspace?lesson='+b)).json();expect(workspace.messages).toHaveLength(0);expect(workspace.resources).toHaveLength(0);
});

test('空课次或不存在课次的书签不会显示或写入历史工作区',async({page,request})=>{
 const before=await(await request.get('/api/workspace')).json();
 for(const query of ['lesson=','lesson='+crypto.randomUUID()]){
  await page.goto('/public/index.html?'+query);await expect(page.locator('#notice')).toContainText(/课次|无法打开/);await expect(page.locator('#topic')).toHaveValue('');
  await expect(page.locator('#send')).toBeDisabled();await expect(page.locator('#request')).toBeDisabled();
 }
 const after=await(await request.get('/api/workspace')).json();expect(after.revision).toBe(before.revision);expect(after.messages).toEqual(before.messages);
});

test('上传刷新后仍保留课程信息的原版本，不能覆盖另一标签的修改',async({page,request})=>{
 const {id}=await create(request);await page.goto('/public/course.html?course='+id);await page.locator('details').filter({has:page.locator('#edit-course')}).locator('summary').click();await page.locator('#course-description-input').fill('教师甲尚未保存的课程说明');
 let c=await(await request.get('/api/courses/'+id)).json();expect((await request.post('/api/courses/'+id,{data:{revision:c.revision,metadataRevision:0,action:'update',title:'教师乙改过的课程名',description:'教师乙的说明'}})).ok()).toBe(true);
 await page.locator('#course-files').setInputFiles({name:'refresh.md',mimeType:'text/markdown',buffer:Buffer.from('通过上传刷新列表')});await expect(page.locator('#resource-upload-status')).toContainText('本批资料已保存');
 await page.locator('#edit-course button').click();await expect(page.locator('#notice')).toContainText('其他页面更新');await expect(page.locator('#course-description-input')).toHaveValue('教师甲尚未保存的课程说明');
 c=await(await request.get('/api/courses/'+id)).json();expect(c.course.title).toBe('教师乙改过的课程名');expect(c.course.description).toBe('教师乙的说明');
 page.once('dialog',d=>d.accept());await page.locator('#reload-course').click();await expect(page.locator('#course-title-input')).toHaveValue('教师乙改过的课程名');
});

test('课次信息刷新不能让陈旧的资源选择覆盖另一个标签页',async({page,request})=>{
 const {id,a}=await create(request),r=await addResource(request,id);await page.goto('/public/lesson.html?lesson='+a);await expect(page.locator('[data-use-resource]')).toHaveCount(1);await page.locator('[data-use-resource]').check();
 await select(request,a,[r.id]); // another tab has already saved the selection
 await page.locator('[data-use-resource]').uncheck();
 await page.locator('details').filter({has:page.locator('#edit-lesson')}).locator('summary').click();await page.locator('#lesson-description-input').fill('仅更新课次说明');await page.locator('#edit-lesson button').click();await expect(page.locator('#notice')).toContainText('课次信息已保存');
 await page.locator('#save-lesson-resources').click();await expect(page.locator('#notice')).toContainText('其他页面更新');await expect(page.locator('[data-use-resource]')).not.toBeChecked();
 const current=await(await request.get('/api/lessons/'+a)).json();expect(current.lesson.resourceIds).toEqual([r.id]);
 page.once('dialog',d=>d.accept());await page.locator('#reload-lesson').click();await expect(page.locator('[data-use-resource]')).toBeChecked();
});
