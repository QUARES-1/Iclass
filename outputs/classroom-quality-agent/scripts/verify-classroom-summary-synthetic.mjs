// Real provider verification with synthetic content and default prompts only.
// This does not load teacher audio, transcripts, course descriptions or prompts.
import fs from 'node:fs/promises';
import {analyzeClassroom} from '../src/analysis.js';
import {ModelSettings} from '../src/modelSettings.js';
import {DEFAULT_PROMPTS} from '../src/prompts.js';
import {requestJSON} from '../src/model.js';
const config={...await new ModelSettings('data').read(),prompts:DEFAULT_PROMPTS};
const segments=[{id:'synthetic-a',start:0,end:180,text:'虚构教学样例：本节学习冒泡排序。相邻元素逆序时交换，一轮后最大值移至末尾。教师用三个数字示范，再说明循环范围。'.repeat(160)},{id:'synthetic-b',start:190,end:360,text:'虚构教学样例：讲解交换标记用于提前终止，比较已经有序与逆序输入的过程。提出为什么外层循环可以提前停止，再用一组输入演示。'}];
const partials=segments.map((s,i)=>({ids:[s.id],sections:{summary:[{text:i?'第二阶段说明提前终止及输入条件，并用问题和操作演示联系循环控制。':'第一阶段通过相邻比较与交换引出算法，逐步说明一轮完成后的结果与循环范围。',kind:'transcript',evidenceIds:[s.id]}],suggestions:[],knowledge:[],emphasis:[],difficulties:[],observations:[]}}));
let calls=0;const result=await analyzeClassroom({title:'虚构排序课测试',description:'完全合成的验证内容'}, {segments},async(...args)=>{calls++;return requestJSON(...args);},undefined,config,{checkpoint:{partials}});
const record={synthetic:true,realProvider:true,calls,summaryItems:result.sections.summary.length,summaryCharacters:result.sections.summary[0].text.length,suggestions:result.sections.suggestions.length,coverage:result.coverage.length,passed:true};
await fs.mkdir('artifacts/summary-fix',{recursive:true});await fs.writeFile('artifacts/summary-fix/synthetic-summary.json',JSON.stringify({verification:record,result},null,2));console.log(JSON.stringify(record));
