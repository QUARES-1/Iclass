import { readdir, rm } from 'node:fs/promises';
import { Store, AppError, id, clone } from './store.js';
import { JinshujuClient } from '../../classroom-feedback-api/src/jinshuju.js';
import { defaultTemplate, validateTemplate, makeTemplateVersion, providerForm, mapProviderForm, normalizeProviderEntry, validateRecord, statistics, mergeRecords, digest, text, validId, LIMITS, sampleImport,feedbackTimestamp } from './feedbackDomain.js';

const now=()=>new Date().toISOString();
const safeError=e=>e instanceof AppError?e.message:'问卷服务请求失败'+(e.status?'（HTTP '+e.status+'）':'')+'，请检查连接、权限或额度后重试。';
const emptyConfig=()=>({revision:0,baseUrl:process.env.JINSHUJU_BASE_URL||'https://jinshuju.net/api/v1',accessToken:process.env.JINSHUJU_ACCESS_TOKEN||'',identity:null,connectionId:id()});
export class FeedbackService{
  constructor({store,settingsStore=store,lessonContext,modelSettings,modelCall,clientFactory=options=>new JinshujuClient(options),providerIntervalMs=Number(process.env.FEEDBACK_API_INTERVAL_MS??1000)}){
    Object.assign(this,{store,settingsStore,lessonContext,modelSettings,modelCall,clientFactory});this.runs=new Map();this.connectionQueue=[];this.connectionBusy=false;this.nextConnectionAt=0;this.providerIntervalMs=Number.isFinite(providerIntervalMs)&&providerIntervalMs>=0&&providerIntervalMs<=60000?providerIntervalMs:1000;
  }
  async templates(){
    const current=await this.settingsStore.read('feedback-templates',null);
    if(current)return current;
    const template=await defaultTemplate();
    return this.settingsStore.update('feedback-templates',undefined,{revision:0},c=>c.versions?c:{...c,versions:[makeTemplateVersion(template)]});
  }
  async saveTemplate(body){
    if(!Number.isSafeInteger(body.revision))throw new AppError('缺少模板版本。',400);
    const template=validateTemplate(body.template);
    return this.settingsStore.update('feedback-templates',body.revision,await this.templates(),c=>{if(digest(validateTemplate(c.versions.at(-1)))!==digest(template))c.versions.push(makeTemplateVersion(template));return c;},{skipUnchanged:true});
  }
  async list(){
    const files=await readdir(this.store.root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const out=[];
    for(const f of files.filter(n=>/^feedback-class-[a-f0-9-]{36}\.json$/.test(n))){
      const c=await this.store.read(f.slice(0,-5),null);
      if(c&&!c.deleted)out.push({id:c.id,title:c.title,date:c.date,revision:c.revision,ended:c.ended,publish:c.publish?.status||'draft',count:c.records.length,savedAt:c.savedAt,sampleKey:c.sampleKey});
    }
    return out.sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
  }
  async read(classId){if(!validId(classId))throw new AppError('课堂标识无效。',400);const c=await this.store.read('feedback-class-'+classId,null);if(!c||c.deleted)throw new AppError('课堂不存在或已删除。',404);return c;}
  async update(classId,revision,change){
    await this.read(classId);
    return this.store.update('feedback-class-'+classId,revision,null,c=>{if(!c||c.deleted)throw new AppError('课堂已删除。',404);return change(c);},{skipUnchanged:true});
  }
  async refreshReferences(classId){
    let c=await this.read(classId);
    if(this.lessonContext){
      const lesson=await this.lessonContext(),signature=digest({title:lesson.title,date:lesson.date,description:lesson.description,course:lesson.courseTitle,resources:lesson.resources,error:lesson.resourceError});
      if(c.lessonSignature!==signature)c=await this.update(classId,undefined,x=>{if(x.lessonSignature!==signature){x.title=lesson.title;x.date=lesson.date;x.description=lesson.description;x.courseTitle=lesson.courseTitle;x.teachingResources=lesson.resources;x.resourceError=lesson.resourceError||null;x.lessonSignature=signature;x.sourceVersion++;this.markStale(x);}return x;});
    }
    if(!c.source&&!c.ppt)return c;
    const [audio,workspace]=await Promise.all([c.source?this.store.read('classroom',null):null,c.ppt?this.store.read('workspace',null):null]);
    let transcriptId=c.source?.transcriptId;
    if(c.source){
      const versions=audio?.transcriptVersions||[],descendants=new Set([transcriptId]);
      for(const t of versions)if(descendants.has(t.parentId)){descendants.add(t.id);transcriptId=t.id;}
      if(!versions.some(t=>t.id===c.source.transcriptId))transcriptId=null;
    }
    const resource=workspace?.resources?.find(r=>r.id===c.ppt?.resourceId),pptVersion=resource?.currentVersionId||null;
    const audioChanged=Boolean(c.source&&transcriptId!==c.source.transcriptId),pptChanged=Boolean(c.ppt&&pptVersion!==c.ppt.versionId);
    if(!audioChanged&&!pptChanged&&!c.source?.needsRefresh&&!c.ppt?.needsRefresh)return c;
    if((!c.source||Boolean(c.source.needsRefresh)===audioChanged&&c.source.availableVersion===transcriptId)&&(!c.ppt||Boolean(c.ppt.needsRefresh)===pptChanged&&c.ppt.availableVersion===pptVersion))return c;
    return this.update(classId,undefined,x=>{
      if(x.source?.id!==c.source?.id||x.ppt?.versionId!==c.ppt?.versionId)return x;
      if(x.source){x.source.needsRefresh=audioChanged;x.source.availableVersion=transcriptId;}
      if(x.ppt){x.ppt.needsRefresh=pptChanged;x.ppt.availableVersion=pptVersion;}
      if(audioChanged||pptChanged){x.sourceVersion++;this.markStale(x);}return x;
    });
  }
  async create(body){
    const templates=await this.templates(),template=templates.versions.find(v=>v.id===body.templateId)||templates.versions.at(-1);
    const lesson=this.lessonContext?await this.lessonContext():null,classId=lesson?.id||id();
    return this.store.update('feedback-class-'+classId,undefined,{revision:0},current=>current.id?current:({
      id:classId,title:text(lesson?.title||body.title),date:text(lesson?.date||body.date||now().slice(0,10),50),description:lesson?.description||'',template:clone(template),ended:false,
      deadline:null,publish:{status:'draft'},records:[],dataVersion:0,sourceVersion:0,source:null,ppt:null,
      reports:[],currentReportId:null,suggestions:[],messages:[],conversationGeneration:0,activeJobId:null,revision:0
    }),{skipUnchanged:true});
  }
  public(c){
    const {records,source,...visible}=c;
    return {...visible,source:source?{...source}:null,stats:statistics(records,c.publish.template||c.template)};
  }
  async saveInput(inputId,input){
    const {template,records,stats,source,ppt,teachingResources,...context}=input;
    const material={template,records,stats,source,ppt,...(teachingResources?{teachingResources}:{})},materialId=digest(material);
    await this.store.update('feedback-material-'+materialId,undefined,{revision:0},c=>c.records?c:material,{skipUnchanged:true});
    if(context.report)delete context.report.history;
    await this.store.update('feedback-input-'+inputId,undefined,{revision:0},()=>({...context,materialId}));
  }
  async readInput(inputId){
    const input=await this.store.read('feedback-input-'+inputId,null);
    if(!input)throw new AppError('历史依据不存在。',404);
    if(!input.materialId)return input;
    const material=await this.store.read('feedback-material-'+input.materialId,null);
    if(!material)throw new AppError('历史资料不存在。',404);
    return {...material,...input};
  }
  async config(){return this.settingsStore.read('feedback-settings',emptyConfig());}
  publicConfig(c){const {accessToken,identity,...visible}=c;return {...visible,configured:typeof accessToken==='string'&&Boolean(accessToken.trim()),verified:Boolean(identity)};}
  validateConfig(current,body){
    const next={...current};
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['revision','baseUrl','accessToken','clearToken'].includes(k)))throw new AppError('问卷连接配置包含无效字段。');
    if(body.clearToken!==undefined&&typeof body.clearToken!=='boolean')throw new AppError('清除凭据参数无效。');

