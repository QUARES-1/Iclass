// 使用金数据 API 创建课后反馈问卷，并保存返回的 Token 与字段对照到本地文件。
// 用法：npm run create-survey

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { JinshujuClient } from '../src/jinshuju.js';
import { loadSurveyDefinition, FORM_INSTANCE_FILE } from '../src/survey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    console.warn('读取 .env 失败：' + error.message);
  }
}

const client = new JinshujuClient();
const definition = await loadSurveyDefinition();

console.log(`准备创建问卷：${definition.name}`);
const created = await client.createForm(definition);

console.log('创建成功：');
console.log(`- 表单 Token：${created.token}`);
console.log(`- 填写链接：${created.url}`);
console.log('- 字段对照（api_code = 标题 [类型]）：');
for (const fieldMap of created.fields || []) {
  for (const [apiCode, meta] of Object.entries(fieldMap)) {
    console.log(`  ${apiCode} = ${meta.label} (${meta.type})`);
  }
}

const local = {
  token: created.token,
  url: created.url,
  name: created.name,
  fields: created.fields,
};
await writeFile(FORM_INSTANCE_FILE, JSON.stringify(local, null, 2) + '\n', 'utf8');
console.log(`本地实例信息已保存：${FORM_INSTANCE_FILE}`);
console.log('下一步：npm run import-samples 导入样例数据。');
