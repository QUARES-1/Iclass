import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(projectDir, 'public/index.html'), 'utf8');
const main = fs.readFileSync(path.join(projectDir, 'public/main.js'), 'utf8');

test('上传入口只展示当前支持的资料类型', () => {
  assert.match(html, /accept="[^"]*\.docx[^"]*\.pptx/);
  assert.doesNotMatch(html, /accept="[^"]*\.pdf/);
});

test('首页教学资料输入框初始为空', () => {
  const textareas = [...html.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)];
  assert.ok(textareas.length >= 4, '应存在四类教学资料输入框');
  assert.ok(textareas.every((match) => match[1].trim() === ''));
});

test('PPT 生成按钮使用精简后的文案', () => {
  assert.ok(html.includes('AI 生成 PPT'));
  assert.ok(!html.includes('AI 重新生成 PPT'));
  assert.ok(!html.includes('浏览器不会接触或保存 API Key'));
});

test('前沿补充不再显示已核验或待核验标签', () => {
  assert.ok(!html.includes('待核验'));
  assert.ok(!main.includes("item.needsVerify ? '待核验' : '已核验'"));
});

test('全部确认按钮位于审核列表之后的底部操作栏', () => {
  const listIndex = html.indexOf('id="review-list"');
  const confirmIndex = html.indexOf('id="btn-confirm-all"');
  const finalExportIndex = html.indexOf('id="btn-export-pptx-final"');
  assert.ok(listIndex >= 0 && confirmIndex > listIndex);
  assert.ok(finalExportIndex > confirmIndex);
});

test('前端源码不包含后端密钥变量或硬编码 Key', () => {
  const publicFiles = ['index.html', 'main.js', 'sample.js']
    .map((name) => fs.readFileSync(path.join(projectDir, 'public', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicFiles, /LLM_API_KEY|DEEPSEEK_API_KEY|sk-[A-Za-z0-9_-]{16,}/);
});
