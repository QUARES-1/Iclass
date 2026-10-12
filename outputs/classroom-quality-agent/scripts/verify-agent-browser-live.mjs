// Read-only interaction checks against the teacher's actual workspace.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root=new URL('..',import.meta.url),base='http://127.0.0.1:3000';
const hash=async name=>createHash('sha256').update(await fs.readFile(new URL('data/'+name,root))).digest('hex');
const before={workspace:await hash('workspace.json'),classroom:await hash('classroom.json')};
const {jobId}=JSON.parse(await fs.readFile(new URL('artifacts/agent/live-run.json',root)));
const browser=await chromium.launch({channel:'chrome',headless:true});const checks=[],errors=[];
try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/');
    await page.getByRole('link',{name:'模型与提示词设置',exact:true}).click();
    await expect(page).toHaveURL(/settings.html/);await expect(page.locator('#model')).toBeVisible();
    await page.goto(base+'/public/index.html');if(viewport.width<700)await page.locator('[data-tab=chat]').click();await expect(page.locator('#agent-progress')).toBeVisible();
    await page.locator('#agent-review').click();await expect(page.locator('#agent-issues')).toBeVisible();
    await page.screenshot({path:new URL('artifacts/agent/live-workbench-'+viewport.width+'.png',root).pathname});
    await page.goto(base+'/public/agent-draft.html?id='+jobId);
    await expect(page.locator('.draft-page')).toHaveCount(308);
    await page.locator('.draft-page details').first().click();
    await expect(page.locator('.draft-page pre').first()).toBeVisible();
    await page.locator('#refresh-draft').click();await expect(page.locator('#refresh-draft')).toBeEnabled();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(overflow,false);await page.screenshot({path:new URL('artifacts/agent/live-draft-'+viewport.width+'.png',root).pathname});
    checks.push({viewport,settingsLink:true,progress:true,reviewVisible:true,draftPages:308,notes:true,refresh:true,overflow});await page.close();
  }
  assert.deepEqual(errors,[]);assert.equal(await hash('workspace.json'),before.workspace);assert.equal(await hash('classroom.json'),before.classroom);
  const report={recordedAt:new Date().toISOString(),checks,browserErrors:errors,teacherWorkspaceUnchanged:true,classroomUnchanged:true};
  await fs.writeFile(new URL('artifacts/agent/live-browser-result.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
