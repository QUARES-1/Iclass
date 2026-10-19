import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSurveyDefinition,
  loadSampleEntries,
  validateSurveyDefinition,
  validateSampleEntries,
} from '../src/survey.js';

test('问卷定义加载成功且结构合法', async () => {
  const definition = await loadSurveyDefinition();
  const result = validateSurveyDefinition(definition);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(definition.fields.length, 10);
});

test('样例数据加载成功且与问卷定义一致', async () => {
  const definition = await loadSurveyDefinition();
  const samples = await loadSampleEntries();
  assert.ok(Array.isArray(samples));
  assert.ok(samples.length >= 3);
  const result = validateSampleEntries(definition, samples);
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('问卷覆盖课后反馈的四个核心维度', async () => {
  const definition = await loadSurveyDefinition();
  const labels = definition.fields.map((field) => field.label).join('');
  assert.match(labels, /难度/);
  assert.match(labels, /节奏/);
  assert.match(labels, /互动/);
  assert.match(labels, /理解程度/);
  assert.ok(definition.fields.some((field) => field.type === 'RatingField'));
  assert.ok(definition.fields.some((field) => field.type === 'CheckBox'));
});

test('选择类字段都显式提供 api_code', async () => {
  const definition = await loadSurveyDefinition();
  for (const field of definition.fields) {
    if (['RadioButton', 'CheckBox', 'DropDown'].includes(field.type)) {
      for (const choice of field.choices) {
        assert.ok(typeof choice.api_code === 'string' && choice.api_code, `${field.label} 缺少选项 api_code`);
      }
    }
  }
});
