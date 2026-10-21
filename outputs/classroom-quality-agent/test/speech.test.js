import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import {speechCommand} from '../src/speech.js';
import {pythonExecutable,pythonEnvironment} from '../src/python.js';

async function workerFixture(source,run){
  const root=await mkdtemp(path.join(os.tmpdir(),'speech-events-')),previous=process.env.PYTHON_BIN;
  await mkdir(path.join(root,'speech'));await writeFile(path.join(root,'speech/worker.py'),source);process.env.PYTHON_BIN=process.execPath;
  try{await run(root);}finally{if(previous===undefined)delete process.env.PYTHON_BIN;else process.env.PYTHON_BIN=previous;await rm(root,{recursive:true,force:true});}
}
test('语音进程连续四千条事件逐条写入，保持顺序且不堆积异步进度任务',async()=>{
  await workerFixture(`for(let i=0;i<4000;i++)process.stdout.write(JSON.stringify({stage:'chunk-complete',index:i})+'\\n');process.stdout.write(JSON.stringify({result:{text:'课堂语音😀'}})+'\\n');`,async root=>{
    let active=0,peak=0,count=0;
    const result=await speechCommand(root,'probe','unused',async event=>{active++;peak=Math.max(active,peak);await new Promise(r=>setImmediate(r));if(event.index!==undefined)assert.equal(event.index,count++);active--;});
    assert.equal(count,4000);assert.equal(peak,1);assert.equal(active,0);assert.equal(result.text,'课堂语音😀');
  });
});
test('语音事件保存失败向上传递，不能吞掉同步回调异常并报告完成',async()=>{
  await workerFixture(`console.log(JSON.stringify({stage:'processing'}));console.log(JSON.stringify({result:{text:'完成'}}));`,async root=>{
    await assert.rejects(speechCommand(root,'probe','unused',()=>{throw new Error('fixture progress write failed');}),/fixture progress write failed/);
  });
});

test('解释器按平台查找虚拟环境，保留显式配置和系统回退',()=>{
  for(const platform of ['win32','darwin','linux']){
    const local=path.join(process.cwd(),platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
    assert.equal(pythonExecutable(process.cwd(),{platform,env:{},exists:file=>file===local}),local);
    assert.equal(pythonExecutable(process.cwd(),{platform,env:{},exists:()=>false}),platform==='win32'?'python':'python3');
    assert.equal(pythonExecutable(process.cwd(),{platform,env:{PYTHON_BIN:'custom-python'},exists:()=>assert.fail()}),'custom-python');
  }
});

test('工作器缺少Unix统计模块仍可导入，中文和Unicode输出使用UTF-8',()=>{
  const script=`import sys, runpy
sys.modules['resource'] = None
worker = runpy.run_path('speech/worker.py')
worker['emit']({'text': '\\u8bfe\\u5802\\u8bed\\u97f3\\U0001f600', 'memory': worker['peak_resident_bytes']()})`;
  // Force a non-UTF-8 caller to cover direct CLI use on Windows as well.
  const output=execFileSync(pythonExecutable(process.cwd()),['-c',script],{encoding:'utf8',env:{...pythonEnvironment(),PYTHONIOENCODING:'ascii'}});
  assert.deepEqual(JSON.parse(output),{text:'课堂语音😀',memory:null});
});

test('真实语音子进程超过配置时限被终止并给出可重试说明',async()=>{
  const previous=process.env.ASR_TASK_TIMEOUT_MS;process.env.ASR_TASK_TIMEOUT_MS='1';
  try{await assert.rejects(()=>speechCommand(process.cwd(),'transcribe',path.resolve('artifacts/audio/asr-example-zh.wav')),/转写超过任务时限/);}
  finally{if(previous===undefined)delete process.env.ASR_TASK_TIMEOUT_MS;else process.env.ASR_TASK_TIMEOUT_MS=previous;}
});
