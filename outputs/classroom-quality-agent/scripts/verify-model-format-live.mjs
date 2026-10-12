// Only constructed teaching content is sent; saved teacher prompts are not used.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ModelSettings} from '../src/modelSettings.js';
import {DEFAULT_PROMPTS} from '../src/prompts.js';
import {requestJSON} from '../src/model.js';
import {newAgentJob,runTeachingAgent,commitAgentDrafts} from '../src/agent.js';
import {emptyWorkspace,currentVersion} from '../src/workspace.js';
const root=new URL('..',import.meta.url).pathname;
process.loadEnvFile(root+'.env');
const saved=await new ModelSettings(root+'data').read();
const config={apiKey:saved.apiKey,baseUrl:saved.baseUrl,model:saved.model,timeoutMs:saved.timeoutMs,maxInputChars:saved.maxInputChars,maxTokens:5000,temperature:0,batchPages:2,maxAgentCalls:12,maxPlanSteps:6,maxRepairs:1,prompts:{...DEFAULT_PROMPTS}};
const state=emptyWorkspace();state.requirements={topic:'构造的区间翻转教学示例',audience:'本科',duration:20,instructions:'少量完整教学单元，讲解原理与核心函数，不出练习题。'};
const job=newAgentJob(state,'新建一份小课件，讲清区间翻转与懒标记。以序列树为例，说明交换左右子树、翻转标记以及标记下传的时机，提供C++17完整核心函数、必要定义、调用说明和预期输出。预计2个逻辑教学单元即可；不要整套平衡树课程，也不要习题。');
const responses=[];
const call=async(system,input,options)=>{
  let choice;
  const fetchModel=async(...args)=>{const response=await fetch(...args);if(response.ok)choice=(await response.clone().json()).choices?.[0];return response;};
  try{
    const result=await requestJSON(system,input,{...options,fetch:fetchModel});
    responses.push({phase:input.phase,action:result.action,finishReason:choice?.finish_reason,responseCharacters:choice?.message?.content?.length,containsFence:choice?.message?.content?.includes('```')});
    console.log(JSON.stringify(responses.at(-1)));return result;
  }catch(e){responses.push({phase:input.phase,error:e.message,code:e.code,details:e.details});throw e;}
};
let error;
try{
  const result=await runTeachingAgent(job,{config,call});assert.equal(result.action,'agent-commit');
  commitAgentDrafts(state,job);assert.equal(state.resources.length,1);
  const slides=currentVersion(state.resources[0]).content.slides;
  assert.ok(slides.some(s=>s.code&&s.code.kind!=='output'));assert.equal(job.review.passed,true);
  console.log(JSON.stringify({passed:true,calls:job.calls,logicalSteps:job.plan.steps.length,displayPages:slides.length}));
}catch(e){error={message:e.message,code:e.code};throw e;}
finally{
  await fs.mkdir(root+'artifacts/review',{recursive:true});const file=root+'artifacts/review/model-format-live.json';let history=[];
  try{const previous=JSON.parse(await fs.readFile(file,'utf8'));history=[...(previous.history||[]),{checkedAt:previous.checkedAt,passed:previous.passed,calls:previous.calls,error:previous.error}];}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(file,JSON.stringify({checkedAt:new Date().toISOString(),syntheticOnly:true,teacherDataUsed:false,teacherPromptsUsed:false,passed:!error,calls:job.calls,responses,error,history},null,2),{mode:0o600});
}
