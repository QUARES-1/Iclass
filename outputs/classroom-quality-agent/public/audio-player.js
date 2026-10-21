// A fragment is temporary playback state; native seeking/pause returns to full playback.
export function createAudioPlayback(player,{onLabel=()=>{},onError=()=>{}}={}){
  let range=null,sequence=0,cancelWait;
  const clearRange=()=>{range=null;player.ontimeupdate=null;};
  const clear=()=>{++sequence;cancelWait?.();clearRange();};
  const fail=()=>new Error('音频无法回放：原文件可能已删除或格式不可用，请重新载入录音。');
  player.addEventListener('seeking',clearRange);
  player.addEventListener('pause',clearRange);
  player.addEventListener('emptied',clearRange);
  player.addEventListener('error',()=>{clearRange();onError(fail().message);});
  function waitFor(event,ms,timeoutError){
    return new Promise((resolve,reject)=>{
      const done=(value,error)=>{clearTimeout(timer);player.removeEventListener(event,loaded);player.removeEventListener('error',errored);if(cancelWait===cancel)cancelWait=null;error?reject(error):resolve(value);};
      const loaded=()=>done(true),errored=()=>done(false,fail()),cancel=()=>done(false);
      const timer=setTimeout(()=>done(true,timeoutError),ms);
      cancelWait=cancel;player.addEventListener(event,loaded);player.addEventListener('error',errored);
    });
  }
  async function ready(url){
    if(player.getAttribute('src')!==url){clearRange();player.pause();player.src=url;player.load();}
    if(player.readyState>=1)return true;
    return waitFor('loadedmetadata',12000,new Error('音频加载超时，请重试。'));
  }
  async function play(url,segment,label){
    clear();const token=sequence;if(!await ready(url)||token!==sequence)return;
    if(segment){
      if(Math.abs(player.currentTime-segment.start)>.03){
        const seek=waitFor('seeked',1500);player.currentTime=segment.start;if(!await seek)return;
      }
      if(token!==sequence)return;
      range=segment;
      player.ontimeupdate=()=>{if(range&&player.currentTime>=range.end){clearRange();player.pause();}};
    }
    player.hidden=false;onLabel(label);
    try{await player.play();}catch(error){if(token!==sequence)return;clear();if(error.name!=='AbortError')throw fail();}
  }
  return {clear,load:async(url)=>{clear();await ready(url);},playRange:(url,segment,label)=>play(url,segment,label),playFull:(url,label)=>play(url,null,label)};
}
