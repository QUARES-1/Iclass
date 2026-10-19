// 把 data/sample-entries.json 中的样例数据批量导入指定表单。
// 表单 Token 优先级：--form-token=xxx > 环境变量 JINSHUJU_FORM_TOKEN > 本地 form-instance.local.json。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { JinshujuClient } from '../src/jinshuju.js';
import { loadSampleEntries, FORM_INSTANCE_FILE } from '../src/survey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    console.warn('读取 .env 失败：' + error.message);
  }
}

function resolveFormToken() {
  const arg = process.argv.find((item) => item.startsWith('--form-token='));
  if (arg) return arg.slice('--form-token='.length);
  return process.env.JINSHUJU_FORM_TOKEN || '';
}

let formToken = resolveFormToken();
if (!formToken) {
  try {
    const local = JSON.parse(await readFile(FORM_INSTANCE_FILE, 'utf8'));
    formToken = local.token || '';
  } catch {
    formToken = '';
  }
}

if (!formToken) {
  console.error('请先运行 npm run create-survey，或通过 --form-token=xxx / JINSHUJU_FORM_TOKEN 指定表单 Token。');
  process.exit(1);
}

const client = new JinshujuClient();
const entries = await loadSampleEntries();
console.log(`准备向表单 ${formToken} 导入 ${entries.length} 条样例数据。`);

const result = await client.batchCreateEntries(formToken, entries);
console.log(`导入完成：成功 ${result.created_count} 条。`);
for (const error of result.errors || []) {
  console.warn(`- 第 ${error.index} 条失败：${error.reason}`);
}
