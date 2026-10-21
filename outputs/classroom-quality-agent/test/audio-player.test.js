import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioPlayback} from '../public/audio-player.js';

class Player extends EventTarget{
  readyState=0;currentTime=0;played=0;listeners=new Map();
  getAttribute(name){return this[name];} pause(){this.dispatchEvent(new Event('pause'));} load(){this.dispatchEvent(new Event('emptied'));} async play(){this.played++;}
  addEventListener(type,fn,options){super.addEventListener(type,fn,options);if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn,options){super.removeEventListener(type,fn,options);this.listeners.get(type)?.delete(fn);}
}
test('清空播放器立即释放加载等待，迟到的元数据不能重新播放旧录音',async()=>{
  const player=new Player(),playback=createAudioPlayback(player),pending=playback.playRange('/old.wav',{start:1,end:3},'旧录音');
  playback.clear();player.dispatchEvent(new Event('loadedmetadata'));await pending;
  assert.equal(player.played,0);assert.equal(player.listeners.get('loadedmetadata')?.size,0);
});
test('连续切换一千次录音加载，最多保留一个等待监听器，最终只播放最后一次',async()=>{
  const player=new Player(),playback=createAudioPlayback(player),pending=[];
  for(let i=0;i<1000;i++){
    pending.push(playback.playFull('/audio-'+i+'.wav','录音'));
    assert.equal(player.listeners.get('loadedmetadata')?.size,1);
  }
  player.readyState=1;player.dispatchEvent(new Event('loadedmetadata'));await Promise.all(pending);
  assert.equal(player.played,1);assert.equal(player.listeners.get('loadedmetadata')?.size,0);
});
