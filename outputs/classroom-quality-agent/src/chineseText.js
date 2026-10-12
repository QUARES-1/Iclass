import {Converter} from 'opencc-js/t2cn';
import {clone,id} from './store.js';
const convert=Converter({from:'t',to:'cn'});
export const simplifiedChinese=text=>convert(text);
// Script conversion is a separate version, never an overwrite of recognition
// or teacher edits. Segment IDs, exclusions and time alignment stay intact.
export function simplifiedTranscript(original){
  const segments=original.segments.map(s=>({...s,text:simplifiedChinese(s.text)}));
  if(segments.every((s,i)=>s.text===original.segments[i].text))return null;
  return {...clone(original),id:id(),parentId:original.id,source:'simplified',original:false,createdAt:new Date().toISOString(),segments,processing:{...original.processing,textNormalization:{method:'opencc-t2s',sourceTranscriptId:original.id}}};
}
export function simplifiedReport(original,transcriptId){
  return {...clone(original),id:id(),transcriptId,parentReportId:original.id,createdAt:new Date().toISOString(),history:[],textNormalization:{method:'opencc-t2s',sourceReportId:original.id},sections:Object.fromEntries(Object.entries(original.sections).map(([key,items])=>[key,items.map(item=>({...clone(item),text:simplifiedChinese(item.text)}))]))};
}
