import test from 'node:test';
import assert from 'node:assert/strict';
import {audioLimits,DEFAULT_AUDIO_LIMITS,validateUpload,MAX_UPLOAD_BYTES} from '../src/uploadPolicy.js';
test('上传预检处理大小边界、大小写、空文件、旧格式及文件名',()=>{
  validateUpload({name:'教学.TXT',size:MAX_UPLOAD_BYTES},'material');
  assert.throws(()=>validateUpload({name:'教学.txt',size:MAX_UPLOAD_BYTES+1},'material'),/15 MiB/);
  assert.throws(()=>validateUpload({name:'空.wav',size:0},'audio'),/为空/);
  assert.throws(()=>validateUpload({name:'旧文档.doc',size:1},'material'),/另存为/);
  assert.throws(()=>validateUpload({name:'音频.flac',size:1},'audio'),/仅支持/);
  assert.throws(()=>validateUpload({name:'a'.repeat(252)+'.wav',size:1},'audio'),/文件名/);
  validateUpload({name:'x.WAV',size:64},'audio',{maxBytes:64,maxSeconds:10});
  assert.throws(()=>validateUpload({name:'x.wav',size:65},'audio',{maxBytes:64,maxSeconds:10}),/上传限制/);
});
test('音频可配置限制，无效数值回退，不能出现零字节限制',()=>{
  for(const value of ['','bad','0','-1','Infinity'])assert.deepEqual(audioLimits({AUDIO_MAX_BYTES:value,AUDIO_MAX_SECONDS:value}),DEFAULT_AUDIO_LIMITS);
  assert.equal(audioLimits({AUDIO_MAX_BYTES:'0.1'}).maxBytes,DEFAULT_AUDIO_LIMITS.maxBytes);
  assert.deepEqual(audioLimits({AUDIO_MAX_BYTES:'64.9',AUDIO_MAX_SECONDS:'1.5'}),{maxBytes:64,maxSeconds:1.5});
});
