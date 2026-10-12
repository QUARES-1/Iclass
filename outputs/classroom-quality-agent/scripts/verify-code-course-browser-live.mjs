// Read-only interaction with the teacher's actual course and task draft.
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=new URL('..',import.meta.url),base='http://127.0.0.1:3000';
const hash=async name=>createHash('sha256').update(await fs.readFile(new URL('data/'+name,root))).digest('hex');
const before={workspace:await hash('workspace.json'),classroom:await hash('classroom.json')};
const run=JSON.parse(await fs.readFile(new URL('artifacts/code-course/run.json',root)));
const browser=await chromium.launch({channel:'chrome',headless:true}),checks=[],errors=[];
try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedCode=text;}}}));
    await page.goto(base+'/');await page.getByRole('link',{name:'模型与提示词设置',exact:true}).click();
    await expect(page).toHaveURL(/settings.html/);await expect(page.locator('#model')).toBeVisible();
    await page.goto(base+'/public/index.html');if(viewport.width<700)await page.locator('[data-tab=chat]').click();
    await expect(page.locator('#agent-progress')).toBeVisible();
    await page.screenshot({path:new URL('artifacts/code-course/workbench-'+viewport.width+'.png',root).pathname});
    await page.goto(base+'/public/agent-draft.html?id='+run.jobId);
    await expect(page.locator('#refresh-draft')).toBeEnabled();
    const snapshot=await page.evaluate(async id=>(await fetch('/api/workspace/agent/'+id+'/draft')).json(),run.jobId);
    const slides=snapshot.resources.flatMap(r=>r.type==='ppt'?r.content.slides:[]);
    await expect(page.locator('.draft-page')).toHaveCount(slides.length);
    const sourcePages=slides.filter(s=>s.code&&s.code.kind!=='output');
    const first=sourcePages.find(s=>/\)\s*(?:const\s*)?\{/.test(s.code.source))||sourcePages[0];assert.ok(first);
    const full=slides.filter(s=>s.code?.blockId===first.code.blockId&&s.code.kind!=='output').map(s=>s.code.source).join('');
    const button=page.locator('[data-copy-code="'+first.id+'"]');await button.click();
    await expect.poll(()=>page.evaluate(()=>window.copiedCode)).toBe(full);
    assert.equal(await button.locator('xpath=../..').locator('pre').first().evaluate(el=>getComputedStyle(el).whiteSpace),'pre');
    await button.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('artifacts/code-course/code-'+viewport.width+'.png',root).pathname});
    await page.locator('.draft-page details').first().click();await expect(page.locator('.draft-page details pre').first()).toBeVisible();
    await page.locator('#refresh-draft').click();await expect(page.locator('#refresh-draft')).toBeEnabled();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
    checks.push({viewport,settingsLink:true,progress:true,draftPages:slides.length,fullCodeCopy:true,preserveIndent:true,notes:true,refresh:true,overflow});await page.close();
  }
  assert.deepEqual(errors,[]);assert.equal(await hash('workspace.json'),before.workspace);assert.equal(await hash('classroom.json'),before.classroom);
  const report={recordedAt:new Date().toISOString(),checks,browserErrors:errors,teacherWorkspaceUnchanged:true,classroomUnchanged:true};
  await fs.writeFile(new URL('artifacts/code-course/browser-result.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
