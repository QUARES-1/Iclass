// Shared limits and client preflight. The server still validates actual bytes.
export const MAX_UPLOAD_BYTES=15*1024*1024;
export const MAX_EXTRACTED_CHARACTERS=250000;
export const MAX_MATERIALS=20;
export const MAX_TOTAL_CHARACTERS=500000;
export const MATERIAL_EXTENSIONS=['txt','md','docx','pptx'];
export const AUDIO_EXTENSIONS=['wav','mp3','m4a','webm','ogg'];
export const DEFAULT_AUDIO_LIMITS={maxBytes:512*1024*1024,maxSeconds:10800};
export function audioLimits(env={}) {
  const positive=(value,fallback)=>Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : fallback;
  return {maxBytes:Math.floor(positive(env.AUDIO_MAX_BYTES,DEFAULT_AUDIO_LIMITS.maxBytes))||DEFAULT_AUDIO_LIMITS.maxBytes,maxSeconds:positive(env.AUDIO_MAX_SECONDS,DEFAULT_AUDIO_LIMITS.maxSeconds)};
}
export function validateUpload(file,kind,limits=DEFAULT_AUDIO_LIMITS) {
  const extension=String(file.name||'').split('.').at(-1).toLowerCase();
  if(!file.name || file.name.length>255)throw new Error('文件名需为 1～255 个字符，请缩短名称后重试。');
  if(!(kind==='audio'?AUDIO_EXTENSIONS:MATERIAL_EXTENSIONS).includes(extension))throw new Error(kind==='audio'?'仅支持 WAV、MP3、M4A、WebM、OGG 音频；不能只修改扩展名。':'仅支持 TXT、MD、DOCX、PPTX；旧版 DOC/PPT 请另存为 DOCX/PPTX。');
  if(!file.size)throw new Error('文件为空，请选择有内容的文件。');
  const maxBytes=kind==='audio'?limits.maxBytes:MAX_UPLOAD_BYTES;
  if(file.size>maxBytes)throw new Error(`文件超过 ${Number((maxBytes/1024/1024).toFixed(2))} MiB 上传限制，请缩小文件后重试。`);
}
