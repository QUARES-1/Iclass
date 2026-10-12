// Current live workspace: repeat the fixed sample action without changing data.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const base=process.env.LIVE_URL||'http://127.0.0.1:3000';
const before=await(await fetch(base+'/api/workspace')).json(),saved=await fs.readFile('data/workspace.json'),errors=[];
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1000}});
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(base+'/public/index.html');await expect(page.locator('#materials .material')).toHaveCount(before.materials.length);await expect(page.locator('#resources .resource')).toHaveCount(before.resources.length);
  const selected=before.resources.find(r=>r.id===before.selectedId),version=selected?.versions.find(v=>v.id===selected.currentVersionId);let stepText;
  if(version?.content.mode==='steps'){await expect(page.locator('#preview-status')).toContainText('已初始化');const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'下一步',exact:true}).click();stepText=await frame.locator('#activity').textContent();}
  for(let i=0;i<3;i++){await page.locator('#sample').click();await expect(page.locator('#notice')).toContainText('没有重复添加');await expect(page.locator('#sample')).toBeEnabled();}
  if(stepText)await expect(page.frameLocator('iframe').locator('#activity')).toHaveText(stepText);
  await expect(page.locator('#resources .resource')).toHaveCount(before.resources.length);assert.deepEqual(await(await fetch(base+'/api/workspace')).json(),before);assert.deepEqual(await fs.readFile('data/workspace.json'),saved);assert.deepEqual(errors,[]);
  await page.screenshot({path:'artifacts/sample-dedup/live-browser.png',fullPage:true});
  const result={clicks:3,resources:before.resources.length,materials:before.materials.length,repeatDoesNotWrite:true,selectedResourcePreserved:true,stepProgressPreserved:!!stepText,browserErrors:errors};await fs.writeFile('artifacts/sample-dedup/live-browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
