import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {speechCommand} from '../src/speech.js';
import {pythonExecutable,pythonEnvironment} from '../src/python.js';

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
