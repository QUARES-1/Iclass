// Repair only recognized untouched duplicate samples through the public API.
// The endpoint writes a full backup before deleting any duplicate.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.env.LIVE_URL || 'http://127.0.0.1:3000',dir='artifacts/sample-dedup';
const get=async()=>{const response=await fetch(base+'/api/workspace');assert.ok(response.ok);return response.json();};
const post=async revision=>{const response=await fetch(base+'/api/workspace/sample',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})});const result=await response.json();assert.ok(response.ok,result.error);return result;};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stripKey=row=>{const value=structuredClone(row);delete value.sampleKey;return value;};
await fs.mkdir(dir,{recursive:true});
const before=await get(),classroomHash=hash(await fs.readFile('data/classroom.json'));
await fs.writeFile(dir+'/live-before.json',JSON.stringify(before),{mode:0o600});
assert.ok(!before.messages.some(m=>m.status==='processing'));
const after=await post(before.revision);
for(const material of before.materials.filter(m=>m.source!=='sample'))assert.deepEqual(after.materials.find(m=>m.id===material.id),material);
const referenced=new Set(before.messages.map(m=>m.resourceId).filter(Boolean));
for(const resource of before.resources)for(const version of resource.versions)for(const slide of version.content.slides||[])if(slide.attachment?.resourceId)referenced.add(slide.attachment.resourceId);
for(const resource of before.resources){
  const protectedResource=resource.origin!=='sample'||resource.id===before.selectedId||resource.versions.length>1||referenced.has(resource.id)||resource.versions.some(v=>v.confirmed||v.content.slides?.some(s=>s.status==='confirmed'));
  if(protectedResource)assert.deepEqual(stripKey(after.resources.find(r=>r.id===resource.id)),stripKey(resource));
}
assert.equal(after.selectedId,before.selectedId);assert.deepEqual(after.analysis,before.analysis);assert.deepEqual(after.supplements,before.supplements);
let backup=null;
if(after.materials.length<before.materials.length||after.resources.length<before.resources.length){
  for(const name of await fs.readdir('data/backups')){const file=path.join('data/backups',name);if(name.startsWith('workspace-before-sample-dedup-')&&JSON.stringify(JSON.parse(await fs.readFile(file,'utf8')))===JSON.stringify(before))backup=file;}
  assert.ok(backup,'duplicate cleanup must have an exact backup');
}
const saved=await fs.readFile('data/workspace.json');
for(let i=0;i<8;i++)assert.deepEqual(await post(after.revision),after);
assert.deepEqual(await fs.readFile('data/workspace.json'),saved);assert.equal(hash(await fs.readFile('data/classroom.json')),classroomHash);
const result={recordedAt:new Date().toISOString(),before:{materials:before.materials.length,resources:before.resources.length},after:{materials:after.materials.length,resources:after.resources.length},removed:{materials:before.materials.length-after.materials.length,resources:before.resources.length-after.resources.length},retainedTeacherMaterials:after.materials.filter(m=>m.source!=='sample').length,retainedGeneratedResources:after.resources.filter(r=>r.origin!=='sample').length,selectedIdPreserved:true,analysisAndSupplementsPreserved:true,repeatCount:8,repeatDoesNotWrite:true,classroomHashUnchanged:true,backup};
await fs.writeFile(dir+'/live-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