    if(body.baseUrl!==undefined){let url;try{url=new URL(body.baseUrl);}catch{throw new AppError('请输入完整的金数据 API 地址。');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new AppError('API 地址不能包含账号、查询参数或片段。');
      next.baseUrl=url.href.replace(/\/+$/,'');
    }
    if(body.accessToken!==undefined){if(typeof body.accessToken!=='string'||body.accessToken.length>4096||/[\x00-\x1f\x7f]/.test(body.accessToken))throw new AppError('访问凭据格式无效。');if(body.accessToken.trim())next.accessToken=body.accessToken.trim();}
    if(body.clearToken&&body.accessToken?.trim())throw new AppError('不能同时替换和清除凭据。');
    if(body.clearToken)next.accessToken='';
    if(next.accessToken!==current.accessToken||next.baseUrl!==current.baseUrl)next.identity=null;
    if(next.baseUrl!==current.baseUrl)next.connectionId=id();
    return next;
  }
  async saveConfig(body){
    if(!Number.isSafeInteger(body.revision))throw new AppError('缺少配置版本。',400);
    const saved=await this.settingsStore.update('feedback-settings',body.revision,await this.config(),c=>this.validateConfig(c,body));
    for(const entry of await this.list()){const c=await this.read(entry.id);if(c.ended&&['pending','failed'].includes(c.publish.status)&&!c.publish.token)this.launchPublish(c.id);}
    return this.publicConfig(saved);
  }
  async testConfig(body){
    const current=await this.config();if(body.revision!==current.revision)throw new AppError('配置已变化，请重新载入。',409);
    const config=this.validateConfig(current,body);if(!config.accessToken)throw new AppError('尚未配置金数据凭据。',503);
    try{await this.clientFactory(config).getMe();return {ok:true};}catch(e){throw new AppError(safeError(e),502);}
  }
  async client(signal,expected=null){
    const config=await this.config();if(!config.accessToken)throw new AppError('尚未配置金数据连接，请打开设置。',503);
    if(expected&&expected.baseUrl!==config.baseUrl)throw new AppError('连接地址已改变，请恢复原连接或核对问卷实例。',409);
    const raw=this.clientFactory({...config,signal});
    const client=new Proxy(raw,{get:(target,key)=>{const value=Reflect.get(target,key,target);return typeof value==='function'? (...args)=>this.connectionTask(()=>value.apply(target,args),key==='createForm'?2:key==='getMe'?1:0,signal):value;}});
    const profile=await client.getMe();
    const identity=digest({id:profile.id??profile.user?.id??null,email:profile.email??profile.user?.email??null,name:profile.name??profile.user?.name??null});
    if(expected?.identity&&expected.identity!==identity)throw new AppError('当前账户与问卷所属账户不同，未继续操作。',409);
    return {client,connection:{baseUrl:config.baseUrl,identity}};
  }
  launch(key,task,owner=null){
    if(this.runs.has(key))return false;
    const controller=new AbortController();
    const promise=Promise.resolve().then(()=>task(controller.signal)).catch(()=>{}).finally(()=>{if(this.runs.get(key)?.controller===controller)this.runs.delete(key);});
    this.runs.set(key,{controller,promise,owner});return true;
  }
  connectionTask(fn,priority=0,signal){
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new AppError('请求已取消。',499));return;}
      const entry={fn,priority,signal,resolve,reject};
      entry.cancel=()=>{const index=this.connectionQueue.indexOf(entry);if(index>=0){this.connectionQueue.splice(index,1);signal.removeEventListener('abort',entry.cancel);reject(new AppError('请求已取消。',499));}};
      signal?.addEventListener('abort',entry.cancel,{once:true});this.connectionQueue.push(entry);void this.drainConnections();
    });
  }
  async drainConnections(){
    if(this.connectionBusy)return;this.connectionBusy=true;
    try{while(this.connectionQueue.length){
      const delay=this.nextConnectionAt-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      this.connectionQueue.sort((a,b)=>b.priority-a.priority);const task=this.connectionQueue.shift();
      if(!task)continue;
      task.signal?.removeEventListener('abort',task.cancel);
      if(task.signal?.aborted){task.reject(new AppError('请求已取消。',499));continue;}
      this.nextConnectionAt=Date.now()+this.providerIntervalMs;
      try{task.resolve(await task.fn());}catch(e){task.reject(e);}
    }}finally{this.connectionBusy=false;}
  }
  markStale(c){for(const r of c.reports)r.stale=true;}
  async end(classId,revision){
    await this.update(classId,revision,c=>{
      if(c.sample)throw new AppError('本地样例课堂不发布到金数据，请新建正式课堂。');
      if(!c.ended){c.ended=true;c.endedAt=now();c.publish={status:'pending',template:clone(c.template),attemptId:id()};}
      return c;
    });
    this.launchPublish(classId);
    return this.read(classId);
  }
  launchPublish(classId){
    return this.launch('publish-'+classId,async signal=>{
      let sent=false,token=null;
      try{
        let c=await this.read(classId);
        if(!c.ended||['published','uncertain','mapping'].includes(c.publish.status)||c.publish.token)return;
        if(c.deadline&&Date.parse(c.deadline)<=Date.now())throw new AppError('截止时间已过，请调整后重试。');
        const {client,connection}=await this.client(signal,c.publish.connection);
        c=await this.update(classId,undefined,x=>{x.publish.status='publishing';x.publish.connection=connection;x.publish.error=null;return x;});
        const form=providerForm(c.publish.template,c,c.deadline);
        await this.update(classId,undefined,x=>{x.publish.requestSent=true;return x;});
        sent=true;
        const created=await client.createForm(form);token=created?.token;
        if(!validId(token)||typeof created.url!=='string')throw new AppError('创建响应缺少表单标识，请先核实远端是否已创建。',502);
        await this.assertUniqueForm(classId,token,connection);
        await this.update(classId,undefined,x=>{x.publish={...x.publish,status:'mapping',token,url:created.url,rawForm:created,createdAt:now()};return x;});
        await this.repairMapping(classId,created);
      }catch(e){
        await this.update(classId,undefined,c=>{
          c.publish.status=c.publish.token?'mapping':sent&&!([400,401,402,403,404,422,429].includes(e.status))?'uncertain':e.statusCode===503?'pending':'failed';
          c.publish.error=safeError(e);return c;
        }).catch(()=>{});
      }
    });
  }
  async assertUniqueForm(classId,token,connection){
    for(const entry of await this.list()){if(entry.id===classId)continue;const c=await this.read(entry.id);if(c.publish.token===token&&c.publish.connection?.baseUrl===connection.baseUrl)throw new AppError('该问卷已绑定另一课堂，不能重复绑定。',409);}
    const key=digest({baseUrl:connection.baseUrl,token});
    await this.store.update('feedback-form-bindings',undefined,{revision:0,claims:{}},registry=>{
      if(registry.claims[key]&&registry.claims[key]!==classId)throw new AppError('该问卷已绑定另一课堂，不能重复绑定。',409);
      registry.claims[key]=classId;return registry;
    },{skipUnchanged:true});
  }
  async repairMapping(classId,form=null){
    const before=await this.read(classId);
    if(!form){const {client}=await this.client(undefined,before.publish.connection);form=await client.getForm(before.publish.token);}
    const mapping=mapProviderForm(before.publish.template,form);
    return this.update(classId,undefined,c=>{if(c.publish.token!==form.token)throw new AppError('问卷实例已改变。',409);c.publish.mapping=mapping;c.publish.structure=digest(form.fields);c.publish.status='published';c.publish.error=null;delete c.publish.rawForm;return c;});
  }
  async bind(classId,revision,token){
    if(!validId(token))throw new AppError('表单 Token 无效。');
    const before=await this.read(classId);if(!before.ended)throw new AppError('请先标记课程结束。');
    if(before.revision!==revision)throw new AppError('课堂已变化，请重新载入后绑定。',409);
    if(this.runs.has('publish-'+classId))throw new AppError('问卷发布仍在处理，请等待结束后再核实绑定。',409);
    const {client,connection}=await this.client(undefined,before.publish.connection);
    const form=await client.getForm(token),mapping=mapProviderForm(before.publish.template,form);
    return this.update(classId,revision,async c=>{
      if(this.runs.has('publish-'+classId))throw new AppError('问卷发布仍在处理，请等待结束后再核实绑定。',409);
      if(c.publish.token&&c.publish.token!==token)throw new AppError('已有问卷不能直接替换。',409);
      await this.assertUniqueForm(classId,token,connection);
      c.publish={...c.publish,token,url:form.url,mapping,structure:digest(form.fields),status:'published',connection,error:null};return c;
    });
  }
  launchSync(classId){
    return this.launch('sync-'+classId,async signal=>{
      try{
        let c=await this.read(classId);if(c.publish.status!=='published')throw new AppError('问卷尚未发布或映射待修复。');
        const version=c.dataVersion,token=c.publish.token;
        await this.update(classId,undefined,x=>{x.sync={status:'syncing',startedAt:now()};return x;});
        const {client}=await this.client(signal,c.publish.connection);
        const form=await client.getForm(token);
        if(digest(form.fields)!==c.publish.structure)throw new AppError('远端题目结构已改变，原统计保留，请先核对模板。',409);
        const mapping=mapProviderForm(c.publish.template,form);
        let next,seen=new Set(),entries=[];
        for(let page=0;page<500;page++){
          if(signal.aborted)throw new AppError('同步已取消。');
          const cursor=JSON.stringify(next??null);if(seen.has(cursor))throw new AppError('分页游标重复，未提交不完整结果。');seen.add(cursor);
          const result=await client.listEntries(token,{next,limit:100});
          if(!Array.isArray(result?.data))throw new AppError('远端数据结构无效，原统计保留。');
          entries.push(...result.data);
          if(entries.length>LIMITS.records)throw new AppError('反馈超过单次处理限制，请提高配置或分批导入。');
          if(result.next===undefined||result.next===null)break;
          if(!result.data.length)throw new AppError('分页未完成但返回空页，未提交不完整结果。');
          if(page===499)throw new AppError('分页数量超出预算，未提交不完整结果。');
          next=result.next;
        }
        const latest=await client.getForm(token);if(digest(latest.fields)!==c.publish.structure)throw new AppError('同步期间远端模板发生变化，未更新统计。');
        const incoming=entries.map(e=>validateRecord(normalizeProviderEntry(e,mapping,c.publish),c.publish.template,c.deadline));
        await this.update(classId,undefined,x=>{
          if(x.dataVersion!==version||x.publish.token!==token)throw new AppError('同步期间反馈已被导入或编辑，请重新同步；新内容保留。',409);
          const merged=mergeRecords(x.records,incoming);
          if(merged.records.length>LIMITS.records)throw new AppError('本课堂反馈总数超过限制，原数据保留。',413);
          if(merged.added||merged.updated){x.records=merged.records;x.dataVersion++;this.markStale(x);}
          x.publish.mapping=mapping;
          x.sync={status:'complete',updatedAt:now(),...Object.fromEntries(['added','updated','skipped'].map(k=>[k,merged[k]]))};return x;
        });
      }catch(e){await this.update(classId,undefined,c=>{c.sync={...c.sync,status:'failed',error:safeError(e)};return c;}).catch(()=>{});}
    });
  }
  async previewImport(classId,body){
    await this.cleanupPreviews();
    const c=await this.read(classId),data=body.data;
    if(!data||typeof data!=='object')throw new AppError('请选择有效的 JSON 问卷结果。');
    if(Buffer.byteLength(JSON.stringify(data))>LIMITS.fileBytes)throw new AppError('文件超过 '+LIMITS.fileBytes+' 字节限制。',413);
    const items=Array.isArray(data)?data:data?.records;
    if(!Array.isArray(items)||items.length>LIMITS.records||!items.length)throw new AppError('须导入非空 records 数组，最多 '+LIMITS.records+' 条。');
    if(data.classId&&data.classId!==classId)throw new AppError('文件属于其他课堂。');
    if(data.template&&digest(validateTemplate(data.template))!==digest(validateTemplate(c.publish.template||c.template)))throw new AppError('文件模板与当前问卷不一致。');
    const accepted=[],errors=[];
    items.forEach((r,i)=>{
      try{
        if(r?.source==='sample'&&!c.sample||c.sample&&r?.source!=='sample')throw new AppError('样例与正式反馈分开保存，请选择对应课堂。');
        if(r?.instanceToken&&r.instanceToken!==c.publish.token)throw new AppError('反馈属于其他在线问卷。');
        // The documented import field is answers. An old exported rawAnswers
        // snapshot must not override a teacher's corrections on later revalidation.
        const normalized=validateRecord({...r,rawAnswers:undefined},c.publish.template||c.template,c.deadline);
        if(normalized.errors.length)throw new AppError(normalized.errors.join('；'));
        accepted.push(normalized);
      }catch(e){errors.push({row:i+1,error:safeError(e)});}
    });
    const contents={classId,dataVersion:c.dataVersion,templateHash:digest(c.publish.template||c.template),deadline:c.deadline,accepted,errors};
    // Identical previews within an hour reuse one file. Including the hour
    // prevents a new request from renewing a file being swept as expired.
    const preview={id:digest({...contents,hour:Math.floor(Date.now()/3600000)}),...contents,createdAt:now()};
    await this.store.update('feedback-import-'+preview.id,undefined,{revision:0},saved=>saved.createdAt?saved:preview,{skipUnchanged:true});
    const merged=mergeRecords(c.records,accepted);
    return {id:preview.id,total:items.length,valid:accepted.length,errors,...Object.fromEntries(['added','updated','skipped'].map(k=>[k,merged[k]]))};
  }
  async commitImport(classId,revision,previewId,validOnly){
    if(!validId(previewId))throw new AppError('导入预览不存在。');
    const p=await this.store.read('feedback-import-'+previewId,null);
    if(!p||p.classId!==classId||Date.now()-Date.parse(p.createdAt)>3600000)throw new AppError('预览已失效，请重新选择文件。');
    if(p.errors.length&&!validOnly)throw new AppError('存在错误项，请明确选择仅导入有效记录。');
    return this.update(classId,revision,c=>{
      if(c.dataVersion!==p.dataVersion||digest(c.publish.template||c.template)!==p.templateHash||p.deadline!==undefined&&c.deadline!==p.deadline)throw new AppError('预览后反馈、模板或截止时间发生变化，请重新预览。',409);
      const merged=mergeRecords(c.records,p.accepted);
      if(merged.records.length>LIMITS.records)throw new AppError('本课堂反馈总数超过 '+LIMITS.records+' 条限制。',413);
      if(merged.added||merged.updated){c.records=merged.records;c.dataVersion++;this.markStale(c);}
      c.lastImport={added:merged.added,updated:merged.updated,skipped:merged.skipped,rejected:p.errors.length};return c;
    });
  }
  async cleanupPreviews(){
    if(this.previewCleanup)return this.previewCleanup;
    if(this.previewCleanupAt&&Date.now()-this.previewCleanupAt<60000)return;
    this.previewCleanup=(async()=>{
      const files=await readdir(this.store.root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
      for(const name of files.filter(f=>/^feedback-import-[a-f0-9-]+\.json$/.test(f))){
        const p=await this.store.read(name.slice(0,-5),null);
        if(p&&Date.now()-Date.parse(p.createdAt)>3600000)await this.store.remove(name.slice(0,-5));
      }
      this.previewCleanupAt=Date.now();
    })();
    try{await this.previewCleanup;}finally{this.previewCleanup=null;}
  }
  async sampleClasses(){
    if(this.sampleLoad)return this.sampleLoad;
    this.sampleLoad=this.loadSampleClasses();
    try{return await this.sampleLoad;}finally{this.sampleLoad=null;}
  }
  async loadSampleClasses(){
    const {template,groups}=await sampleImport();
    const templates=await this.templates();
    const existingTemplate=templates.versions.find(v=>digest(validateTemplate(v))===digest(validateTemplate(template)));
    const saved=existingTemplate?templates:await this.saveTemplate({revision:templates.revision,template});
    const out=[];
    for(const [name,records] of Object.entries(groups)){
      const existing=(await this.list()).find(c=>c.sampleKey===name);
      if(existing){out.push(existing);continue;}
      const created=await this.create({title:'本地示例 · '+name,templateId:existingTemplate?.id||saved.versions.at(-1).id});
      await this.update(created.id,undefined,c=>{c.records=records.map(r=>validateRecord(r,c.template));c.dataVersion=1;c.sample=true;c.sampleKey=name;return c;});out.push({id:created.id});
    }
    return out;
  }
  async command(classId,body){
    const {action,revision}=body;
    if(!Number.isSafeInteger(revision))throw new AppError('缺少课堂版本，请重新载入。',400);
    if(action==='end')return this.end(classId,revision);
    if(action==='publish'){await this.update(classId,revision,c=>c);this.launchPublish(classId);return this.read(classId);}
    if(action==='sync'){await this.update(classId,revision,c=>{c.sync={...c.sync,status:'syncing',startedAt:now()};return c;});this.launchSync(classId);return this.read(classId);}
    if(action==='bind')return this.bind(classId,revision,body.token);
    if(action==='repair'){await this.read(classId);return this.repairMapping(classId);}
    const entityRevision=action==='report'&&Number.isSafeInteger(body.baseVersion)||action==='suggestions'&&Number.isSafeInteger(body.baseSuggestionVersion);
    return this.update(classId,entityRevision?undefined:revision,async c=>{
      if(action==='update'){
        const next={title:text(body.title??c.title),description:text(body.description??c.description,8000,false),date:text(body.date??c.date,50)};
        if(body.deadline!==undefined){if(body.deadline!==null&&!Number.isFinite(feedbackTimestamp(body.deadline)))throw new AppError('截止时间须为真实日期，包含秒和时区。');
          if(c.publish.token&&body.deadline!==c.deadline)throw new AppError('已发布问卷的截止时间请在金数据中核对，不能只改本地显示。');
          if(body.deadline!==c.deadline&&c.records.length){c.records=c.records.map(r=>validateRecord({...r,answers:r.rawAnswers||r.answers},c.publish.template||c.template,body.deadline));c.dataVersion++;this.markStale(c);}
          c.deadline=body.deadline;
        }
        if(body.templateId&&body.templateId!==c.template.id){if(c.ended||c.records.length)throw new AppError('课程已结束或已有反馈，不能替换其模板。');const t=(await this.templates()).versions.find(v=>v.id===body.templateId);if(!t)throw new AppError('模板不存在。');c.template=clone(t);}
        if(digest(next)!==digest({title:c.title,description:c.description,date:c.date})){Object.assign(c,next);c.sourceVersion++;this.markStale(c);}
      }else if(action==='exclude'){
        const r=c.records.find(r=>r.id===body.recordId);if(!r)throw new AppError('反馈不存在。');const excluded=body.excluded===true,reason=text(body.reason||'',1000,false);if(r.excluded===excluded&&(r.reason||'')===reason)return c;r.excluded=excluded;r.reason=reason;c.dataVersion++;this.markStale(c);
      }else if(action==='clearConversation'){c.messages=[];c.conversationGeneration++;}
      else if(action==='delete'){c.deleted=true;c.deletedAt=now();for(const key of ['publish-','sync-','agent-'])this.runs.get(key+classId)?.controller.abort();for(const run of this.runs.values())if(run.owner===classId)run.controller.abort();c.records=[];c.messages=[];c.source=null;c.reports=[];c.suggestions=[];}
      else if(action==='selectReport'){if(!c.reports.some(r=>r.id===body.reportId))throw new AppError('报告不存在。');c.currentReportId=body.reportId;}
      else if(action==='report'){
        const r=c.reports.find(r=>r.id===body.reportId);if(!r)throw new AppError('报告不存在。');
        if(body.baseVersion!==r.version)throw new AppError('报告已修改，当前输入保留，请重新载入。',409);
        if(body.confirm){if(r.stale)throw new AppError('报告已过期，不能确认为最新。');r.confirmed=true;}
        else{const next=text(body.text,60000);if(r.text!==next){r.history||=[];r.history.push({version:r.version,text:r.text,createdAt:now()});r.text=next;r.version++;r.confirmed=false;}}c.currentReportId=r.id;
      }else if(action==='restoreReport'){
        const r=c.reports.find(r=>r.id===body.reportId),h=r?.history?.find(h=>h.version===body.version);if(!h)throw new AppError('历史版本不存在。');if(r.text!==h.text){r.history.push({version:r.version,text:r.text,createdAt:now()});r.text=h.text;r.version++;r.confirmed=false;}
      }else if(action==='suggestions'){
        if(body.baseSuggestionVersion!==undefined&&body.baseSuggestionVersion!==(c.suggestionVersion||0))throw new AppError('建议已被更新，当前输入保留，请核对最新版本后再保存。',409);
        if(!Array.isArray(body.suggestions)||body.suggestions.length>200)throw new AppError('建议格式无效或超过200条限制。');
        const ids=new Set(),next=body.suggestions.map(s=>{
          if(!s||typeof s!=='object'||Array.isArray(s)||s.id!==undefined&&!validId(s.id))throw new AppError('建议须为对象，标识须合法。');
          const key=s.id||id();if(ids.has(key))throw new AppError('建议标识不能重复。');ids.add(key);
          if(s.evidenceIds!==undefined&&(!Array.isArray(s.evidenceIds)||s.evidenceIds.some(v=>typeof v!=='string')))throw new AppError('建议引用须为标识数组。');
          return {id:key,text:text(s.text,12000),evidenceIds:s.evidenceIds||[]};
        });
        if(digest(next)===digest(c.suggestions.map(({id,text,evidenceIds})=>({id,text,evidenceIds}))))return c;
        c.suggestionHistory||=[];c.suggestionHistory.push({version:c.suggestionVersion||0,items:clone(c.suggestions)});c.suggestions=next;c.suggestionVersion=(c.suggestionVersion||0)+1;
      }
      else if(action==='restoreSuggestions'){const h=c.suggestionHistory?.find(h=>h.version===body.version);if(!h)throw new AppError('建议历史不存在。');const items=clone(h.items);if(digest(items)===digest(c.suggestions))return c;c.suggestionHistory.push({version:c.suggestionVersion||0,items:clone(c.suggestions)});c.suggestions=items;c.suggestionVersion=(c.suggestionVersion||0)+1;}
      else if(action==='linkAudio'){
        const source=await this.store.read('classroom',null),t=source?.transcriptVersions?.find(t=>t.id===body.transcriptId);
        if(!t)throw new AppError('转写版本不存在。');
        const fields=['audioId','course','transcript','audio','report'],payload={audioId:t.audioId,course:clone(source.course),transcript:clone(t),audio:clone(t.audio||(source.audio?.id===t.audioId?source.audio:null)),report:clone(source.reports.find(r=>r.id===body.reportId)||null)};
        const previous=c.source?await this.store.read('feedback-source-'+c.source.id,null):null;
        if(previous&&digest(Object.fromEntries(fields.map(key=>[key,previous[key]])))===digest(payload))return c;
        const snapshot={id:id(),...payload};
        await this.store.update('feedback-source-'+snapshot.id,undefined,{revision:0},()=>snapshot);
        await this.store.update('storage-audio-pins',undefined,{revision:0,sources:{}},index=>{if(snapshot.audio&&!snapshot.audio.deleted)index.sources[snapshot.id]=[snapshot.audio.file,snapshot.audio.playbackFile].filter(Boolean);return index;},{skipUnchanged:true});
        c.source={id:snapshot.id,audioId:t.audioId,transcriptId:t.id};c.sourceVersion++;this.markStale(c);
      }else if(action==='unlinkAudio'){c.sourceOptOut=true;if(!c.source)return c;c.source=null;c.sourceVersion++;this.markStale(c);}
      else if(action==='linkPpt'){
        const w=await this.store.read('workspace',null),r=w?.resources.find(r=>r.id===body.resourceId&&r.type==='ppt'),v=r?.versions.find(v=>v.id===(body.versionId||r.currentVersionId));
        if(!v)throw new AppError('课件版本不存在。');const next={resourceId:r.id,versionId:v.id,name:r.name,content:clone(v.content)};if(c.ppt&&digest(Object.fromEntries(Object.keys(next).map(key=>[key,c.ppt[key]])))===digest(next))return c;c.ppt=next;c.sourceVersion++;this.markStale(c);
      }else if(action==='unlinkPpt'){if(!c.ppt)return c;c.ppt=null;c.sourceVersion++;this.markStale(c);}
      else throw new AppError('未知课堂操作。',400);
      return c;
    });
  }
  async handoff(classId,body){
    const c=await this.read(classId);if(body.revision!==c.revision)throw new AppError('建议已变化，请重新载入。',409);
    if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>200||body.ids.some(key=>!validId(key))||new Set(body.ids).size!==body.ids.length)throw new AppError('请选择不重复的建议标识。');
    const suggestions=c.suggestions.filter(s=>body.ids?.includes(s.id));if(!suggestions.length)throw new AppError('请至少选择一条建议。');
    if(suggestions.length!==body.ids.length)throw new AppError('所选建议已不存在，请重新核对选择。');
    const key=digest({classId,title:c.title,dataVersion:c.dataVersion,sourceVersion:c.sourceVersion,version:c.suggestionVersion,suggestions,description:c.description,reportId:c.currentReportId,reportVersion:c.reports.find(r=>r.id===c.currentReportId)?.version,target:c.ppt?{id:c.ppt.resourceId,version:c.ppt.versionId}:null});
    const existing=await this.store.read('feedback-handoff-'+key,null);
    if(existing)return existing;
    const report=c.reports.find(r=>r.id===c.currentReportId);
    const result={id:key,classId,title:c.title,reportId:report?.id||null,reportVersion:report?.version||null,suggestions,versions:{data:c.dataVersion,source:c.sourceVersion,suggestions:c.suggestionVersion||0},request:'请根据以下课后反馈建议调整下一节课 PPT：\n'+suggestions.map((s,i)=>(i+1)+'. '+s.text).join('\n')+'\n教学目标：'+c.description,target:c.ppt?{resourceId:c.ppt.resourceId,versionId:c.ppt.versionId,name:c.ppt.name}:null,createdAt:now(),url:'/public/index.html?feedback='+key};
    await this.store.update('feedback-handoff-'+key,undefined,{revision:0},()=>result);return result;
  }
  async getHandoff(key){
    if(!/^[a-f0-9]{64}$/.test(key))throw new AppError('建议交接不存在。',404);
    const h=await this.store.read('feedback-handoff-'+key,null);if(!h)throw new AppError('建议交接不存在。',404);
    const c=await this.read(h.classId);
    const workspace=h.target?await this.store.read('workspace',null):null,target=workspace?.resources?.find(r=>r.id===h.target.resourceId);
    return {...h,targetStatus:!h.target?null:!target?'missing':target.currentVersionId!==h.target.versionId?'changed':'current',stale:Boolean(h.reportId&&!c.reports.some(r=>r.id===h.reportId&&r.version===h.reportVersion&&!r.stale))||Boolean(h.versions&&(h.versions.data!==c.dataVersion||h.versions.source!==c.sourceVersion||h.versions.suggestions!==(c.suggestionVersion||0)))};
  }
  async recover(){
    for(const entry of await this.list()){
      const c=await this.read(entry.id);
      if(c.publish.status==='publishing')await this.update(c.id,undefined,x=>{x.publish.status=x.publish.requestSent?'uncertain':'pending';x.publish.error='服务重启，请核实发布状态。';return x;});
      if(c.sync?.status==='syncing')await this.update(c.id,undefined,x=>{x.sync.status='failed';x.sync.error='服务重启，原统计保留，可重新同步。';return x;});
      for(const jobId of new Set([...(c.jobIds||[]),c.activeJobId,c.writerJobId].filter(Boolean))){
        const job=await this.store.read('feedback-job-'+jobId,null);
        if(job&&!['completed','failed','paused','cancelled'].includes(job.status))await this.store.update('feedback-job-'+job.id,undefined,job,x=>({...x,status:'paused',error:'服务重启，可从已保存内容继续。'}));
      }
      if(c.writerJobId)await this.update(c.id,undefined,x=>{x.writerJobId=null;return x;});
      if(c.ended&&c.publish.status==='pending'&&!c.publish.requestSent)this.launchPublish(c.id);
    }
  }
  async reportMarkdown(classId,reportId,version){
    const c=await this.read(classId),r=c.reports.find(r=>r.id===reportId);
    if(!r||r.version!==Number(version))throw new AppError('报告版本已变化，请重试导出。',409);
    return '# '+c.title+'\n\n'+(r.stale?'历史草稿 · 输入已变化\n\n':r.confirmed?'教师已确认\n\n':'待教师确认\n\n')+r.text;
  }
}
