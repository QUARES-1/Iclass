import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const headers=new Set('iostream vector deque queue stack algorithm functional numeric random cmath tuple utility limits cstdint cstddef cassert array bitset string map set unordered_map unordered_set iomanip stdexcept optional memory iterator climits cstdio cstdlib cstring'.split(' '));

// Compile only; never execute generated programs or load arbitrary include files.
export async function checkCodeSyntax(code,{compiler,run=execute}={}){
  if(!/^(cpp|c\+\+|cxx)(17|20)?$/i.test(code.language))return {status:'not_checked',reason:'当前仅检查自包含C++示例，其他语言需在相应环境验证。'};
  if(!/^\s*#\s*include\b/m.test(code.source))return {status:'not_checked',reason:'核心代码片段需结合所列依赖或完整程序使用。'};
  const directives=[...code.source.matchAll(/^\s*#\s*(\w+)\s*(.*)$/gm)];
  if(directives.some(([,kind,arg])=>kind==='include'?!/^<([^>]+)>\s*(?:\/\/.*)?$/.test(arg)||!headers.has(arg.match(/^<([^>]+)>/)?.[1]):!['define','undef','if','ifdef','ifndef','elif','else','endif'].includes(kind)))return {status:'not_checked',reason:'示例包含非标准头文件或额外预处理指令，未调用本机编译器。'};
  if(!compiler){for(const candidate of ['/usr/bin/clang++','/usr/bin/g++']){try{await fs.access(candidate);compiler=candidate;break;}catch{}}}
  if(!compiler)return {status:'not_checked',reason:'本机未找到C++编译器，未验证语法。'};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-code-check-')),file=path.join(dir,'example.cpp');
  try{
    await fs.writeFile(file,code.source,{mode:0o600});
    await run(compiler,['-std=c++17','-fsyntax-only',file],{timeout:10000,maxBuffer:100000});
    return {status:'passed',compiler:path.basename(compiler),standard:'c++17',scope:'syntax-only'};
  }catch(e){
    return {status:'failed',compiler:path.basename(compiler),standard:'c++17',scope:'syntax-only',diagnostic:e.killed?'编译语法检查超时。':String(e.stderr||e.message).replaceAll(dir,'示例代码').slice(0,5000)};
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
