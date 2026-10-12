import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCodeSyntax} from '../src/codeCheck.js';
test('C++检查仅编译语法，不执行程序，非标准文件不交给编译器',async()=>{
  let calls=0;
  const code={language:'cpp',source:'#include <iostream>\nint main() { std::cout << 1; }'};
  const result=await checkCodeSyntax(code,{compiler:'/usr/bin/clang++',run:async(cmd,args,options)=>{calls++;assert.ok(args.includes('-fsyntax-only'));assert.ok(args.includes('-std=c++17'));assert.equal(options.timeout,10000);}});
  assert.equal(result.status,'passed');assert.equal(result.scope,'syntax-only');
  for(const source of ['#include "/etc/passwd"\nint main() {}','#include <unknown.h>\nint main() {}','#pragma plugin\n#include <vector>\nint main() {}'])assert.equal((await checkCodeSyntax({...code,source},{run:async()=>{throw Error('should not call compiler');}})).status,'not_checked');
  assert.equal(calls,1);
});
test('实际编译错误作为失败反馈，核心片段与其他语言不伪称验证通过',async()=>{
  const result=await checkCodeSyntax({language:'cpp',source:'#include <vector>\nint main( {'},{compiler:'/usr/bin/clang++',run:async()=>{throw {stderr:'example.cpp: error: expected token'};}});
  assert.equal(result.status,'failed');assert.match(result.diagnostic,/expected token/);
  assert.equal((await checkCodeSyntax({language:'python',source:'print(1)'})).status,'not_checked');
  assert.equal((await checkCodeSyntax({language:'cpp',source:'int f() { return 1; }'})).status,'not_checked');
});
