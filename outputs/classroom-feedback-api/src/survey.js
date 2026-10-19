// 课后问卷定义与样例数据的加载、校验和导入封装。
// 字段 api_code 按表单 fields 数组顺序固定为 field_1..field_N；
// 选择类字段的选项显式给出 api_code，样例数据按这些 code 提交。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, '..', 'data');
export const SURVEY_DEFINITION_FILE = path.join(DATA_DIR, 'survey-form.json');
export const SAMPLE_ENTRIES_FILE = path.join(DATA_DIR, 'sample-entries.json');
export const FORM_INSTANCE_FILE = path.join(DATA_DIR, 'form-instance.local.json');

const CHOICE_TYPES = new Set(['RadioButton', 'CheckBox', 'DropDown', 'ImageRadioButton', 'ImageCheckBox', 'CascadeDropDown', 'SortField']);
const RATING_TYPES = new Set(['RatingField', 'NpsField']);
const TEXT_TYPES = new Set(['TextField', 'TextArea', 'NameField', 'MobileField', 'EmailField', 'TelephoneField', 'IdCardField', 'LinkField']);

export async function readJson(file) {
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw);
}

export function loadSurveyDefinition(file = SURVEY_DEFINITION_FILE) {
  return readJson(file);
}

export function loadSampleEntries(file = SAMPLE_ENTRIES_FILE) {
  return readJson(file);
}

export function fieldApiCode(index) {
  return `field_${index + 1}`;
}

export function validateSurveyDefinition(definition) {
  const errors = [];
  const warnings = [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { ok: false, errors: ['问卷定义必须是对象'], warnings };
  }
  if (typeof definition.name !== 'string' || !definition.name.trim()) {
    errors.push('name 必须是非空字符串');
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
    errors.push('fields 必须是非空数组');
    return { ok: false, errors, warnings };
  }

  definition.fields.forEach((field, index) => {
    const apiCode = fieldApiCode(index);
    if (!field || typeof field !== 'object') {
      errors.push(`${apiCode} 必须是对象`);
      return;
    }
    if (typeof field.type !== 'string' || !field.type) {
      errors.push(`${apiCode} 缺少 type`);
    }
    if (typeof field.label !== 'string' || !field.label.trim()) {
      errors.push(`${apiCode} 缺少 label`);
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      errors.push(`${apiCode} 的 required 必须是布尔值`);
    }

    if (CHOICE_TYPES.has(field.type)) {
      if (!Array.isArray(field.choices) || field.choices.length === 0) {
        errors.push(`${apiCode} 是选择类字段，choices 必须非空`);
      } else {
        const seen = new Set();
        field.choices.forEach((choice, choiceIndex) => {
          if (!choice || typeof choice !== 'object') {
            errors.push(`${apiCode}.choices[${choiceIndex}] 必须是对象`);
            return;
          }
          const label = choice.value ?? choice.name;
          if (typeof label !== 'string' || !label.trim()) {
            errors.push(`${apiCode}.choices[${choiceIndex}] 缺少展示值`);
          }
          if (choice.api_code === undefined) {
            warnings.push(`${apiCode}.choices[${choiceIndex}] 未显式指定 api_code，样例数据无法稳定引用`);
          } else if (typeof choice.api_code !== 'string' || !choice.api_code) {
            errors.push(`${apiCode}.choices[${choiceIndex}].api_code 必须是非空字符串`);
          } else if (seen.has(choice.api_code)) {
            errors.push(`${apiCode}.choices[${choiceIndex}].api_code 重复`);
          } else {
            seen.add(choice.api_code);
          }
        });
      }
    }

    if (field.type === 'RatingField' && field.rating_max !== undefined && ![3, 5, 10].includes(field.rating_max)) {
      errors.push(`${apiCode} 的 rating_max 仅支持 3 / 5 / 10`);
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

export function validateSampleEntries(definition, entries) {
  const errors = [];
  const warnings = [];
  if (!definition || !Array.isArray(definition.fields)) {
    return { ok: false, errors: ['请先提供合法的问卷定义'], warnings };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, errors: ['样例数据必须是数组'], warnings };
  }

  const fields = definition.fields.map((field, index) => ({
    apiCode: fieldApiCode(index),
    field,
  }));
  const byApiCode = new Map(fields.map((item) => [item.apiCode, item.field]));

  entries.forEach((entry, entryIndex) => {
    const prefix = `entries[${entryIndex}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} 必须是对象`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!byApiCode.has(key)) {
        warnings.push(`${prefix} 包含未知字段 "${key}"`);
      }
    }
    for (const { apiCode, field } of fields) {
      const value = entry[apiCode];
      const isEmpty = value === undefined || value === null || value === '';
      if (field.required === true && isEmpty) {
        errors.push(`${prefix}.${apiCode} 为必填字段，不能为空`);
        continue;
      }
      if (isEmpty) continue;

      if (field.type === 'RadioButton' || field.type === 'DropDown') {
        const allowed = new Set((field.choices || []).map((choice) => choice.api_code));
        if (!allowed.has(value)) {
          errors.push(`${prefix}.${apiCode} 取值 "${value}" 不在选项 api_code 中`);
        }
      } else if (field.type === 'CheckBox') {
        const allowed = new Set((field.choices || []).map((choice) => choice.api_code));
        if (!Array.isArray(value)) {
          errors.push(`${prefix}.${apiCode} 应为选项 api_code 数组`);
        } else {
          value.forEach((item) => {
            if (!allowed.has(item)) {
              errors.push(`${prefix}.${apiCode} 包含未知选项 "${item}"`);
            }
          });
        }
      } else if (field.type === 'RatingField') {
        const max = field.rating_max ?? 5;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
          errors.push(`${prefix}.${apiCode} 应为 1..${max} 的整数`);
        }
      } else if (field.type === 'NpsField') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10) {
          errors.push(`${prefix}.${apiCode} 应为 0..10 的整数`);
        }
      } else if (TEXT_TYPES.has(field.type)) {
        if (typeof value !== 'string') {
          errors.push(`${prefix}.${apiCode} 应为字符串`);
        }
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}
