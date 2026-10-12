// A fragment is temporary playback state; native seeking/pause returns to full playback.
export function createAudioPlayback(player,{onLabel=()=>{},onError=()=>{}}={}){
  let range=null,sequence=0;
  const clear=()=>{range=null;player.ontimeupdate=null;};
  const fail=()=>new Error('音频无法回放：原文件可能已删除或格式不可用，请重新载入录音。');
  player.addEventListener('seeking',clear);
  player.addEventListener('pause',clear);
  player.addEventListener('emptied',clear);
  player.addEventListener('error',()=>{clear();onError(fail().message);});
  async function ready(url){
    if(player.getAttribute('src')!==url){clear();player.pause();player.src=url;player.load();}
    if(player.readyState>=1)return;
    await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);player.removeEventListener('loadedmetadata',loaded);player.removeEventListener('error',errored);error?reject(error):resolve();};
      const loaded=()=>done(),errored=()=>done(fail()),timer=setTimeout(()=>done(new Error('音频加载超时，请重试。')),12000);
      player.addEventListener('loadedmetadata',loaded,{once:true});player.addEventListener('error',errored,{once:true});
    });
  }
  async function play(url,segment,label){
    const token=++sequence;clear();await ready(url);if(token!==sequence)return;
    if(segment){
      if(Math.abs(player.currentTime-segment.start)>.03){
        await new Promise(resolve=>{const end=()=>{clearTimeout(timer);player.removeEventListener('seeked',end);resolve();};const timer=setTimeout(end,1500);player.addEventListener('seeked',end,{once:true});player.currentTime=segment.start;});
      }
      if(token!==sequence)return;
      range=segment;
      player.ontimeupdate=()=>{if(range&&player.currentTime>=range.end){clear();player.pause();}};
    }
    player.hidden=false;onLabel(label);
    try{await player.play();}catch(error){clear();if(error.name!=='AbortError')throw fail();}
  }
  return {clear,load:async(url)=>{++sequence;clear();await ready(url);},playRange:(url,segment,label)=>play(url,segment,label),playFull:(url,label)=>play(url,null,label)};
}
