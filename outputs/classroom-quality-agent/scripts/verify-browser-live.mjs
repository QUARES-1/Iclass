import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.LIVE_URL || 'http://127.0.0.1:3000';
const dir = 'artifacts/live';
await fs.mkdir(dir, { recursive:true });
const state = await (await fetch(base+'/api/workspace')).json();
const browser = await chromium.launch({ channel:'chrome', headless:true });
const page = await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[], checks=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(base+'/public/index.html');
  await expect(page.locator('.resource')).toHaveCount(state.resources.length);
  for (const r of state.resources.filter(r=>r.type!=='ppt')) {
    const c=r.versions.find(v=>v.id===r.currentVersionId).content;
    const button=page.locator(`[data-resource="${r.id}"]`);
    if(!(await button.getAttribute('class')).includes('selected')) {
      const response=page.waitForResponse(res=>res.url()===base+'/api/workspace' && res.request().method()==='POST');
      await button.click();await response;
      await expect(page.locator(`[data-resource="${r.id}"]`)).toHaveClass(/selected/);
    }
    const frame=page.frameLocator('iframe');
    await expect(frame.locator('h1')).toHaveText(c.title);
    await expect(page.locator('#preview-status')).toContainText('已初始化');
    if(c.mode==='quiz') {
      const q=c.questions[0];
      await frame.getByRole('button',{name:q.options[(q.answer+1)%q.options.length],exact:true}).click();
      await expect(frame.locator('#feedback')).toContainText('不正确');
      await frame.getByRole('button',{name:q.options[q.answer],exact:true}).click();
      await expect(frame.locator('#feedback')).toContainText('回答正确');
    } else if(c.mode==='order') {
      await page.locator('#fullscreen').click();
      await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);
      const items=frame.locator('.item');
      await expect(items).toHaveCount(c.items.length);
      const before=await items.locator('span').allTextContents();
      const at=before.findIndex((x,i)=>i<before.length-1 && Number(x)>Number(before[i+1]));
      assert.ok(at>=0);
      await items.nth(at).dragTo(items.nth(at+1));
      const expected=[...before];[expected[at],expected[at+1]]=[expected[at+1],expected[at]];
      await expect(items.locator('span')).toHaveText(expected);
      await frame.getByRole('button',{name:'检查答案'}).click();
      await page.evaluate(()=>document.exitFullscreen());
    } else if(c.mode==='match') {
      for(const pair of c.pairs){await frame.getByRole('button',{name:pair.left,exact:true}).click();await frame.getByRole('button',{name:pair.right,exact:true}).click();}
      await expect(frame.locator('#feedback')).toContainText('全部配对完成');
    } else if(c.mode==='steps') {
      await frame.getByRole('button',{name:'下一步'}).click();
      await expect(frame.locator('h2')).toContainText(c.items[1]);
    }
    await frame.locator('#hint').click();
    await frame.locator('#reset').click();
    await page.screenshot({path:`${dir}/${c.mode}-real.png`,fullPage:true});
    await page.locator('#confirm-activity').click();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-final').click()]);
    const file=`${dir}/${c.mode}-real.html`;await download.saveAs(file);
    const context=await browser.newContext({offline:true});const offline=await context.newPage();
    await offline.goto('file://'+process.cwd()+'/'+file);
    await expect(offline.locator('h1')).toHaveText(c.title);
    await offline.locator('#hint').click();await offline.locator('#reset').click();await context.close();
    checks.push({mode:c.mode,coreOperation:true,offlineExport:true});
  }
  const ppt=state.resources.find(r=>r.type==='ppt');
  await page.locator(`[data-resource="${ppt.id}"]`).click();
  await expect(page.locator('.slide-card').first()).toBeVisible();
  await page.locator('#btn-confirm-all').click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-final').click()]);
  await download.saveAs(`${dir}/real-ppt-companion.zip`);
  const bytes=await fs.readFile(`${dir}/real-ppt-companion.zip`);
  const contents=await page.evaluate(async bytes=>{
    const zip=await JSZip.loadAsync(new Uint8Array(bytes));
    const pptName=Object.keys(zip.files).find(k=>k.endsWith('.pptx'));
    const ppt=await JSZip.loadAsync(await zip.file(pptName).async('uint8array'));
    return {files:Object.keys(zip.files),slideCount:Object.keys(ppt.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).length,notes:await ppt.file('ppt/notesSlides/notesSlide3.xml').async('string')};
  },[...bytes]);
  assert.equal(contents.slideCount,ppt.versions.find(v=>v.id===ppt.currentVersionId).content.slides.length);
  assert.match(contents.notes,/教师人工备注/);
  assert.equal(contents.files.filter(k=>k.endsWith('.html')).length,1);
  await page.screenshot({path:`${dir}/workbench-real.png`,fullPage:true});
  await page.reload();await expect(page.locator('.resource')).toHaveCount(state.resources.length);
  assert.deepEqual(errors,[]);
  const result={checks,pptExport:contents,refreshRestored:true,browserErrors:errors,confirmation:'Automated acceptance exports, not teacher approval'};
  await fs.writeFile(`${dir}/browser-results.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,pptExport:{...contents,notes:undefined}}));
} finally {await browser.close();}
