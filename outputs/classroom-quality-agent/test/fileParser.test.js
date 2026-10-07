import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPptxText,
  extractUploadedFile,
  FileParseError,
  MAX_UPLOAD_BYTES,
} from '../src/fileParser.js';
import { createStoredZip, slideXml } from '../test-support/zipFixture.js';

test('按页码顺序提取 PPTX 文字并解码 XML 实体', async () => {
  const pptx = createStoredZip({
    'ppt/slides/slide2.xml': slideXml(['第二页', 'A &amp; B']),
    'ppt/slides/slide1.xml': slideXml(['第一章 线性表', '教学目标：理解顺序表']),
    '[Content_Types].xml': '<Types/>',
  });

  const result = await extractUploadedFile(pptx, '../课件.pptx');
  assert.equal(result.name, '课件.pptx');
  assert.equal(result.type, 'pptx');
  assert.equal(result.truncated, false);
  assert.match(result.content, /^\[第1页\]/);
  assert.ok(result.content.indexOf('第一章 线性表') < result.content.indexOf('[第2页]'));
  assert.ok(result.content.includes('A & B'));
  assert.equal(result.characters, result.content.length);
});

test('extractPptxText 拒绝损坏的 ZIP 数据', () => {
  assert.throws(
    () => extractPptxText(Buffer.from('not-a-zip')),
    (error) => error instanceof FileParseError && error.code === 'FILE_PARSE_FAILED',
  );
});

test('拒绝没有幻灯片条目的 PPTX', () => {
  const zip = createStoredZip({ '[Content_Types].xml': '<Types />' });
  assert.throws(() => extractPptxText(zip), /没有找到可读取的 PPTX 幻灯片/);
});

test('拒绝没有可提取文字的 PPTX', () => {
  const zip = createStoredZip({ 'ppt/slides/slide1.xml': slideXml([]) });
  assert.throws(() => extractPptxText(zip), /没有检测到可提取的文字/);
});

test('拒绝空文件', async () => {
  await assert.rejects(
    extractUploadedFile(Buffer.alloc(0), 'empty.pptx'),
    (error) => error.statusCode === 400 && error.code === 'EMPTY_FILE',
  );
});

test('拒绝超过上传限制的文件', async () => {
  await assert.rejects(
    extractUploadedFile(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'large.pptx'),
    (error) => error.statusCode === 413 && error.code === 'FILE_TOO_LARGE',
  );
});

test('旧版 PPT 与不支持的类型返回明确错误', async () => {
  await assert.rejects(
    extractUploadedFile(Buffer.from('data'), 'legacy.ppt'),
    (error) => error.statusCode === 415 && error.code === 'LEGACY_PPT_UNSUPPORTED',
  );
  await assert.rejects(
    extractUploadedFile(Buffer.from('data'), 'material.pdf'),
    (error) => error.statusCode === 415 && error.code === 'UNSUPPORTED_FILE_TYPE',
  );
});
