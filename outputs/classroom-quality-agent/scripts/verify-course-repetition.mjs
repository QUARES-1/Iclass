// Uses temporary synthetic data only; never calls a model or reads teacher data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {CourseService} from '../src/courses.js';
import {Store} from '../src/store.js';
import {emptyWorkspace} from '../src/workspace.js';
import {diskUsage} from '../src/storageQuota.js';

const cycles=Number(process.env.REPETITION_CYCLES||1000);
assert.ok(Number.isSafeInteger(cycles)&&cycles>=1&&cycles<=2000);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'course-repetition-')),service=new CourseService(root);
const courseId=randomUUID(),lessonIds=Array.from({length:24},()=>randomUUID()),measurements=[];
const content='教师讲义：先解释原理，再展示完整函数和调用。\n'.repeat(80);
async function upload(){const req=new PassThrough();req.headers={'content-length':String(Buffer.byteLength(content))};req.end(content);return service.upload(courseId,req,new URL('http://test/resources?name=teacher.md'));}
async function measure(phase){global.gc?.();await new Promise(r=>setImmediate(r));global.gc?.();const usage=await diskUsage(root),memory=process.memoryUsage();const value={phase,...usage,heapUsed:memory.heapUsed,rss:memory.rss,pendingUploads:service.pendingUploads.size,queues:service.store.queues.size,readers:service.readers.size,contexts:service.contextCache.size};measurements.push(value);console.log(JSON.stringify(value));return value;}
try{
 await service.createCourse({id:courseId,title:'重复操作测试课程'});
 for(const id of lessonIds)await service.createLesson(courseId,{id,title:'测试课次',date:'2026-10-21'});
 await upload();const resource=(await service.catalog()).resources[0];
 for(const id of lessonIds){let catalog=await service.catalog();await service.initialize(id);await service.updateLesson(id,{revision:catalog.revision,action:'resources',resourceIds:[resource.id],generatedIds:[]});await service.lessonContext(id);}
 const lessonId=lessonIds[0],store=new Store(service.lessonRoot((await service.lesson(lessonId)).lesson));
 let workspace=await store.read('workspace',emptyWorkspace());workspace=await service.useForPreparation(lessonId,resource.id,{revision:workspace.revision});
 const original=await service.catalog();await measure('warmup');
 async function cycle(i){
  await service.createCourse({id:courseId,title:'重复操作测试课程'});
  await service.createLesson(courseId,{id:lessonId,title:'测试课次',date:'2026-10-21'});
  await upload();await service.updateLesson(lessonId,{revision:original.revision,resourceRevision:1,action:'resources',resourceIds:[resource.id],generatedIds:[]});
  workspace=await service.useForPreparation(lessonId,resource.id,{revision:workspace.revision});
  await service.lessonContext(lessonIds[i%lessonIds.length]);
 }
 for(let i=0;i<100;i++)await cycle(i);const baseline=await measure('baseline');
 for(let i=0;i<cycles;i++)await cycle(i);const after=await measure('repeated');
 const catalog=await service.catalog(),saved=await store.read('workspace',emptyWorkspace()),checks={
  oneCourse:catalog.courses.length===1,lessonsUnchanged:catalog.lessons.length===24,oneResource:catalog.resources.length===1,
  catalogVersionUnchanged:catalog.revision===original.revision,oneMaterial:saved.materials.length===1,
  stableDisk:baseline.files===after.files&&baseline.bytes===after.bytes,transientReleased:after.pendingUploads===0&&after.queues===0,
  boundedCaches:after.readers<=16&&after.contexts<=16,
  retainedHeapBounded:!global.gc||after.heapUsed-baseline.heapUsed<8*1024**2
 };
 assert.deepEqual(await fs.readdir(path.join(root,'course-files')),[resource.file]);
 const result={cycles,warmupCycles:100,offline:true,gcAvailable:Boolean(global.gc),checks,measurements,passed:Object.values(checks).every(Boolean)};
 const output=process.env.REPETITION_REPORT||'artifacts/course-repetition.json';await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify({checks,report:output}));assert.ok(result.passed);
}finally{await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
