import { createHash } from 'node:crypto';
import { AppError, id, clone } from './store.js';
import { loadSurveyDefinition, loadSampleEntries } from '../../classroom-feedback-api/src/survey.js';

export const QUESTION_TYPES = ['single','multiple','rating','select','text'];
const limit=(name,fallback,max)=>{const n=Number(process.env[name]);return Number.isSafeInteger(n)&&n>0&&n<=max?n:fallback;};
export const LIMITS = Object.freeze({
  get fileBytes(){return limit('FEEDBACK_MAX_IMPORT_BYTES',4*1024*1024,5*1024*1024);},
  get records(){return limit('FEEDBACK_MAX_RECORDS',10000,50000);},
  get text(){return limit('FEEDBACK_MAX_TEXT',4000,20000);},
  get questions(){return limit('FEEDBACK_MAX_QUESTIONS',80,200);},
  get options(){return limit('FEEDBACK_MAX_OPTIONS',80,200);}
});
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function text(value,max=500,required=true){
  if(typeof value!=='string'||value.length>max||(required&&!value.trim())||value.includes('\0'))throw new AppError('文字为空或超过允许长度（'+max+'字符）。',422);
  return value.trim();
}
export const validId = value => typeof value==='string'&&/^[a-z0-9_-]{1,80}$/i.test(value)&&!['__proto__','constructor','prototype'].includes(value);
// Date.parse normalizes impossible dates (e.g. February 30) and 24:00.
// Validate the written calendar fields before trusting a cutoff timestamp.
export function feedbackTimestamp(value){
  if(typeof value!=='string'||value.length>100)return NaN;
  const match=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/i.exec(value);
  if(!match)return NaN;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number),zoneHour=Number(match[8]||0),zoneMinute=Number(match[9]||0);
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59||zoneHour>23||zoneMinute>59)return NaN;
  return Date.parse(value);
}
export async function defaultTemplate(){
  const raw=await loadSurveyDefinition();
  const dimensions=['difficulty','pace','understanding','clarity','interaction','difficultParts','needs','rating','comments'];
  return validateTemplate({title:'课堂反馈',description:raw.description,questions:raw.fields.slice(1).map((f,i)=>({
    id:'q-'+dimensions[i],label:f.label,type:({RadioButton:'single',CheckBox:'multiple',RatingField:'rating',DropDown:'select',TextArea:'text',TextField:'text'})[f.type],
    dimension:dimensions[i],required:f.required===true,max:f.rating_max||5,
    options:(f.choices||[]).map(o=>({id:o.api_code,label:o.value||o.name}))
  }))});
}
export function validateTemplate(input){
  if(!input||!Array.isArray(input.questions)||!input.questions.length||input.questions.length>LIMITS.questions)throw new AppError('模板须有 1～'+LIMITS.questions+' 道题。');
  const seen=new Set();
  const questions=input.questions.map(q=>{
    if(!q||!validId(q.id)||seen.has(q.id)||!QUESTION_TYPES.includes(q.type))throw new AppError('题目标识重复或题型不支持。');
    seen.add(q.id);
    if(q.required!==undefined&&typeof q.required!=='boolean')throw new AppError('必填状态无效。');
    const next={id:q.id,label:text(q.label,1000),notes:text(q.notes||'',2000,false),type:q.type,required:q.required===true,dimension:text(q.dimension||'',100,false)};
    if(['single','multiple','select'].includes(q.type)){
      if(!Array.isArray(q.options)||!q.options.length||q.options.length>LIMITS.options)throw new AppError('选择题须有 1～'+LIMITS.options+' 个选项。');
      const codes=new Set();
      next.options=q.options.map(o=>{if(!validId(o?.id)||codes.has(o.id))throw new AppError('选项标识为空或重复。');codes.add(o.id);return {id:o.id,label:text(o.label,1000)};});
    }
    if(q.type==='rating'){if(![3,5,10].includes(q.max))throw new AppError('当前评分范围支持 1～3、1～5 或 1～10。');next.max=q.max;}
    return next;
  });
  return {title:text(input.title,500),description:text(input.description||'',4000,false),questions};
}
export function providerForm(template,course,deadline){
  const types={single:'RadioButton',multiple:'CheckBox',select:'DropDown',rating:'RatingField',text:'TextArea'};
  return {name:course.title+' · 课后反馈',description:template.description,
    fields:template.questions.map(q=>({type:types[q.type],label:q.label,notes:q.notes||'',required:q.required,...(q.options?{choices:q.options.map(o=>({value:o.label,api_code:o.id}))}:{}),...(q.type==='rating'?{rating_max:q.max}:{})})),
    ...(deadline?{setting:{by_time_range_close_rule:{end_time:deadline}}}:{})};
}
export function mapProviderForm(template,form){
  if(!validId(form?.token)||typeof form.url!=='string'||!/^https?:\/\//.test(form.url)||!Array.isArray(form.fields)||form.fields.length!==template.questions.length)throw new AppError('远端表单结构不完整，原表单已保留，请修复字段映射。');
  const expected={single:['radio','single_choice'],multiple:['check','multiple_choice'],select:['drop'],rating:['rating'],text:['text']};
  return form.fields.map((entry,i)=>{
    const entries=Object.entries(entry||{});
    if(entries.length!==1)throw new AppError('远端字段映射不唯一。');
    const [code,f]=entries[0],q=template.questions[i],type=String(f.type||'').toLowerCase();
    if(f.label!==q.label||!expected[q.type].some(t=>type.includes(t))&&(q.type!=='text'||!['multi_line_text','single_line_text'].includes(type)))throw new AppError('远端题目与发布版本不符，请核对后重试映射。');
    const options={},labels={};
    if(q.options){
      const choices=f.choices||[];
      if(choices.length!==q.options.length)throw new AppError('远端选项已改变，暂停错误统计。');
      for(let j=0;j<choices.length;j++){
        const o=choices[j],local=q.options[j];
        const label=o.name??o.label??o.value;
        const code=o.api_code??(o.name!==undefined||o.label!==undefined?o.value:undefined);
        if(label!==local.label||typeof code!=='string'||!code||Object.hasOwn(options,code))throw new AppError('远端选项无法对应模板。');
        options[code]=local.id;
        labels[local.label]=Object.hasOwn(labels,local.label)?null:local.id;
      }
    }
    return {code,questionId:q.id,type:q.type,options,labels};
  });
}
export function normalizeProviderEntry(entry,mapping,instance){
  if(!Number.isSafeInteger(entry?.serial_number)||entry.serial_number<1)throw new AppError('远端反馈缺少有效序号。');
  const answers={};
  for(const m of mapping){
    let value=entry[m.code];
    if(value&&typeof value==='object'&&!Array.isArray(value)&&'value' in value)value=value.value;
    const option=v=>{
      if(typeof v!=='string')return v;
      const code=Object.hasOwn(m.options,v)?m.options[v]:null,label=Object.hasOwn(m.labels||{},v)?m.labels[v]:null;
      if(Object.hasOwn(m.labels||{},v)&&label===null||code&&label&&code!==label)return {ambiguousOption:v};
      return code??label??v;
    };
    if(Array.isArray(value))value=value.map(option);
    else value=option(value);
    if(m.type==='rating'&&typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value.trim()))value=Number(value);
    if(value!==undefined)answers[m.questionId]=value;
  }
  return {id:'online-'+entry.serial_number,source:'online',instanceToken:instance.token,submittedAt:entry.created_at||null,updatedAt:entry.updated_at||null,answers};
}
export function validateRecord(record,template,deadline=null){
  const errors=[],answers={};
  if(record?.id!==undefined&&!validId(record.id))throw new AppError('反馈记录标识无效。');
  if(!record||typeof record!=='object'||Array.isArray(record)||!record.answers||typeof record.answers!=='object'||Array.isArray(record.answers))throw new AppError('反馈须包含 answers 对象。');
  const known=new Set(template.questions.map(q=>q.id));
  for(const key of Object.keys(record.answers))if(!known.has(key))errors.push('未知题目：'+key);
  for(const q of template.questions){
    const v=record.answers[q.id],empty=v===undefined||v===null||v===''||Array.isArray(v)&&!v.length;
    if(empty){if(q.required)errors.push(q.label+'：必填内容缺失');continue;}
    const allowed=new Set((q.options||[]).map(o=>o.id));
    let valid;
    if(['single','select'].includes(q.type))valid=typeof v==='string'&&allowed.has(v);
    if(q.type==='multiple')valid=Array.isArray(v)&&v.every(x=>typeof x==='string'&&allowed.has(x));
    if(q.type==='rating')valid=Number.isInteger(v)&&v>=1&&v<=q.max;
    if(q.type==='text')valid=typeof v==='string'&&v.length<=LIMITS.text&&!v.includes('\0');
    if(!valid)errors.push(q.label+'：取值不合法');else answers[q.id]=q.type==='multiple'?[...new Set(v)]:v;
  }
  const submitted=feedbackTimestamp(record.submittedAt);
  const late=deadline&&Number.isFinite(submitted)?submitted>=Date.parse(deadline):false;
  const unknownTime=Boolean(deadline&&!Number.isFinite(submitted));
  return {...record,rawAnswers:clone(record.rawAnswers||record.answers),id:validId(record.id)?record.id:'local-'+digest(record.answers).slice(0,32),answers,errors,late:Boolean(late),unknownTime,excluded:record.excluded===true,reason:typeof record.reason==='string'?record.reason.slice(0,1000):''};
}
export function statistics(records,template){
  const eligible=records.filter(r=>!r.excluded&&!r.late&&!r.unknownTime);
  return {missingDimensions:[['difficulty','知识难度'],['pace','课堂节奏'],['interaction','互动体验'],['understanding','理解程度']].filter(([key])=>!template.questions.some(q=>q.dimension===key)).map(([,label])=>label),total:records.length,excluded:records.filter(r=>r.excluded).length,late:records.filter(r=>r.late).length,unknownTime:records.filter(r=>r.unknownTime).length,invalid:records.filter(r=>r.errors.length).length,
    eligible:eligible.length,questions:template.questions.map(q=>{
      const values=eligible.filter(r=>Object.hasOwn(r.answers,q.id)).map(r=>r.answers[q.id]);
      const result={id:q.id,label:q.label,type:q.type,dimension:q.dimension,n:values.length};
      if(q.options)result.options=q.options.map(o=>({...o,count:values.filter(v=>Array.isArray(v)?v.includes(o.id):v===o.id).length,percent:values.length?Math.round(values.filter(v=>Array.isArray(v)?v.includes(o.id):v===o.id).length/values.length*10000)/100:null}));
      if(q.type==='rating'){result.mean=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;result.distribution=Array.from({length:q.max},(_,i)=>({score:i+1,count:values.filter(v=>v===i+1).length}));}
      if(q.type==='text')result.comments=eligible.filter(r=>typeof r.answers[q.id]==='string').map(r=>({recordId:r.id,text:r.answers[q.id]}));
      return result;
    })};
}
export async function sampleImport(){
  const template=await defaultTemplate(),raw=await loadSampleEntries();
  const groups={};
  raw.forEach((entry,i)=>{
    const group=entry.field_1;groups[group]||=[];
    const answers={};template.questions.forEach((q,j)=>{if(entry['field_'+(j+2)]!==undefined)answers[q.id]=entry['field_'+(j+2)];});
    groups[group].push({id:'sample-'+(i+1),source:'sample',answers});
  });
  return {template,groups};
}
export function makeTemplateVersion(template){return {id:id(),createdAt:new Date().toISOString(),...validateTemplate(template)};}
export function mergeRecords(existing,incoming){
  const map=new Map(existing.map(r=>[r.id,r]));let added=0,updated=0,skipped=0;
  for(const r of incoming){const old=map.get(r.id);if(old){if(Number.isFinite(Date.parse(r.updatedAt))&&Number.isFinite(Date.parse(old.updatedAt))&&Date.parse(r.updatedAt)<Date.parse(old.updatedAt)){skipped++;continue;}const next={...r,excluded:old.excluded,reason:old.reason};if(digest(old)===digest(next))skipped++;else{updated++;map.set(r.id,next);}}else{added++;map.set(r.id,r);}}
  return {records:[...map.values()],added,updated,skipped};
}
