// Opt-in real-provider verification setup. Uses only synthetic course content and
// default prompts in an isolated data directory. Never prints credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelSettings} from '../src/modelSettings.js';
import {DEFAULT_PROMPTS} from '../src/prompts.js';
import {Store} from '../src/store.js';

const root=fileURLToPath(new URL('..',import.meta.url));
try{process.loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const out=path.join(root,'artifacts','sprint3-real'),dataDir=path.join(out,'data');
const teacherDir=process.env.DATA_DIR||path.join(root,'data');
await fs.mkdir(dataDir,{recursive:true});
const config=await new ModelSettings(teacherDir).read();
const feedback=await new Store(teacherDir).read('feedback-settings',{revision:0,baseUrl:process.env.JINSHUJU_BASE_URL||'https://jinshuju.net/api/v1',accessToken:process.env.JINSHUJU_ACCESS_TOKEN||''});
if(!config.apiKey||!feedback.accessToken)throw new Error('需要已保存的模型与问卷凭据。');
const exists=await fs.stat(path.join(dataDir,'model-settings.json')).then(()=>true,()=>false);
const refresh=process.argv.includes('--refresh-credentials');
if(!exists||refresh){
  await fs.writeFile(path.join(dataDir,'model-settings.json'),JSON.stringify({...config,revision:1,prompts:DEFAULT_PROMPTS}),{mode:0o600});
  await fs.writeFile(path.join(dataDir,'feedback-settings.json'),JSON.stringify({...feedback,revision:1}),{mode:0o600});
}
console.log(JSON.stringify({prepared:true,dataDir,defaultPrompts:true,isolated:true,existing:exists,credentialsRefreshed:refresh}));
