import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPptxText,
  extractUploadedFile,
  FileParseError,
  MAX_UPLOAD_BYTES,
  MAX_EXTRACTED_CHARACTERS,
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

test('UTF-8 TXT/MD 与 DOCX 正文解析，损坏和无正文返回明确错误',async()=>{
  assert.equal((await extractUploadedFile(Buffer.from('教学重点：排序'),'lesson.txt')).content,'教学重点：排序');
  assert.equal((await extractUploadedFile(Buffer.from('# 算法'),'lesson.md')).type,'md');
  const docx=createStoredZip({'word/document.xml':'<w:document><w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p><w:p><w:r><w:t>稳定排序</w:t></w:r></w:p></w:document>'});
  assert.equal((await extractUploadedFile(docx,'lesson.docx')).content,'A & B\n稳定排序');
  await assert.rejects(()=>extractUploadedFile(createStoredZip({'no-document':'x'}),'broken.docx'),/正文不存在/);
  await assert.rejects(()=>extractUploadedFile(Buffer.from([0xff,0xfe]),'broken.txt'),/UTF-8/);
});

test('截取后的正文不超过后续接口上限，保留截取元信息',async()=>{
  const result=await extractUploadedFile(Buffer.from('课'.repeat(MAX_EXTRACTED_CHARACTERS+1)),'long.txt');assert.equal(result.truncated,true);assert.ok(result.content.length<=MAX_EXTRACTED_CHARACTERS);assert.equal(result.originalCharacters,MAX_EXTRACTED_CHARACTERS+1);
});
test('截取不会破坏 Unicode，完整原文中的控制字符也会拒绝',async()=>{
  const value='课'.repeat(MAX_EXTRACTED_CHARACTERS-1)+'😀尾部';
  const result=await extractUploadedFile(Buffer.from(value),'emoji.TXT');
  assert.equal(result.content.length,MAX_EXTRACTED_CHARACTERS-1);assert.equal(result.content.isWellFormed(),true);
  await assert.rejects(()=>extractUploadedFile(Buffer.from('课'.repeat(MAX_EXTRACTED_CHARACTERS+1)+'\0'),'tail.txt'),/控制字符/);
});
test('二进制冒充UTF-8文本、空白正文及非法XML字符实体返回解析错误',async()=>{
  await assert.rejects(()=>extractUploadedFile(Buffer.from('文字\0二进制'),'fake.txt'),error=>error instanceof FileParseError);
  await assert.rejects(()=>extractUploadedFile(Buffer.from('\uFEFF \n\t'),'empty.md'),/没有有效文本/);
  await assert.rejects(()=>extractUploadedFile(createStoredZip({'ppt/slides/slide1.xml':slideXml(['&#99999999;'])}),'invalid.pptx'),error=>error instanceof FileParseError);
});
test('ZIP 声明尺寸与实际数据不符、正文CRC损坏、加密标记均被拒绝',async()=>{
  const valid=createStoredZip({'ppt/slides/slide1.xml':slideXml(['中文正文'])}),central=valid.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  const wrongSize=Buffer.from(valid);wrongSize.writeUInt32LE(1,central+24);await assert.rejects(()=>extractUploadedFile(wrongSize,'wrong.pptx'),error=>error instanceof FileParseError);
  const corrupt=Buffer.from(valid);corrupt[30+corrupt.readUInt16LE(26)+20]^=1;await assert.rejects(()=>extractUploadedFile(corrupt,'corrupt.pptx'),error=>error instanceof FileParseError);
  const encrypted=Buffer.from(valid);encrypted.writeUInt16LE(1,central+8);await assert.rejects(()=>extractUploadedFile(encrypted,'encrypted.pptx'),/加密/);
});
test('Office 行内换行及制表符保留，避免相邻知识点被粘连',async()=>{
  const docx=createStoredZip({'word/document.xml':'<w:document><w:p><w:r><w:t>英语</w:t><w:tab/><w:t>English</w:t><w:br/><w:t>下一行</w:t></w:r></w:p></w:document>'});
  assert.equal((await extractUploadedFile(docx,'lesson.docx')).content,'英语\tEnglish\n下一行');
  const pptx=createStoredZip({'ppt/slides/slide1.xml':'<a:p><a:r><a:t>第一步</a:t></a:r><a:br/><a:r><a:t>第二步</a:t></a:r></a:p>'});
  assert.equal((await extractUploadedFile(pptx,'lesson.pptx')).content,'[第1页]\n第一步\n第二步');
});
