import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook, JinshujuWebhookError } from '../src/webhook.js';

const raw = JSON.stringify({
  form: 'ABC123',
  form_name: '《数据结构》课堂反馈问卷',
  entry: { serial_number: 1, field_1: 'session_05' },
});

test('合法 Webhook 被解析为表单与数据', () => {
  const result = handleWebhook(raw, { 'x-requested-by': 'jinshuju' });
  assert.equal(result.formToken, 'ABC123');
  assert.equal(result.formName, '《数据结构》课堂反馈问卷');
  assert.equal(result.entry.serial_number, 1);
});

test('缺少 X-Requested-By 请求头时拒绝', () => {
  assert.throws(() => handleWebhook(raw, {}), JinshujuWebhookError);
});

test('请求头不合法时拒绝', () => {
  assert.throws(() => handleWebhook(raw, { 'x-requested-by': 'other' }), JinshujuWebhookError);
});

test('非法 JSON 时拒绝', () => {
  assert.throws(() => handleWebhook('not-json', { 'x-requested-by': 'jinshuju' }), JinshujuWebhookError);
});

test('缺少 form 或 entry 时拒绝', () => {
  assert.throws(() => handleWebhook(JSON.stringify({ form_name: '问卷' }), { 'x-requested-by': 'jinshuju' }), JinshujuWebhookError);
});
