// Uses the saved public lecture and real report; never clears or replaces data.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.LIVE_URL || 'http://127.0.0.1:3000';
const phase=process.argv[2] || 'report';
const dir='artifacts/live';
await fs.mkdir(dir,{recursive:true});
const state=await(await fetch(base+'/api/classroom')).json();
assert.equal(state.audio?.name,'pku-networking-lecture1-rm.m4a');
const transcript=state.transcriptVersions.find(t=>t.id===state.currentTranscriptId);
assert.ok(transcript && transcript.segments.length>100);
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(base+'/public/sprint2.html');
  await page.locator('#transcript-panel > summary').click();
  const currentReport=state.reports.find(r=>r.id===state.currentReportId);
  if(currentReport && currentReport.mode!=='overview')await page.locator('#legacy-analysis > summary').click();
  const openItem=async card=>card.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;for(const details of el.querySelectorAll('details'))details.open=true;});
  await expect(page.locator('[data-segment]')).toHaveCount(transcript.segments.length);
  await expect(page.locator('#audio-info')).toContainText('49:35');
  const dimensions=await page.locator('#transcript').evaluate(el=>({height:el.clientHeight,contentHeight:el.scrollHeight}));
  assert.ok(dimensions.height<=640 && dimensions.contentHeight>dimensions.height);
  const samples=[0,Math.floor(transcript.segments.length/2),transcript.segments.length-1];
  for(const index of samples){
    const segment=transcript.segments[index];
    await page.locator(`[data-play="${segment.id}"]`).click();
    await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);
    const at=await page.locator('#audio-player').evaluate(el=>{const at=el.currentTime;el.pause();return at;});
    assert.ok(Math.abs(at-segment.start)<2,`Audio seek mismatch at ${segment.start}: ${at}`);
  }
  if(phase==='correct'){
    assert.ok(transcript.original && transcript.source==='asr');
    const edits=JSON.parse(await fs.readFile(`${dir}/classroom-correction-plan.json`,'utf8'));
    assert.ok(edits.length && edits.length<20);
    for(const edit of edits){
      const segment=transcript.segments.find(s=>s.id===edit.id);
      assert.equal(segment?.text,edit.from);assert.ok(edit.to.trim() && edit.reason);
      await page.locator(`[data-segment="${edit.id}"]`).fill(edit.to);
    }
    await page.locator('#save-transcript').click();
    await expect(page.locator('#transcript-meta')).toContainText('教师校正版');
    const saved=await(await page.request.get(base+'/api/classroom')).json();
    const corrected=saved.transcriptVersions.find(t=>t.id===saved.currentTranscriptId);
    assert.equal(corrected.parentId,transcript.id);
    assert.deepEqual(saved.transcriptVersions.find(t=>t.id===transcript.id).segments,transcript.segments);
    await fs.writeFile(`${dir}/classroom-corrections.json`,JSON.stringify({originalId:transcript.id,correctedId:corrected.id,edits,performedBy:'Acceptance script; not teacher approval'},null,2));
    await page.reload();await expect(page.locator('#transcript-meta')).toContainText('教师校正版');
    for(const edit of edits)await expect(page.locator(`[data-segment="${edit.id}"]`)).toHaveValue(edit.to);
  } else if(phase==='review'){
    const plan=JSON.parse(await fs.readFile(`${dir}/classroom-report-review-plan.json`,'utf8'));
    assert.equal(plan.reportId,state.currentReportId);
    for(const edit of plan.edits){
      const card=page.locator(`[data-report-item="${edit.id}"]`);await openItem(card);
      await expect(card.locator('textarea')).toHaveValue(edit.from);
      await card.locator('textarea').fill(edit.to);await card.locator('[data-item-save]').click();
      await expect(card).toContainText('教师修订');await expect(card.locator('textarea')).toHaveValue(edit.to);
    }
    await page.reload();
    for(const edit of plan.edits)await expect(page.locator(`[data-report-item="${edit.id}"] textarea`)).toHaveValue(edit.to);
    await fs.writeFile(`${dir}/classroom-report-review.json`,JSON.stringify({...plan,refreshRestored:true,performedBy:'Codex acceptance review via teacher editing controls; not human teacher approval'},null,2));
  } else if(phase==='report'){
    const report=state.reports.find(r=>r.id===state.currentReportId);
    assert.ok(report && report.source==='llm' && !report.stale);
    assert.equal(report.transcriptId,transcript.id);
    const count=Object.values(report.sections).flat().length;
    await expect(page.locator('#report .report-item')).toHaveCount(count);
    await expect(page.locator('#report [data-report-section]')).toHaveCount(report.mode==='overview'?2+(report.detailSections||[]).length:6);
    await expect(page.locator('#report-meta')).toContainText('对应当前输入');
    const item=report.sections.summary[0];
    const card=page.locator(`[data-report-item="${item.id}"]`);await openItem(card);
    const edited=item.text.includes('验收修订')?item.text:item.text+'（验收修订：以上为录音文本归纳，非学生掌握情况测量。）';
    await card.locator('textarea').fill(edited);await card.locator('[data-item-save]').click();
    await expect(card).toContainText('教师修订');
    await card.locator('[data-item-confirm]').click();await expect(card).toContainText('已确认');
    const evidence=transcript.segments.find(s=>s.id===item.evidenceIds[0]);assert.ok(evidence);
    await card.locator(`[data-evidence="${evidence.id}"]`).click();
    await expect(page.locator('#audio-player')).toHaveJSProperty('paused',false);
    const at=await page.locator('#audio-player').evaluate(el=>{const at=el.currentTime;el.pause();return at;});
    assert.ok(Math.abs(at-evidence.start)<2);
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-report').click()]);
    const file=`${dir}/classroom-reviewed-report.md`;await download.saveAs(file);
    const markdown=await fs.readFile(file,'utf8');
    assert.ok(markdown.includes(edited) && markdown.includes(transcript.id) && markdown.includes('教师修订') && markdown.includes('已确认'));
    await page.reload();await expect(page.locator(`[data-report-item="${item.id}"] textarea`)).toHaveValue(edited);
    await expect(page.locator('#report-meta')).toContainText('对应当前输入');
    assert.deepEqual(errors,[]);
    await fs.writeFile(`${dir}/classroom-browser-results.json`,JSON.stringify({mode:report.mode||'legacy-detailed',itemCount:count,transcriptCount:transcript.segments.length,audioSeekSamples:samples.map(i=>transcript.segments[i].start),evidencePlayback:true,editedItemId:item.id,markdownExport:true,refreshRestored:true,browserErrors:errors,confirmation:'Automated acceptance action, not teacher approval'},null,2));
  } else throw Error('Use correct, review or report');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`${dir}/classroom-${phase}-real.png`});
  console.log(JSON.stringify({phase,transcriptCount:transcript.segments.length,audioPlaybackSamples:3,browserErrors:errors}));
} finally {await browser.close();}
