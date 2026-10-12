// Read-only verification of the saved real demonstration after a service restart.
// No model calls, data replacement, corrections, or automatic confirmations.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { originalTranscript } from '../public/ui.js';
import { partitionTranscript } from '../src/analysis.js';
import { textObservations } from '../src/classroom.js';

const base=process.env.LIVE_URL || 'http://127.0.0.1:3000', dir='artifacts/audit';
const before=JSON.parse(await fs.readFile(`${dir}/restart-before.json`,'utf8'));
const get=async name=>{const response=await fetch(`${base}/api/${name}`);assert.ok(response.ok);return response.json();};
const [workspace,classroom]=await Promise.all([get('workspace'),get('classroom')]);
assert.equal(workspace.resources.length,before.workspace.resources);
const transcript=classroom.transcriptVersions.find(t=>t.id===classroom.currentTranscriptId), report=classroom.reports.find(r=>r.id===classroom.currentReportId);
assert.equal(transcript.segments.length,before.classroom.segments);
assert.equal(report.source,'llm');assert.equal(report.stale,false);assert.equal(report.transcriptId,transcript.id);
const original=originalTranscript(classroom,transcript);assert.ok(original && original.id!==transcript.id);
const chunks=partitionTranscript(transcript.segments,8500,115000-JSON.stringify({course:classroom.course}).length-2000);
assert.deepEqual(chunks.flat().map(s=>s.id),transcript.segments.map(s=>s.id));
const requests=chunks.map((segments,i)=>({course:classroom.course,part:i+1,totalParts:chunks.length,segments,textObservations:textObservations(segments)}));
const requestChars=requests.map(input=>JSON.stringify(input).length);assert.ok(requestChars.every(n=>n<=115000));

const browser=await chromium.launch({channel:'chrome',headless:true}), page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(`${base}/public/index.html`);await expect(page.locator('#resources .resource')).toHaveCount(workspace.resources.length);
  const parsed=workspace.materials.filter(m=>m.status==='parsed');
  if(parsed.length){await page.locator('#materials summary').first().click();await expect(page.locator('#materials pre').first()).toHaveText(parsed[0].content);}
  await page.goto(`${base}/public/sprint2.html`);await expect(page.locator('[data-segment]')).toHaveCount(transcript.segments.length);
  await expect(page.locator('#original-transcript')).toContainText(original.segments[0].text);
  await expect(page.locator('#report > section')).toHaveCount(6);
  await expect(page.locator('.report-item')).toHaveCount(Object.values(report.sections).flat().length);
  const samples=[0,Math.floor(transcript.segments.length/2),transcript.segments.length-1];
  for(const index of samples){
    const segment=transcript.segments[index];await expect(page.locator(`[data-segment="${segment.id}"]`)).toHaveValue(segment.text);
    await page.locator(`[data-play="${segment.id}"]`).click();await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);
    const at=await page.locator('#audio-player').evaluate(el=>{el.pause();return el.currentTime;});assert.ok(Math.abs(at-segment.start)<2);
  }
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-report').click()]);
  await download.saveAs(`${dir}/current-report.md`);const markdown=await fs.readFile(`${dir}/current-report.md`,'utf8');
  assert.ok(markdown.includes(transcript.id));assert.ok(markdown.includes(report.sections.summary[0].text));assert.ok(markdown.includes('教师修订'));
  await page.reload();await expect(page.locator('#report-meta')).toContainText('对应当前输入');
  await page.screenshot({path:`${dir}/classroom-retested.png`});assert.deepEqual(errors,[]);
  assert.deepEqual(await get('workspace'),workspace);assert.deepEqual(await get('classroom'),classroom);
  const hashes={};for(const name of ['workspace','classroom']){hashes[name]=createHash('sha256').update(await fs.readFile(`data/${name}.json`)).digest('hex');assert.equal(hashes[name],before[name].sha256);}
  const result={recordedAt:new Date().toISOString(),resources:workspace.resources.length,transcriptSegments:transcript.segments.length,reportItems:Object.values(report.sections).flat().length,originalMatchesCurrentAncestry:true,analysisRequestChars:requestChars,fullCoverage:true,audioSeekSamples:samples.map(i=>transcript.segments[i].start),markdownMatchesSavedReport:true,refreshRestored:true,restartHashesUnchanged:hashes,browserErrors:errors,verification:'Actual saved public lecture and real model report; this run made no model calls and performed no human listening review.'};
  await fs.writeFile(`${dir}/saved-demo-results.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
