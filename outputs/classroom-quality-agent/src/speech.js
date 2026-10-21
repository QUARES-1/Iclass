import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pythonExecutable, pythonEnvironment } from './python.js';
import { AppError } from './store.js';
const activeChildren = new Set();
export function stopSpeechWorkers() { for (const child of activeChildren) {try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{/* Already exited. */}} }

export function speechCommand(root, mode, file, onEvent = () => {}, options = {}) {
  return new Promise((resolve, reject) => {
    if(options.signal?.aborted)return reject(new AppError('任务已暂停，已完成分段保留。',499));
    const python = pythonExecutable(root);
    const child = spawn(python, [path.join(root, 'speech/worker.py'), mode, file], { cwd: root, detached:process.platform!=='win32',env: { ...pythonEnvironment(), HF_HUB_OFFLINE: '1',...(options.checkpointPath?{ASR_CHECKPOINT:options.checkpointPath}:{}),...(options.playbackPath?{PLAYBACK_TARGET:options.playbackPath}:{}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill=signal=>{try{if(process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{/* Already exited. */}};
    const abort=()=>kill('SIGTERM');options.signal?.addEventListener('abort',abort,{once:true});
    activeChildren.add(child);
    let result = null, error = '', stderr = '', settled = false;
    const timeout = setTimeout(() => { error = mode === 'probe' ? '音频探测超时，请检查文件。' : mode==='playback'?'回放音频转换超时，请重试。':'转写超过任务时限，已完成分段保留，可继续或缩短录音。'; kill('SIGKILL'); }, mode === 'probe' ? 180000 : mode==='playback'?600000:(Number(process.env.ASR_TASK_TIMEOUT_MS) || 7200000));
    // Await each progress write before reading more output. The pipe applies
    // backpressure, and completed events are never retained for the whole job.
    const events = (async()=>{
      const decoder=new StringDecoder('utf8');let buffer='';
      const line=async text=>{let event;try{event=JSON.parse(text);}catch{return;}if(event.result)result=event.result;if(event.error)error=event.error;await onEvent(event);};
      for await(const chunk of child.stdout){
        buffer+=decoder.write(chunk);let end;
        while((end=buffer.indexOf('\n'))>=0){const text=buffer.slice(0,end);buffer=buffer.slice(end+1);await line(text);}
      }
      buffer+=decoder.end();if(buffer.trim())await line(buffer);
    })();
    events.catch(()=>kill('SIGTERM'));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', e => { activeChildren.delete(child); settled = true; clearTimeout(timeout); options.signal?.removeEventListener('abort',abort);reject(new AppError('语音进程无法启动，请检查 Python 环境：' + e.message, 503)); });
    child.on('close', async code => {
      activeChildren.delete(child); clearTimeout(timeout);options.signal?.removeEventListener('abort',abort); if (settled) return;
      try { await events; if(options.signal?.aborted)reject(new AppError('任务已暂停，已完成分段保留。',499));else if (code === 0 && result) resolve(result); else reject(new AppError(error || '语音处理失败：' + stderr.slice(-500), 503)); }
      catch (e) { reject(e); }
    });
  });
}
