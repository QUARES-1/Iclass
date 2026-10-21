import {readdir,readFile,writeFile,stat,rm,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {AppError,clone,id} from './store.js';
import {dataLimit,diskUsage,reserveDisk,invalidateUsage,quotaRoot} from './storageQuota.js';
const zip=promisify(gzip),unzip=promisify(gunzip),terminal=new Set(['completed','failed','paused','cancelled']);
const roots=/^(workspace|classroom|model-settings|feedback-settings|feedback-templates|feedback-form-bindings|storage-archives|feedback-class-[a-f0-9-]+|feedback-handoff-[a-f0-9]+)$/;
const managed=/^(agent-|teaching-input-|classroom-progress-|classroom-asr-|feedback-(job|input|material|source|import)-)/;
function strings(value,out=new Set()){
  if(typeof value==='string')out.add(value);else if(Array.isArray(value))for(const item of value)strings(item,out);else if(value&&typeof value==='object')for(const item of Object.values(value))strings(item,out);return out;
}
const suffix=key=>key.replace(/^(?:teaching-input|classroom-progress|classroom-asr|feedback-(?:job|input|material|source|import)|agent)-/,'');
export class StorageManager{
  constructor(store){this.store=store;}
  async records(){const names=await readdir(this.store.root).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),backups=await readdir(path.join(this.store.root,'.recovery')).catch(()=>[]);return [...new Set([...names,...backups].filter(f=>/^[a-z0-9-]+\.json$/i.test(f)).map(f=>f.slice(0,-5)))];}
  async status(){
    const usage=await diskUsage(this.store.root),archives=await this.store.read('storage-archives',{revision:0,items:[]});
    const scoped=quotaRoot(this.store.root)!==this.store.root,total=scoped?await diskUsage(quotaRoot(this.store.root)):usage;
    return {...usage,scoped,globalBytes:total.bytes,maxBytes:dataLimit(),archives:archives.items.map(({id,createdAt,bytes,counts})=>({id,createdAt,bytes,counts})),recoveries:[...this.store.recoveries.values()],cache:{bytes:this.store.cacheBytes,entries:this.store.cache.size}};
  }
  async audioPins(){
    let index=await this.store.read('storage-audio-pins',null);
    if(!index?.complete){
      const sources={};for(const key of await this.records())if(key.startsWith('feedback-source-')){const source=await this.store.read(key,null);if(source?.audio&&!source.audio.deleted)sources[source.id]=[source.audio.file,source.audio.playbackFile].filter(Boolean);}
      index={revision:0,sources,complete:true};try{index=await this.store.update('storage-audio-pins',undefined,{revision:0},c=>({...c,sources:{...(c.sources||{}),...sources},complete:true}),{skipUnchanged:true});}catch(error){if(error.statusCode!==413)throw error;}
    }
    return new Set(Object.values(index.sources||{}).flat());
  }
  async assertIdle(){
    const safeRead=key=>this.store.read(key,null).catch(error=>{if(error.statusCode===503)return null;throw error;}),w=await safeRead('workspace'),c=await safeRead('classroom');
    if(w?.messages.some(m=>m.status==='processing')||c?.jobs.some(j=>!terminal.has(j.stage)))throw new AppError('请先暂停或完成任务，再管理历史数据。',409);
    for(const key of await this.records())if(key.startsWith('feedback-class-')){
      const f=await safeRead(key);if(f?.activeJobId||['publishing'].includes(f?.publish?.status)||f?.sync?.status==='syncing')throw new AppError('问卷或反馈任务进行中，请完成后重试。',409);
    }
  }
  async cleanup(){
    const keys=await this.records(),refs=new Set(),keep=new Set(),docs=new Map();
    let removed=0,bytes=0;
    for(const key of keys){
      if(!roots.test(key))continue;const doc=await this.store.read(key,null);docs.set(key,doc);keep.add(key);if(doc?.deleted){
        if(key.startsWith('feedback-class-')&&Object.keys(doc).some(k=>!['id','revision','savedAt','deleted'].includes(k))){await this.store.update(key,doc.revision,doc,c=>({id:c.id,revision:c.revision,savedAt:c.savedAt,deleted:true}),{reclaimBytes:Buffer.byteLength(JSON.stringify(doc))});await this.store.checkpoint(key);removed++;}continue;
      }strings(doc,refs);
      // A recovery copy must retain the task/source files it may need.
      try{strings(JSON.parse(await readFile(this.store.backup(key),'utf8')),refs);}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    let changed=true;
    while(changed){changed=false;for(const key of keys)if(managed.test(key)&&!keep.has(key)&&(refs.has(key)||refs.has(suffix(key)))){
      const doc=await this.store.read(key,null);docs.set(key,doc);keep.add(key);strings(doc,refs);changed=true;
    }}
    const sources={};for(const [key,doc]of docs)if(key.startsWith('feedback-source-')&&doc?.audio&&!doc.audio.deleted)sources[doc.id]=[doc.audio.file,doc.audio.playbackFile].filter(Boolean);
    try{await this.store.update('storage-audio-pins',undefined,{revision:0,sources:{}},c=>({...c,sources,complete:true}),{skipUnchanged:true});}catch(error){if(error.statusCode!==413)throw error;}
    for(const key of keys)if(managed.test(key)&&!keep.has(key)){
      const file=this.store.file(key),info=await stat(file).catch(()=>null)||await stat(this.store.backup(key)).catch(()=>null);if(!info)continue;
      // Recently prepared inputs might not yet be attached to a document.
      // The API also prevents cleanup while a mutation is being admitted.
      if(key.startsWith('feedback-import-')&&Date.now()-info.mtimeMs<3600000)continue;
      bytes+=info.size;await this.store.remove(key);removed++;
    }
    // Only old, unfinished atomic-write files are temporary; never follow links.
    for(const dir of [this.store.root,path.join(this.store.root,'audio'),path.join(this.store.root,'.recovery')])for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[]))if(entry.isFile()&&entry.name.endsWith('.tmp')){
      const file=path.join(dir,entry.name),info=await stat(file).catch(()=>null);if(info&&Date.now()-info.mtimeMs>86400000){await rm(file,{force:true});removed++;bytes+=info.size;}
    }
    for(const entry of await readdir(path.join(this.store.root,'audio'),{withFileTypes:true}).catch(()=>[]))if(entry.isFile()&&/^[a-f0-9-]+(?:\.(?:wav|mp3|m4a|webm|ogg)|\.play\.mp3)$/.test(entry.name)&&!refs.has(entry.name)){
      const file=path.join(this.store.root,'audio',entry.name),info=await stat(file);await rm(file,{force:true});removed++;bytes+=info.size;
    }
    const archived=new Set((await this.store.read('storage-archives',{revision:0,items:[]})).items.map(a=>a.id+'.json.gz'));
    for(const entry of await readdir(path.join(this.store.root,'.archives'),{withFileTypes:true}).catch(()=>[]))if(entry.isFile()&&/^[a-f0-9-]{36}\.json\.gz$/.test(entry.name)&&!archived.has(entry.name)){
      const file=path.join(this.store.root,'.archives',entry.name),info=await stat(file);if(Date.now()-info.mtimeMs>86400000){await rm(file,{force:true});removed++;bytes+=info.size;}
    }
    invalidateUsage(this.store.root);return {removed,bytes};
  }
  async deleteArchive(archiveId){
    if(!/^[a-f0-9-]{36}$/.test(archiveId))throw new AppError('归档标识无效。',400);
    const file=path.join(this.store.root,'.archives',archiveId+'.json.gz'),info=await stat(file).catch(()=>null);
    await this.store.update('storage-archives',undefined,{revision:0,items:[]},c=>{c.items=c.items.filter(a=>a.id!==archiveId);return c;},{skipUnchanged:true,reclaimBytes:info?.size||0});
    await rm(path.join(this.store.root,'.archives',archiveId+'.json.gz'),{force:true});await this.store.checkpoint('storage-archives');invalidateUsage(this.store.root);return {deleted:true};
  }
  async archive(keep=20){
    if(!Number.isSafeInteger(keep)||keep<2||keep>200)throw new AppError('保留历史数量须为2～200。',400);
    const workspace=await this.store.read('workspace',null),classroom=await this.store.read('classroom',null),nextW=clone(workspace),nextC=clone(classroom),protectedIds=new Set();
    for(const key of await this.records())if(key.startsWith('feedback-class-')||key.startsWith('feedback-handoff-'))strings(await this.store.read(key,null),protectedIds);
    for(const message of workspace?.messages||[])if(message.jobId&&['paused','failed','processing'].includes(message.status)){const job=await this.store.read('agent-'+message.jobId,null);strings(job,protectedIds);if(job?.inputRef)strings(await this.store.read(job.inputRef,null),protectedIds);}
    let versions=0,messages=0,transcripts=0,reports=0,revisions=0;
    const trim=(items,protect)=>items.filter((item,i)=>i>=items.length-keep||protect(item));
    if(nextW){
      for(const r of nextW.resources){const current=r.versions.find(v=>v.id===r.currentVersionId);const pinned=new Set([r.currentVersionId,current?.parentId]);
        for(const resource of nextW.resources)for(const v of resource.versions)for(const s of v.content.slides||[])if(s.attachment)pinned.add(s.attachment.versionId);
        const old=r.versions.length;r.versions=trim(r.versions,v=>pinned.has(v.id)||protectedIds.has(v.id));versions+=old-r.versions.length;
      }
      const old=nextW.messages.length;nextW.messages=nextW.messages.filter((m,i)=>i>=old-200||['processing','paused','failed'].includes(m.status));messages+=old-nextW.messages.length;
    }
    if(nextC){
      const old=nextC.reports.length;nextC.reports=trim(nextC.reports,r=>r.id===nextC.currentReportId||protectedIds.has(r.id));reports+=old-nextC.reports.length;
      for(const r of nextC.reports){const n=r.history?.length||0;if(r.history)r.history=r.history.slice(-keep);revisions+=n-(r.history?.length||0);}
      const pinned=new Set([nextC.currentTranscriptId,...nextC.reports.map(r=>r.transcriptId)]);
      for(const job of nextC.jobs)if(['paused','failed'].includes(job.stage))pinned.add(job.input?.transcriptId);
      const all=nextC.transcriptVersions,byId=new Map(all.map(t=>[t.id,t]));
      const recent=trim(all,t=>pinned.has(t.id)||protectedIds.has(t.id)),originals=new Set();
      for(const t of recent){let original=t.originalTranscriptId?byId.get(t.originalTranscriptId):t;const seen=new Set();while(original&&original.source!=='asr'&&!seen.has(original.id)){seen.add(original.id);original=byId.get(original.parentId);}if(original?.source==='asr'){if(recent.length<all.length)t.originalTranscriptId=original.id;originals.add(original.id);}}
      const ids=new Set(recent.map(t=>t.id));nextC.transcriptVersions=all.filter(t=>ids.has(t.id)||originals.has(t.id));transcripts+=all.length-nextC.transcriptVersions.length;
      const count=nextC.conversation?.length||0;nextC.conversation=(nextC.conversation||[]).slice(-200);messages+=count-nextC.conversation.length;
      nextC.jobs=nextC.jobs.filter((j,i)=>i>=nextC.jobs.length-keep||j.stage!=='completed'&&j.stage!=='cancelled');
    }
    const feedback=new Map();
    const templates=await this.store.read('feedback-templates',null);
    if(templates){const next=clone(templates);next.versions=trim(next.versions,v=>protectedIds.has(v.id));if(next.versions.length!==templates.versions.length){versions+=templates.versions.length-next.versions.length;feedback.set('feedback-templates',{original:templates,next});}}
    for(const key of await this.records())if(key.startsWith('feedback-class-')){
      const original=await this.store.read(key,null);if(!original||original.deleted)continue;const next=clone(original);
      const count=next.reports.length;next.reports=trim(next.reports,r=>r.id===next.currentReportId);reports+=count-next.reports.length;
      for(const report of next.reports){const n=report.history?.length||0;report.history=(report.history||[]).slice(-keep);revisions+=n-report.history.length;}
      const n=next.messages.length;next.messages=next.messages.slice(-200);messages+=n-next.messages.length;
      const pinned=new Set(next.messages.map(m=>m.jobId).filter(Boolean));const ids=[];
      for(const jobId of next.jobIds||[]){const job=await this.store.read('feedback-job-'+jobId,null);if(pinned.has(jobId)||job&&!['completed','cancelled'].includes(job.status))ids.push(jobId);}next.jobIds=ids;
      if(JSON.stringify(original)!==JSON.stringify(next))feedback.set(key,{original,next});
    }
    const counts={versions,messages,transcripts,reports,revisions};
    if(JSON.stringify(nextW)===JSON.stringify(workspace)&&JSON.stringify(nextC)===JSON.stringify(classroom)&&!feedback.size)return {skipped:true,counts};
    const archiveId=id(),createdAt=new Date().toISOString(),documents={workspace,classroom};
    for(const [key,{original}]of feedback)documents[key]=original;
    // Preserve task receipts and immutable inputs for archived conversations.
    for(const m of workspace?.messages||[])if(m.jobId){const key='agent-'+m.jobId,job=await this.store.read(key,null);if(job){documents[key]=job;if(job.inputRef)documents[job.inputRef]=await this.store.read(job.inputRef,null);}}
    const refs=strings(documents),keys=await this.records();let expanded=true;
    while(expanded){expanded=false;for(const key of keys)if(managed.test(key)&&!documents[key]&&(refs.has(key)||refs.has(suffix(key)))){documents[key]=await this.store.read(key,null);strings(documents[key],refs);expanded=true;}}
    const text=JSON.stringify({schema:1,id:archiveId,createdAt,documents});if(Buffer.byteLength(text)>256*1024**2)throw new AppError('归档超过256 MiB，请先备份数据目录并清理不需要的课堂。',413);
    const packed=await zip(Buffer.from(text)),directory=path.join(this.store.root,'.archives'),file=path.join(directory,archiveId+'.json.gz');
    const release=await reserveDisk(this.store.root,packed.length);
    try{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file,packed,{flag:'wx',mode:0o600});release(packed.length);}catch(error){release();throw error;}
    try{
      const audioFiles=[...refs].filter(value=>/^[a-f0-9-]+(?:\.(?:wav|mp3|m4a|webm|ogg)|\.play\.mp3)$/.test(value));
      await this.store.update('storage-archives',undefined,{revision:0,items:[]},c=>{c.items.push({id:archiveId,createdAt,bytes:packed.length,counts,audioFiles});return c;});
    }catch(error){await rm(file,{force:true});invalidateUsage(this.store.root);throw error;}
    if(workspace)await this.store.update('workspace',workspace.revision,workspace,()=>nextW,{skipUnchanged:true});
    if(classroom)await this.store.update('classroom',classroom.revision,classroom,()=>nextC,{skipUnchanged:true});
    for(const [key,{original,next}]of feedback)await this.store.update(key,original.revision,original,()=>next,{skipUnchanged:true});
    for(const key of ['workspace','classroom',...feedback.keys()])if(await this.store.read(key,null))await this.store.checkpoint(key);
    return {id:archiveId,counts};
  }
  async restore(archiveId){
    if(!/^[a-f0-9-]{36}$/.test(archiveId))throw new AppError('归档标识无效。',400);
    const index=await this.store.read('storage-archives',{revision:0,items:[]});if(!index.items.some(a=>a.id===archiveId))throw new AppError('归档不存在。',404);
    let archive;try{archive=JSON.parse(await unzip(await readFile(path.join(this.store.root,'.archives',archiveId+'.json.gz')),{maxOutputLength:256*1024**2}));}catch{throw new AppError('归档损坏，当前数据未被恢复操作替换。',422);}
    if(archive.schema!==1||archive.id!==archiveId||!archive.documents)throw new AppError('归档结构无效。',422);
    const historicalAudio=new Map();
    for(const audio of [archive.documents.classroom?.audio,...(archive.documents.classroom?.transcriptVersions||[]).map(t=>t.audio),...(archive.documents.classroom?.jobs||[]).map(j=>j.audio)])if(audio&&!audio.deleted){
      if(!historicalAudio.has(audio.file))historicalAudio.set(audio.file,/^[a-f0-9-]+\.(wav|mp3|m4a|webm|ogg)$/.test(audio.file)&&Boolean(await stat(path.join(this.store.root,'audio',audio.file)).catch(()=>null)));
      if(!historicalAudio.get(audio.file))audio.deleted=true;
    }
    if(archive.documents.classroom?.audio?.deleted)archive.documents.classroom.audio=null;
    for(const [key,doc]of Object.entries(archive.documents))if(doc&&(['workspace','classroom'].includes(key)||key.startsWith('feedback-class-')))await this.store.restoreDamaged(key,doc);
    const merge=(current,old)=>{const identity=x=>x.id??'version:'+x.version,ids=new Set(current.map(identity));return [...old.filter(x=>!ids.has(identity(x))),...current];};
    for(const [key,doc]of Object.entries(archive.documents))if(managed.test(key)&&doc)await this.store.update(key,undefined,{revision:0},c=>Object.keys(c).length>1?c:doc,{skipUnchanged:true});
    if(archive.documents.workspace)await this.store.update('workspace',undefined,{revision:0,resources:[],messages:[]},c=>{
      const old=archive.documents.workspace;for(const r of c.resources){const previous=old.resources.find(x=>x.id===r.id);if(previous)r.versions=merge(r.versions,previous.versions);}
      const ids=new Set(c.resources.map(r=>r.id));c.resources=[...c.resources,...old.resources.filter(r=>!ids.has(r.id))];
      c.materials||=[];for(const material of old.materials||[])if(!c.materials.some(m=>m.id===material.id||m.title===material.title&&m.content===material.content&&m.type===material.type))c.materials.push(material);
      if(c.resources.length>60||c.materials.length>20||c.materials.reduce((n,m)=>n+(m.content?.length||0),0)>500000)throw new AppError('补回后超过资料或资源容量，请先清理当前不需要的内容；归档仍保留。',413);
      if(!c.selectedId)c.selectedId=c.resources.some(r=>r.id===old.selectedId)?old.selectedId:c.resources[0]?.id||null;
      c.messages=merge(c.messages,old.messages);return c;
    },{skipUnchanged:true});
    if(archive.documents.classroom)await this.store.update('classroom',undefined,{revision:0,transcriptVersions:[],reports:[],jobs:[],conversation:[]},c=>{
      const old=archive.documents.classroom;c.transcriptVersions=merge(c.transcriptVersions,old.transcriptVersions);c.reports=merge(c.reports,old.reports.map(r=>({...r,stale:r.stale||r.transcriptId!==c.currentTranscriptId||r.courseVersion!==c.courseVersion||Boolean(c.transcriptVersions.find(t=>t.id===r.transcriptId)?.audio?.deleted)})));
      for(const r of c.reports){const previous=old.reports.find(x=>x.id===r.id);if(previous)r.history=merge(r.history||[],previous.history||[]);}
      c.jobs=merge(c.jobs,old.jobs);c.conversation=merge(c.conversation||[],old.conversation||[]);return c;
    },{skipUnchanged:true});
    for(const [key,old]of Object.entries(archive.documents))if(key.startsWith('feedback-class-'))await this.store.update(key,undefined,{revision:0},c=>{
      if(!c.id||c.deleted)return c;
      c.reports=merge(c.reports,old.reports.map(r=>{const v=archive.documents['feedback-input-'+r.inputId]?.versions;return {...r,stale:r.stale||!v||v.data!==c.dataVersion||v.source!==c.sourceVersion||Boolean(c.source?.needsRefresh||c.ppt?.needsRefresh)};}));for(const report of c.reports){const previous=old.reports.find(r=>r.id===report.id);if(previous)report.history=merge(report.history||[],previous.history||[]);}
      c.messages=merge(c.messages,old.messages);c.jobIds=[...new Set([...(old.jobIds||[]),...(c.jobIds||[])])];return c;
    },{skipUnchanged:true});
    if(archive.documents['feedback-templates'])await this.store.update('feedback-templates',undefined,{revision:0,versions:[]},c=>({...c,versions:merge(c.versions,archive.documents['feedback-templates'].versions)}),{skipUnchanged:true});
    await this.store.update('storage-audio-pins',undefined,{revision:0,sources:{}},c=>({...c,complete:false}),{skipUnchanged:true});return {restored:true};
  }
}
