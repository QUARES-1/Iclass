// 拉取并打印指定表单的问卷数据，便于核对导入结果或接入统计模块。
// 用法：npm run list-responses [-- --limit=100]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { JinshujuClient } from '../src/jinshuju.js';
import { FORM_INSTANCE_FILE } from '../src/survey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    console.warn('读取 .env 失败：' + error.message);
  }
}

function argValue(name, fallback) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : fallback;
}

let formToken = process.env.JINSHUJU_FORM_TOKEN || '';
if (!formToken) {
  try {
    const local = JSON.parse(await readFile(FORM_INSTANCE_FILE, 'utf8'));
    formToken = local.token || '';
  } catch {
    formToken = '';
  }
}

if (!formToken) {
  console.error('请先运行 npm run create-survey，或设置 JINSHUJU_FORM_TOKEN。');
  process.exit(1);
}

const limit = Number(argValue('limit', '100')) || 100;
const client = new JinshujuClient();
const page = await client.listEntries(formToken, { limit, include_labels: true });

console.log(`表单 ${formToken}：共 ${page.total} 条，本页返回 ${page.count} 条。`);
for (const entry of page.data || []) {
  console.log(`#${entry.serial_number} ${JSON.stringify(entry)}`);
}
