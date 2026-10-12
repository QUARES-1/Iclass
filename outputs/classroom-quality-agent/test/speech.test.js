import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {speechCommand} from '../src/speech.js';
test('真实语音子进程超过配置时限被终止并给出可重试说明',async()=>{
  const previous=process.env.ASR_TASK_TIMEOUT_MS;process.env.ASR_TASK_TIMEOUT_MS='1';
  try{await assert.rejects(()=>speechCommand(process.cwd(),'transcribe',path.resolve('artifacts/audio/asr-example-zh.wav')),/转写超过任务时限/);}
  finally{if(previous===undefined)delete process.env.ASR_TASK_TIMEOUT_MS;else process.env.ASR_TASK_TIMEOUT_MS=previous;}
});
