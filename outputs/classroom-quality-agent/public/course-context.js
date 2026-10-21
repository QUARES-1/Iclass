import {lessonId, scopedURL, scopeRequested} from './lesson-scope.js';
import {api, esc, notice} from './ui.js';
if (scopeRequested) {
  function scopeLinks() {
    for (const a of document.querySelectorAll('a[href]')) { const href=a.getAttribute('href'), next=scopedURL(href); if(next!==href)a.setAttribute('href',next); }
  }
  scopeLinks();
  for(const link of document.querySelectorAll('header nav a'))if(/\/(?:index|sprint2|sprint3)\.html$/.test(new URL(link.href).pathname))link.remove();
  new MutationObserver(scopeLinks).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
  try {
    const {course,lesson}=await api('/api/lessons/'+lessonId,undefined,{signal:AbortSignal.timeout(15000)});
    document.title=lesson.title+' · '+course.title+' · 爱教学';
    const nav=document.createElement('section');nav.className='lesson-navigation';nav.setAttribute('aria-label','当前课程与课次');
    nav.innerHTML='<div><a href="./course.html?course='+course.id+'">'+esc(course.title)+'</a><span> / '+esc(lesson.title)+' · '+esc(lesson.date)+'</span>'+(lesson.legacy?'<small>历史工作区，保留升级前的数据与关联</small>':'')+'</div><nav>'+[['lesson.html','课次概览与资源'],['index.html','备课'],['sprint2.html','课堂录音'],['sprint3.html','课后反馈']].map(([file,label])=>'<a '+(location.pathname.endsWith('/'+file)?'aria-current="page" ':'')+'href="'+scopedURL('./'+file)+'">'+label+'</a>').join('')+'</nav>';
    document.querySelector('header').after(nav);
    if(!lesson.legacy && location.pathname.endsWith('/sprint3.html')) {
      document.querySelector('.feedback-layout > aside').hidden=true;
      for(const id of ['course-title','course-date','course-description'])if(document.getElementById(id))document.getElementById(id).readOnly=true;
      document.getElementById('delete-class')?.setAttribute('hidden','');
      const catalog=await api('/api/courses/'+course.id,undefined,{signal:AbortSignal.timeout(15000)}).catch(()=>({lessons:[lesson]})),label=document.createElement('label');label.textContent='将建议带入课次';
      const select=document.createElement('select');select.id='handoff-lesson';
      const destinations=catalog.lessons.filter(l=>!l.archived),later=destinations.find(l=>l.id!==lesson.id&&l.date>=lesson.date);
      select.innerHTML=destinations.map(l=>'<option value="'+l.id+'">'+esc(l.title)+(l.id===lesson.id?'（继续完善本课次）':'')+'</option>').join('');select.value=later?.id||lesson.id;
      label.append(select);document.getElementById('handoff-suggestions').before(label);
    }
  }catch(error){
    for(const control of document.querySelectorAll('main input,main textarea,main select,main button'))control.disabled=true;
    notice('无法打开该课次，请返回课程页重新进入：'+error.message,true);
  }
}
