import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=new URL('..',import.meta.url).pathname;
try { process.loadEnvFile(path.join(root,'.env')); } catch(error) { if(error.code!=='ENOENT') throw error; }
const exec=(cmd,args)=>{try{return execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '未读取';}};
async function files(dir){let result=[];for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='__pycache__')result.push(...await files(p));}else result.push(p);}return result;}
const manifest={};for(const file of [...await files('src'),...await files('public'),...await files('speech'),'server.js','package.json','package-lock.json'])manifest[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
const report={recordedAt:new Date().toISOString(),version:JSON.parse(await fs.readFile(path.join(root,'package.json'))).version,baselineCommit:exec('git',['rev-parse','HEAD']),os:exec('sw_vers',[]),architecture:os.arch(),cpu:exec('sysctl',['-n','machdep.cpu.brand_string']),physicalCores:exec('sysctl',['-n','hw.physicalcpu']),memoryBytes:os.totalmem(),node:process.version,python:exec(path.join(root,'.venv/bin/python'),['--version']),browser:exec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--version']),inferenceDevice:'cpu',computeType:'int8',model:'Systran/faster-whisper-small',textModelConfigured:Boolean(process.env.LLM_API_KEY),fileSha256:manifest};
await fs.mkdir(path.join(root,'docs'),{recursive:true});await fs.writeFile(path.join(root,'docs/environment.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,fileSha256:undefined},null,2));
