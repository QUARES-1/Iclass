import test from 'node:test';
import assert from 'node:assert/strict';
import {extractJson} from '../src/llm.js';
import {requestJSON} from '../src/model.js';

test('合法 JSON 字段中的代码围栏不能被当成外层 JSON 围栏',()=>{
  const result={action:'reply',reply:'示例：```cpp\nint f() { return 1; }\n```，另一例 ```json\n{"a":1}\n```'};
  const raw=JSON.stringify(result);
  assert.deepEqual(extractJson(raw),result);
  assert.deepEqual(extractJson('```json\n'+raw+'\n```'),result);
  assert.deepEqual(extractJson('结果如下：\n'+raw+'\n完成。'),result);
});

test('仅规范 JSON 字符串的控制字符，完整代码的换行缩进和引号保持原样',()=>{
  const source='int f() {\n\treturn 1;\n}\n';
  const result={code:{source},notes:['包含双引号 " 和反斜杠 \\ 的讲解']};
  const raw=JSON.stringify(result).replace('int f() {\\n\\treturn 1;\\n}\\n',source);
  assert.deepEqual(extractJson(raw),result);
});

test('不补齐截断结构，不猜测缺失引号或非法转义，不将数组内对象当作响应',()=>{
  for(const raw of ['{"action":"create","content":{"slides":[]}', '{"text":"缺少结束引号}', '{"text":"非法\\q"}', '[{"action":"update"}]', '```json\n[{"action":"update"}]\n```', '说明中只有 ```cpp\nint f() {}\n```', '', undefined])assert.equal(extractJson(raw),null);
});

const response=(content,finishReason='stop')=>({ok:true,json:async()=>({choices:[{finish_reason:finishReason,message:{content}}]})});
test('模型请求接收字段含围栏的完整响应，截断响应仍拒绝且不提交',async()=>{
  const value={action:'reply',reply:'```cpp\nint f() {}\n```'};
  const config={apiKey:'synthetic-key',fetch:async()=>response(JSON.stringify(value))};
  assert.deepEqual(await requestJSON('test',{},config),value);
  await assert.rejects(requestJSON('test',{}, {...config,fetch:async()=>response(JSON.stringify(value),'length')}),e=>e.code==='MODEL_LENGTH');
});

test('格式失败保留安全诊断和修正指令，不将模型内容或凭据写入报错',async()=>{
  const content='{"secret":"private-teacher-text",';
  await assert.rejects(requestJSON('test',{}, {apiKey:'synthetic-key',fetch:async()=>response(content)}),e=>{
    assert.equal(e.code,'MODEL_FORMAT');assert.match(e.message,/正确转义/);
    assert.deepEqual(e.details,{reason:'invalid-json',responseCharacters:content.length,finishReason:'stop'});
    assert.ok(!JSON.stringify(e).includes('private-teacher-text'));assert.ok(!JSON.stringify(e).includes('synthetic-key'));return true;
  });
});
