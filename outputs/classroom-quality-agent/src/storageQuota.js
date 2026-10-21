import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';

const meters=new Map();
const quotaRoots=new Map();
export function registerQuotaRoot(root,parent){root=path.resolve(root);parent=path.resolve(parent);if(root!==parent)quotaRoots.set(root,parent);}
const sharedRoot=root=>quotaRoots.get(path.resolve(root))||path.resolve(root);
export const quotaRoot=sharedRoot;
export const dataLimit=()=>{const n=Number(process.env.DATA_MAX_BYTES);return Number.isSafeInteger(n)&&n>0?n:5*1024**3;};
export async function diskUsage(root){
  let bytes=0,files=0;
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    if(entry.isSymbolicLink()||dir===root&&entry.name==='models')continue;
    const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){const s=await stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(s){bytes+=s.size;files++;}}
  }}
  await walk(root);return {bytes,files};
}
export function invalidateUsage(root){const meter=meters.get(sharedRoot(root));if(meter)meter.time=0;}
export async function reserveDisk(root,bytes,{delta=bytes}={}){
  root=sharedRoot(root);let meter=meters.get(root);
  if(!meter){meter={bytes:0,reserved:0,time:0,queue:Promise.resolve()};meters.set(root,meter);}
  const task=meter.queue.catch(()=>{}).then(async()=>{
    if(!meter.reserved&&Date.now()-meter.time>5000){meter.bytes=(await diskUsage(root)).bytes;meter.time=Date.now();}
    if(meter.bytes+meter.reserved+bytes>dataLimit()&&!(Number.isFinite(delta)&&delta<0)){const error=new Error('本地数据空间额度不足，请在设置中的“数据与恢复”归档或清理，或调整 DATA_MAX_BYTES。');error.statusCode=413;throw error;}
    meter.reserved+=bytes;let released=false;
    return delta=>{if(released)return;released=true;meter.reserved-=bytes;if(Number.isFinite(delta))meter.bytes=Math.max(0,meter.bytes+delta);else meter.time=0;};
  });meter.queue=task.then(()=>{},()=>{});
  if(meters.size>128)for(const [key,value]of meters)if(!value.reserved&&key!==root){meters.delete(key);break;}
  return task;
}
