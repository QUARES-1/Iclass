const parameters=new URLSearchParams(globalThis.location?.search||'');
export const lessonId = parameters.get('lesson') || '';
export const scopeRequested=parameters.has('lesson');
export const scopeKey = value => lessonId ? value + ':' + lessonId : value;
export function scopedURL(value) {
  if (!scopeRequested) return value;
  const url = new URL(value, location.href);
  if (url.origin !== location.origin) return value;
  if (url.pathname.startsWith('/api/') && !/^\/api\/(?:courses|lessons|model-settings|status|feedback\/settings)(?:\/|$)/.test(url.pathname) || /\/public\/(?:index|sprint2|sprint3|settings|agent-draft|lesson)\.html$/.test(url.pathname)) {
    url.searchParams.set('lesson', lessonId);
    return url.pathname + url.search + url.hash;
  }
  return value;
}
