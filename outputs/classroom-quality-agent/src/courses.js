import path from 'node:path';
import {mkdir, readdir, readFile, rename, rm, stat} from 'node:fs/promises';
import {createWriteStream, createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createHash} from 'node:crypto';
import {Store, AppError, id} from './store.js';
import {emptyWorkspace, applyWorkspaceCommand, currentVersion} from './workspace.js';
import {emptyClassroom} from './classroom.js';
import {extractUploadedFile} from './fileParser.js';
import {digest} from './feedbackDomain.js';
import {reserveDisk, invalidateUsage, registerQuotaRoot} from './storageQuota.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const COURSE_LIMITS={courses:100,lessons:1000,resources:2000,perCourse:200,perLesson:40,fileBytes:50*1024**2,textCharacters:500000};
const extensions=new Set('.pdf .ppt .pptx .doc .docx .xls .xlsx .txt .md .csv .html .htm .zip .png .jpg .jpeg .webp .mp4 .webm .mp3 .wav .m4a .ogg'.split(' '));
const text=(v,max=500,optional=false)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)||!optional&&!v.trim())throw new AppError('名称或说明为空、过长或含有无效字符。',400);return v.trim();};
const date=value=>{const parsed=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(value+'T12:00:00Z'):null;if(!parsed||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw new AppError('授课日期无效。',400);return value;};
const revision=b=>{if(!Number.isSafeInteger(b.revision)||b.revision<0)throw new AppError('请重新读取课程后再保存。',400);return b.revision;};
const now=()=>new Date().toISOString();
function checkEntity(record,body,key){if(body[key]===undefined)return;if(!Number.isSafeInteger(body[key])||body[key]<0)throw new AppError('信息版本无效，请重新读取。',400);if(body[key]!== (record[key]||0))throw new AppError('这份信息已在其他页面更新，本次输入保留；请重新载入已保存的信息后核对。',409);}

export class CourseService {
  constructor(root){this.root=path.resolve(root);this.store=new Store(this.root);this.initializing=null;this.pendingUploads=new Set();this.initialized=new Set();this.contextCache=new Map();this.readers=new Map();}
  lessonRoot(lesson){return lesson.legacy?this.root:path.join(this.root,'lessons',lesson.id);}
  async catalog(){
    if(this.initializing)return this.initializing;
    const saved=await this.store.read('course-catalog',null);if(saved)return saved;if(this.initializing)return this.initializing;
    this.initializing=(async()=>{
      const names=await readdir(this.root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
      const legacy=names.some(n=>['workspace.json','classroom.json'].includes(n)||/^feedback-class-.*\.json$/.test(n));
      return this.store.update('course-catalog',undefined,{revision:0,courses:[],lessons:[],resources:[]},c=>{
        if(c.courses.length||!legacy)return c;
        const courseId=id();c.courses.push({id:courseId,title:'历史教学资料',description:'升级前的备课、录音与反馈保留在这里，可查看与继续使用。新教学请按课程新建课次。',createdAt:now(),legacy:true});
        c.lessons.push({id:id(),courseId,title:'原有工作区',date:now().slice(0,10),description:'旧数据未自动推断课程归属，保持原有内容与关联。',resourceIds:[],generatedIds:[],legacy:true,createdAt:now()});return c;
      });
    })();
    try{return await this.initializing;}finally{this.initializing=null;}
  }
  async course(courseId){if(!UUID.test(courseId||''))throw new AppError('课程不存在。',404);const c=await this.catalog(),course=c.courses.find(x=>x.id===courseId);if(!course)throw new AppError('课程不存在。',404);return {catalog:c,course};}
  async lesson(lessonId){if(!UUID.test(lessonId||''))throw new AppError('课次不存在。',404);const catalog=await this.catalog(),lesson=catalog.lessons.find(x=>x.id===lessonId),course=catalog.courses.find(x=>x.id===lesson?.courseId);if(!lesson||!course)throw new AppError('课次不存在。',404);return {catalog,course,lesson};}
  async change(body,fn,key){await this.catalog();const currentRevision=revision(body);return this.store.update('course-catalog',key&&body[key]!==undefined?undefined:currentRevision,null,fn,{skipUnchanged:true});}
  async createCourse(body){
    const title=text(body.title),description=text(body.description||'',8000,true),courseId=body.id||id();if(typeof courseId!=='string'||!UUID.test(courseId))throw new AppError('课程标识无效。',400);
    // A request ID makes a retried create a no-op even if its response was lost.
    await this.catalog();return this.store.update('course-catalog',undefined,null,c=>{const found=c.courses.find(x=>x.id===courseId);if(found){if(found.title!==title||found.description!==description)throw new AppError('该课程标识已使用，请重新创建。',409);return c;}if(c.courses.length>=COURSE_LIMITS.courses)throw new AppError('课程最多100门，请先整理已有课程。',413);c.courses.push({id:courseId,title,description,createdAt:now()});return c;},{skipUnchanged:true});
  }
  async createLesson(courseId,body){
    await this.course(courseId);const title=text(body.title),day=date(body.date),description=text(body.description||'',8000,true),lessonId=body.id||id();if(typeof lessonId!=='string'||!UUID.test(lessonId))throw new AppError('课次标识无效。',400);
    return this.store.update('course-catalog',undefined,null,c=>{const course=c.courses.find(x=>x.id===courseId);if(course.archived)throw new AppError('请先恢复已归档课程。',409);const found=c.lessons.find(x=>x.id===lessonId);if(found){if(found.courseId!==courseId||found.title!==title||found.date!==day||found.description!==description)throw new AppError('该课次标识已使用。',409);return c;}if(c.lessons.length>=COURSE_LIMITS.lessons)throw new AppError('课次最多1000节，请先整理已有记录。',413);c.lessons.push({id:lessonId,courseId,title,date:day,description,resourceIds:[],generatedIds:[],createdAt:now()});return c;},{skipUnchanged:true});
  }
  async updateCourse(courseId,body){
    const {catalog}=await this.course(courseId);if(body.action==='archive'&&this.beforeArchive)await this.beforeArchive(catalog.lessons.filter(l=>l.courseId===courseId));
    return this.change(body,c=>{const course=c.courses.find(x=>x.id===courseId);
      if(body.action==='archive')course.archived=true;
      else if(body.action==='restore')course.archived=false;
      else if(body.action==='update'){checkEntity(course,body,'metadataRevision');const title=text(body.title),description=text(body.description||'',8000,true);if(title!==course.title||description!==course.description){course.title=title;course.description=description;course.metadataRevision=(course.metadataRevision||0)+1;}}
      else throw new AppError('课程操作无效。',400);return c;
    },body.action==='update'?'metadataRevision':undefined);
  }
  async updateLesson(lessonId,body){
    const {lesson,course}=await this.lesson(lessonId);
    if(body.action==='archive'&&this.beforeArchive)await this.beforeArchive([lesson]);
    if(lesson.archived&&!['restore','archive'].includes(body.action))throw new AppError('请先恢复已归档课次。',409);
    if(course.archived&&body.action!=='restore')throw new AppError('请先恢复已归档课程。',409);
    return this.change(body,async c=>{const l=c.lessons.find(x=>x.id===lessonId);
      if(l.archived&&!['restore','archive'].includes(body.action))throw new AppError('请先恢复已归档课次。',409);
      if(c.courses.find(x=>x.id===l.courseId)?.archived&&body.action!=='restore')throw new AppError('请先恢复已归档课程。',409);
      if(body.action==='archive')l.archived=true;
      else if(body.action==='restore')l.archived=false;
      else if(body.action==='update'){checkEntity(l,body,'metadataRevision');const title=text(body.title),day=date(body.date),description=text(body.description||'',8000,true);if(title!==l.title||day!==l.date||description!==l.description){l.title=title;l.date=day;l.description=description;l.metadataRevision=(l.metadataRevision||0)+1;}}
      else if(body.action==='resources'){
        checkEntity(l,body,'resourceRevision');
        if(!Array.isArray(body.resourceIds)||!Array.isArray(body.generatedIds)||body.resourceIds.length+body.generatedIds.length>COURSE_LIMITS.perLesson||new Set(body.resourceIds).size!==body.resourceIds.length||new Set(body.generatedIds).size!==body.generatedIds.length)throw new AppError('每节课最多选择40份资源，不能重复。',400);
        if(body.resourceIds.some(r=>!c.resources.some(a=>a.id===r&&a.courseId===lesson.courseId))||body.generatedIds.some(r=>typeof r!=='string'||!UUID.test(r)))throw new AppError('资源不属于当前课程。',400);
        const w=await new Store(this.lessonRoot(l)).read('workspace',emptyWorkspace());
        if(body.generatedIds.some(id=>!w.resources.some(r=>r.id===id)))throw new AppError('所选生成资源已不存在，请刷新后选择。',409);
        let characters=0;
        for(const rid of body.resourceIds){const r=c.resources.find(x=>x.id===rid),content=await this.store.read('course-content-'+rid,null);characters+=(r.description||'').length+(content?.content||'').length;}
        for(const rid of body.generatedIds)characters+=JSON.stringify(currentVersion(w.resources.find(r=>r.id===rid)).content).length;
        if(characters>COURSE_LIMITS.textCharacters)throw new AppError('所选资源正文合计超过50万字符，请减少选择；资料库原文件保留。',413);
        if(JSON.stringify(l.resourceIds)!==JSON.stringify(body.resourceIds)||JSON.stringify(l.generatedIds)!==JSON.stringify(body.generatedIds)){l.resourceIds=[...body.resourceIds];l.generatedIds=[...body.generatedIds];l.resourceRevision=(l.resourceRevision||0)+1;}
      }else throw new AppError('课次操作无效。',400);return c;
    },body.action==='update'?'metadataRevision':body.action==='resources'?'resourceRevision':undefined);
  }
  async initialize(lessonId){
    const context=await this.lesson(lessonId),root=this.lessonRoot(context.lesson);registerQuotaRoot(root,this.root);
    if(!context.lesson.legacy&&!this.initialized.has(lessonId)){
      const store=new Store(root),w=await store.read('workspace',null),c=await store.read('classroom',null);
      if(!w)await store.update('workspace',undefined,emptyWorkspace(),current=>{if(current.savedAt)return current;current.requirements.topic=context.lesson.title;current.requirements.instructions=context.lesson.description;return current;},{skipUnchanged:true});
      if(!c)await store.update('classroom',undefined,emptyClassroom(),current=>{if(current.savedAt)return current;current.course.title=context.lesson.title;current.course.description=context.lesson.description;return current;},{skipUnchanged:true});
      this.initialized.add(lessonId);
    }return {...context,root};
  }
  async resource(courseId,resourceId){const {catalog}=await this.course(courseId),resource=catalog.resources.find(x=>x.id===resourceId&&x.courseId===courseId);if(!resource)throw new AppError('课程资源不存在。',404);return resource;}
  async saveResource(courseId,record,content=''){
    await this.course(courseId);
    return this.store._serial('course-resource-'+record.id,async()=>{
    // Store the extracted content once, separately from the small catalog.
    const contentKey='course-content-'+record.id,existing=content?await this.store.read(contentKey,null):null;
    try{
      if(content)await this.store.update(contentKey,undefined,{revision:0},c=>c.content===content?c:{revision:c.revision,content},{skipUnchanged:true});
      return await this.store.update('course-catalog',undefined,null,c=>{if(c.courses.find(x=>x.id===courseId)?.archived)throw new AppError('请先恢复已归档课程。',409);if(c.resources.some(x=>x.courseId===courseId&&x.id===record.id))return c;if(c.resources.length>=COURSE_LIMITS.resources||c.resources.filter(x=>x.courseId===courseId).length>=COURSE_LIMITS.perCourse)throw new AppError('资料库已达到数量上限：每课程200份、总计2000份。',413);c.resources.push({...record,courseId,createdAt:now()});return c;},{skipUnchanged:true});
    }catch(error){if(content&&!existing)await this.store.remove(contentKey);throw error;}
    });
  }
  async addLink(courseId,body){
    const title=text(body.title,255),description=text(body.description||'',8000,true);let url;
    try{url=new URL(body.url);}catch{throw new AppError('请输入完整的 HTTP 或 HTTPS 网页地址。',400);}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2048)throw new AppError('网页地址无效，不能包含用户名或密码。',400);
    const key=createHash('sha256').update(courseId+'\n'+url.href).digest('hex');
    return this.saveResource(courseId,{id:key,title,kind:'link',url:url.href,description,parseStatus:'网页内容未自动抓取，请填写教学说明'});
  }
  async updateResource(courseId,resourceId,body){await this.resource(courseId,resourceId);return this.change(body,c=>{
    if(c.courses.find(x=>x.id===courseId)?.archived)throw new AppError('请先恢复已归档课程。',409);
    const r=c.resources.find(x=>x.id===resourceId&&x.courseId===courseId);if(!r)throw new AppError('资源已变化，请重新读取课程。',409);
    checkEntity(r,body,'metadataRevision');const title=text(body.title,255),description=text(body.description||'',8000,true);
    if(title!==r.title||description!==r.description){r.title=title;r.description=description;r.metadataRevision=(r.metadataRevision||0)+1;}return c;
  },'metadataRevision');}
  async removeResource(courseId,resourceId,body){
    const resource=await this.resource(courseId,resourceId);
    const remove=()=>this.store._serial('course-resource-'+resourceId,async()=>{
      await this.change(body,c=>{if(c.courses.find(x=>x.id===courseId)?.archived)throw new AppError('请先恢复已归档课程。',409);if(c.lessons.some(l=>l.resourceIds.includes(resourceId)))throw new AppError('仍有课次使用该资源，请先在相关课次取消选择并保存。',409);c.resources=c.resources.filter(r=>r.id!==resourceId||r.courseId!==courseId);return c;});
      // Recovery must not reintroduce a catalog entry whose original was deleted.
      await this.store.checkpoint('course-catalog');
      if(resource.file&&!(await this.catalog()).resources.some(r=>r.file===resource.file))await rm(path.join(this.root,'course-files',resource.file),{force:true});
      await this.store.remove('course-content-'+resourceId);invalidateUsage(this.root);return this.catalog();
    });
    if(!resource.file)return remove();
    const [blob,ext]=resource.file.split('.');return this.store._serial('course-upload-'+blob+'-'+ext,remove);
  }
  async upload(courseId,req,url){
    const {course}=await this.course(courseId);if(this.pendingUploads.size>=3)throw new AppError('已有3份资料正在上传，请稍后重试。',429);if(course.archived)throw new AppError('请先恢复已归档课程。',409);
    const name=text(url.searchParams.get('name'),255),ext=path.extname(name).toLowerCase();
    if(/[\\/\x00-\x1f\x7f]/.test(name)||!extensions.has(ext))throw new AppError('不支持此文件类型。请使用文档、图片、音视频、HTML 或 ZIP 教学资源。',415);
    const size=Number(req.headers['content-length']);if(size>COURSE_LIMITS.fileBytes){req.resume();throw new AppError('课程资源单个文件最多50 MiB。',413);}
    const dir=path.join(this.root,'course-files'),temp=path.join(dir,id()+'.tmp'),hash=createHash('sha256');let bytes=0,target,created=false,stored=false,release;
    this.pendingUploads.add(temp);
    try{
      release=await reserveDisk(this.root,Number.isFinite(size)&&size>0?Math.min(size,COURSE_LIMITS.fileBytes):COURSE_LIMITS.fileBytes);
      await mkdir(dir,{recursive:true,mode:0o700});
      await pipeline(req,new Transform({transform(chunk,_,cb){bytes+=chunk.length;if(bytes<=COURSE_LIMITS.fileBytes){hash.update(chunk);cb(null,chunk);}else cb();}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
      if(!bytes)throw new AppError('文件为空。',400);if(bytes>COURSE_LIMITS.fileBytes)throw new AppError('课程资源单个文件最多50 MiB。',413);
      const blob=hash.digest('hex'),key=createHash('sha256').update(courseId+'\n'+name+'\n'+blob).digest('hex');target=path.join(dir,blob+ext);
      let content='',parseStatus='原文件已保存；此格式未提取正文，可补充教学说明',truncated=false;
      if(['.txt','.md','.docx','.pptx'].includes(ext)&&bytes<=15*1024**2){
        try{const extracted=await extractUploadedFile(await readFile(temp),name);content=extracted.text||extracted.content||'';truncated=Boolean(extracted.truncated);parseStatus=content?'已提取正文'+(truncated?'（已截取，原文件完整保留）':''):'未提取到正文，请补充教学说明';}catch(e){parseStatus='原文件已保存，正文提取失败，请补充教学说明';}
      }
      return await this.store._serial('course-upload-'+blob+'-'+ext.slice(1),async()=>{
        try{
          if(!await stat(target).catch(()=>null)){await rename(temp,target);created=true;}
          const result=await this.saveResource(courseId,{id:key,title:name,name,kind:'file',file:blob+ext,bytes,description:'',parseStatus,truncated,characters:content.length},content);
          stored=true;return result;
        }catch(error){if(created&&!stored)await rm(target,{force:true});created=false;throw error;}
      });
    }finally{this.pendingUploads.delete(temp);try{await rm(temp,{force:true}).catch(error=>{if(error.code!=='ENOTDIR')throw error;});}finally{release?.(stored&&created?bytes:0);}}
  }
  async lessonContext(lessonId){
    const context=await this.lesson(lessonId),{catalog,lesson,course}=context,resources=[];let total=0;
    let reader=this.readers.get(lessonId);if(!reader){reader=new Store(this.lessonRoot(lesson));this.readers.set(lessonId,reader);if(this.readers.size>16)this.readers.delete(this.readers.keys().next().value);}
    const stamp=catalog.revision+':'+await reader.revision('workspace',emptyWorkspace()),cached=this.contextCache.get(lessonId);
    if(cached?.stamp===stamp)return cached.value;
    const identity={id:lesson.id,title:lesson.title,date:lesson.date,description:lesson.description,courseId:course.id,courseTitle:course.title};
    for(const resourceId of lesson.resourceIds){const r=catalog.resources.find(a=>a.id===resourceId&&a.courseId===course.id);if(!r)continue;const content=await this.store.read('course-content-'+r.id,null);resources.push({id:r.id,title:r.title,origin:'教师资料',url:r.url||null,description:r.description,content:content?.content||'',parseStatus:r.parseStatus});}
    const workspace=await reader.read('workspace',emptyWorkspace());
    for(const resourceId of lesson.generatedIds){const r=workspace.resources.find(r=>r.id===resourceId);if(r)resources.push({id:r.id,title:r.name,origin:'备课生成',content:JSON.stringify(currentVersion(r).content)});}
    const chunks=[];
    for(const r of resources){const content=[r.description||'',r.content||''].filter(Boolean).join('\n');total+=content.length;if(total>COURSE_LIMITS.textCharacters)return {...identity,resources:[],resourceError:'所选资源更新后正文合计超过50万字符，请在课次概览减少选择后重新分析。原文件与历史报告保留。'};if(!content){chunks.push({...r,id:r.id+'-0',content:'未取得该资源正文；只能依据名称与教师说明，不推断其具体内容。'});continue;}for(let offset=0;offset<content.length;offset+=4000)chunks.push({...r,id:r.id+'-'+offset,content:content.slice(offset,offset+4000)});}
    const value={...identity,resources:chunks};this.contextCache.set(lessonId,{stamp,value});if(this.contextCache.size>16)this.contextCache.delete(this.contextCache.keys().next().value);return value;
  }
  async useForPreparation(lessonId,resourceId,body){
    const {course,lesson}=await this.initialize(lessonId);if(course.archived||lesson.archived)throw new AppError('请先恢复已归档课次。',409);
    const resource=await this.resource(course.id,resourceId);if(!lesson.resourceIds.includes(resourceId))throw new AppError('请先将资料选入本课次。',409);
    const saved=await this.store.read('course-content-'+resourceId,null),content=[resource.description,saved?.content].filter(Boolean).join('\n');if(!content)throw new AppError('此资源尚无可供AI使用的正文，请先补充教学说明。',422);
    const store=new Store(this.lessonRoot(lesson));
    return store.update('workspace',revision(body),emptyWorkspace(),w=>{
      const existing=w.materials.find(m=>m.libraryId===resourceId);if(existing?.content===content&&existing.title===resource.title)return w;
      if(existing)w.materials=w.materials.filter(m=>m.id!==existing.id);
      applyWorkspaceCommand(w,{action:'material',material:{title:resource.title,content,type:'课程资料库'}});w.materials.at(-1).libraryId=resourceId;return w;
    },{skipUnchanged:true});
  }
  async transferredHandoff(sourceId,key,targetId){
    if(!HASH.test(key||''))throw new AppError('建议交接不存在。',404);
    const source=await this.lesson(sourceId),target=await this.lesson(targetId);
    if(source.course.id!==target.course.id)throw new AppError('请选择同一课程的目标课次。',409);
    const store=new Store(this.lessonRoot(source.lesson)),h=await store.read('feedback-handoff-'+key,null);
    if(!h)throw new AppError('建议交接不存在。',404);
    const c=await store.read('feedback-class-'+h.classId,null);if(!c||c.deleted)throw new AppError('建议来源已删除。',404);
    let changed=false;
    if(!source.lesson.legacy){const lesson=await this.lessonContext(sourceId);changed=c.lessonSignature!==digest({title:lesson.title,date:lesson.date,description:lesson.description,course:lesson.courseTitle,resources:lesson.resources,error:lesson.resourceError});}
    const room=await store.read('classroom',null),workspace=await store.read('workspace',null);
    if(c.source&&room?.currentTranscriptId!==c.source.transcriptId)changed=true;
    if(c.ppt&&workspace?.resources.find(r=>r.id===c.ppt.resourceId)?.currentVersionId!==c.ppt.versionId)changed=true;
    const stale=changed||Boolean(h.reportId&&!c.reports.some(r=>r.id===h.reportId&&r.version===h.reportVersion&&!r.stale))||Boolean(h.versions&&(h.versions.data!==c.dataVersion||h.versions.source!==c.sourceVersion||h.versions.suggestions!==(c.suggestionVersion||0)));
    return {...h,sourceLessonId:sourceId,targetLessonId:targetId,sourceTarget:h.target,target:sourceId===targetId?h.target:null,stale,url:'/public/index.html?lesson='+targetId+'&feedback='+key+'&sourceLesson='+sourceId};
  }
  async handle(req,res,url,{json,bodyJSON}){
    const p=url.pathname,post=req.method==='POST',get=req.method==='GET';if(!p.startsWith('/api/courses')&&!p.startsWith('/api/lessons'))return false;
    const send=value=>{json(res,value);return true;};
    if(p==='/api/courses'){if(get)return send({...await this.catalog(),limits:COURSE_LIMITS});if(post)return send(await this.createCourse(await bodyJSON(req)));}
    const coursePath=p.match(/^\/api\/courses\/([a-f0-9-]+)(?:\/(lessons|resources)(?:\/([a-f0-9]+)(?:\/(download))?)?)?$/);
    if(coursePath){const [,courseId,action,resourceId,download]=coursePath;await this.course(courseId);
      if(!action&&get){const {catalog,course}=await this.course(courseId);return send({revision:catalog.revision,course,lessons:catalog.lessons.filter(l=>l.courseId===courseId),resources:catalog.resources.filter(r=>r.courseId===courseId),limits:COURSE_LIMITS});}
      if(!action&&post)return send(await this.updateCourse(courseId,await bodyJSON(req)));
      if(action==='lessons'&&post)return send(await this.createLesson(courseId,await bodyJSON(req)));
      if(action==='resources'&&!resourceId&&post)return send(url.searchParams.get('kind')==='file'?await this.upload(courseId,req,url):await this.addLink(courseId,await bodyJSON(req)));
      if(resourceId&&post){const b=await bodyJSON(req);return send(b.action==='remove'?await this.removeResource(courseId,resourceId,b):await this.updateResource(courseId,resourceId,b));}
      if(download&&get){const r=await this.resource(courseId,resourceId);if(r.kind!=='file'||!HASH.test(r.file?.split('.')[0]||''))throw new AppError('原文件不存在。',404);const file=path.join(this.root,'course-files',r.file),info=await stat(file).catch(()=>{throw new AppError('原文件不存在。',404);});res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(r.name),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});const stream=createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;}
    }
    const lessonPath=p.match(/^\/api\/lessons\/([a-f0-9-]+)(?:\/(prepare|handoff))?$/);
    if(lessonPath){const [,lessonId,action]=lessonPath,context=await this.initialize(lessonId);
      if(action==='handoff'&&get)return send(await this.transferredHandoff(lessonId,url.searchParams.get('id'),url.searchParams.get('target')));
      if(action==='prepare'&&post){const b=await bodyJSON(req);return send(await this.useForPreparation(lessonId,b.resourceId,b));}
      if(get){const store=new Store(context.root),workspace=await store.read('workspace',emptyWorkspace()),classroom=await store.read('classroom',emptyClassroom());return send({revision:context.catalog.revision,course:context.course,lesson:context.lesson,resources:context.catalog.resources.filter(r=>r.courseId===context.course.id),generated:workspace.resources.map(r=>({id:r.id,name:r.name,type:r.type,versionId:r.currentVersionId})),workspaceRevision:workspace.revision,audio:classroom.audio,transcript:classroom.currentTranscriptId,report:classroom.currentReportId,limits:COURSE_LIMITS});}
      if(post)return send(await this.updateLesson(lessonId,await bodyJSON(req)));
    }
    throw new AppError('课程或课次接口不存在。',404);
  }
}
