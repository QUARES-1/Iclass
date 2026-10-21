import { mkdir, readFile, writeFile, rename, rm, stat,copyFile,chmod } from 'node:fs/promises';
import {constants} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {reserveDisk,invalidateUsage} from './storageQuota.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, statusCode = 422) { super(message); this.statusCode = statusCode; }
}
export const id = () => randomUUID();
export const clone = value => structuredClone(value);
const queues=new Map();
const recoveryMaps=new Map();
const validRecord=value=>value&&typeof value==='object'&&!Array.isArray(value)&&(value.revision==null||Number.isSafeInteger(value.revision)&&value.revision>=0);

// Serializes read-modify-write per document. Revision checks also cover concurrent tabs.
export class Store {
  constructor(root) { this.root = path.resolve(root); this.queues = new Map();this.cache=new Map();this.cacheBytes=0;if(!recoveryMaps.has(this.root))recoveryMaps.set(this.root,new Map());this.recoveries=recoveryMaps.get(this.root);if(recoveryMaps.size>128)recoveryMaps.delete(recoveryMaps.keys().next().value); }
  file(key) {
    if (!/^[a-z0-9-]+$/i.test(key)) throw new AppError('无效记录 ID。', 400);
    return path.join(this.root, key + '.json');
  }
  async read(key, fallback) {
    try{return clone(await this._read(key,fallback));}
    catch(error){if(!(error instanceof SyntaxError)&&error.code!=='ENOENT'&&error.code!=='INVALID_RECORD')throw error;return this._serial(key,()=>this._recover(key,fallback));}
  }
  async revision(key,fallback){try{return (await this._read(key,fallback))?.revision??0;}catch{return (await this.read(key,fallback))?.revision??0;}}
  async _read(key,fallback){
    const file=this.file(key),info=await stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!info){if(await stat(this.backup(key)).catch(()=>null))throw Object.assign(new Error('记录丢失'),{code:'ENOENT'});return clone(fallback);}
    if(info.size>100*1024**2)throw new AppError('记录超过 100 MB，无法载入；请从备份恢复或归档历史。',413);
    const stamp=info.ino+':'+info.size+':'+info.mtimeMs+':'+info.ctimeMs,cached=this.cache.get(key);
    if(cached?.stamp===stamp){this.cache.delete(key);this.cache.set(key,cached);return cached.value;}
    const text=await readFile(file,'utf8'),value=JSON.parse(text);
    if(!validRecord(value))throw Object.assign(new Error('记录结构损坏。'),{code:'INVALID_RECORD'});
    value.revision??=0;this._cache(key,stamp,value,info.size);return value;
  }
  _cache(key,stamp,value,bytes){
    const previous=this.cache.get(key);if(previous)this.cacheBytes-=previous.bytes;this.cache.delete(key);
    if(bytes>2*1024**2)return;
    this.cache.set(key,{stamp,value,bytes});this.cacheBytes+=bytes;
    while(this.cacheBytes>16*1024**2||this.cache.size>32){const [old,entry]=this.cache.entries().next().value;this.cache.delete(old);this.cacheBytes-=entry.bytes;}
  }
  backup(key){this.file(key);return path.join(this.root,'.recovery',key+'.json');}
  async _atomic(file,text){
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+id()+'.tmp';
    try{await writeFile(temp,text,{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}
  }
  _serial(key,run){
    const name=this.file(key),previous=queues.get(name)||Promise.resolve(),task=previous.catch(()=>{}).then(run);
    queues.set(name,task);this.queues.set(key,task);
    task.finally(()=>{if(queues.get(name)===task)queues.delete(name);if(this.queues.get(key)===task)this.queues.delete(key);}).catch(()=>{});return task;
  }
  async _recover(key,fallback){
    try{return clone(await this._read(key,fallback));}catch(error){
      let value;try{value=JSON.parse(await readFile(this.backup(key),'utf8'));if(!validRecord(value))throw new Error('备份结构损坏');}
      catch(backupError){throw new AppError('本地记录损坏且没有有效恢复副本，请保留数据目录并从历史归档恢复。',503);}
      const damaged=path.join(this.root,'.recovery',key+'.damaged');
      await rename(this.file(key),damaged).catch(e=>{if(e.code!=='ENOENT')throw e;});
      value.revision=(value.revision??0)+2;value.savedAt=new Date().toISOString();await this._atomic(this.file(key),JSON.stringify(value));
      this.cache.delete(key);this.cacheBytes=[...this.cache.values()].reduce((n,c)=>n+c.bytes,0);invalidateUsage(this.root);
      this.recoveries.set(key,{key,time:new Date().toISOString(),message:'检测到记录损坏，已恢复上一份有效保存；损坏文件已保留。'});return value;
    }
  }
  async update(key, revision, fallback, change, { skipUnchanged = false,reclaimBytes=0 } = {}) {
    return this._serial(key,async()=>{
      let current;try{current=await this._read(key,fallback);}catch(error){if(!(error instanceof SyntaxError)&&error.code!=='ENOENT'&&error.code!=='INVALID_RECORD')throw error;current=await this._recover(key,fallback);}
      if (revision !== undefined && revision !== current.revision) throw new AppError('内容已在其他操作中更新，请刷新后重试；本次未覆盖任何成果。', 409);
      const next = await change(clone(current));
      if (skipUnchanged && isDeepStrictEqual(next,current)) return clone(current);
      next.revision = (current?.revision??0) + 1;
      next.savedAt = new Date().toISOString();
      const text=JSON.stringify(next),bytes=Buffer.byteLength(text);
      if(bytes>100*1024**2)throw new AppError('保存记录超过 100 MB，请先在设置中归档历史。',413);
      const old=await stat(this.file(key)).catch(()=>null),backup=await stat(this.backup(key)).catch(()=>null);
      const release=await reserveDisk(this.root,bytes+(old?.size||bytes),{delta:bytes-(backup?.size||0)+(old?0:bytes)-reclaimBytes});
      try{
        if(old){const backupFile=this.backup(key),temp=backupFile+'.'+id()+'.tmp';await mkdir(path.dirname(backupFile),{recursive:true,mode:0o700});try{await copyFile(this.file(key),temp,constants.COPYFILE_FICLONE);await chmod(temp,0o600);await rename(temp,backupFile);}finally{await rm(temp,{force:true});}}
        else await this._atomic(this.backup(key),text);
        await this._atomic(this.file(key),text);this.cache.delete(key);this.cacheBytes=[...this.cache.values()].reduce((n,c)=>n+c.bytes,0);
        release(bytes-(backup?.size||0)+(old?0:bytes));
      }catch(error){if(!old)await rm(this.backup(key),{force:true});release();throw error;}
      return next;
    });
  }
  async remove(key){return this._serial(key,async()=>{await rm(this.file(key),{force:true});await rm(this.backup(key),{force:true});this.cache.delete(key);this.cacheBytes=[...this.cache.values()].reduce((n,c)=>n+c.bytes,0);invalidateUsage(this.root);});}
  async checkpoint(key){return this._serial(key,async()=>{
    const value=await this._read(key,null);if(!value)return;const text=JSON.stringify(value),bytes=Buffer.byteLength(text),old=await stat(this.backup(key)).catch(()=>null),release=await reserveDisk(this.root,bytes,{delta:bytes-(old?.size||0)});
    try{await this._atomic(this.backup(key),text);release(bytes-(old?.size||0));}catch(error){release();throw error;}
  });}
  async restoreDamaged(key,value){return this._serial(key,async()=>{
    try{if(await this._read(key,null))return false;}catch(error){if(!(error instanceof SyntaxError)&&!['INVALID_RECORD','ENOENT'].includes(error.code)&&error.statusCode!==413)throw error;}
    if(!validRecord(value))throw new AppError('归档记录无效，未执行恢复。',422);
    const next={...clone(value),revision:Math.max(Date.now(),(value.revision??0)+1),savedAt:new Date().toISOString()},text=JSON.stringify(next),bytes=Buffer.byteLength(text),release=await reserveDisk(this.root,bytes*2);
    try{await copyFile(this.file(key),path.join(this.root,'.recovery',key+'.damaged'),constants.COPYFILE_FICLONE).catch(e=>{if(e.code!=='ENOENT')throw e;});await this._atomic(this.file(key),text);await this._atomic(this.backup(key),text);release();this.cache.delete(key);this.cacheBytes=[...this.cache.values()].reduce((n,c)=>n+c.bytes,0);return true;}catch(error){release();throw error;}
  });}
}
