// PowerPoint 教学资料解析模块。
// PPTX 本质是 ZIP 压缩包，这里直接读取其中的幻灯片 XML，
// 避免把二进制文件交给浏览器当作普通文本读取。

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.js';
import { MAX_UPLOAD_BYTES,MAX_EXTRACTED_CHARACTERS } from './uploadPolicy.js';
export { MAX_UPLOAD_BYTES,MAX_EXTRACTED_CHARACTERS } from './uploadPolicy.js';

const MAX_PPTX_XML_BYTES = 30 * 1024 * 1024;
const MAX_PPTX_ENTRY_BYTES = 5 * 1024 * 1024;

export class FileParseError extends Error {
  constructor(message, statusCode = 422, code = 'FILE_PARSE_FAILED') {
    super(message);
    this.name = 'FileParseError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/([\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/[ \t]+([，。！？；：、])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitExtractedText(text) {
  const normalized = normalizeExtractedText(text);
  if (normalized.length <= MAX_EXTRACTED_CHARACTERS) {
    return { content: normalized, truncated: false, originalCharacters:normalized.length };
  }
  return {
    content: normalized.slice(0, /[\uD800-\uDBFF]/.test(normalized[MAX_EXTRACTED_CHARACTERS-1])?MAX_EXTRACTED_CHARACTERS-1:MAX_EXTRACTED_CHARACTERS).trimEnd(),
    truncated: true,
    originalCharacters:normalized.length,
  };
}

function decodeXmlText(text) {
  const codePoint=value=>{
    if(!Number.isInteger(value) || value<0 || value>0x10ffff || value>=0xd800&&value<=0xdfff || value<32&&![9,10,13].includes(value))throw new FileParseError('文档 XML 包含无效的字符实体。');
    return String.fromCodePoint(value);
  };
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => codePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => codePoint(Number.parseInt(value, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function findZipEntries(buffer) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const minimumEocdSize = 22;
  const maximumCommentSize = 0xffff;
  let eocdOffset = -1;

  for (
    let offset = bytes.length - minimumEocdSize;
    offset >= Math.max(0, bytes.length - minimumEocdSize - maximumCommentSize);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset+22+view.getUint16(offset+20,true)===bytes.length) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new FileParseError('PPTX 文件结构无效或文件已经损坏。');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const directoryStart=offset,directoryEnd=offset+view.getUint32(eocdOffset+12,true);
  if(view.getUint16(eocdOffset+4,true)||view.getUint16(eocdOffset+6,true)||view.getUint16(eocdOffset+8,true)!==entryCount || directoryEnd>eocdOffset || offset>eocdOffset)throw new FileParseError('不支持分卷或损坏的 Office 压缩包。');
  const entries = [];
  const names=new Set();

  if (entryCount > 5000) {
    throw new FileParseError('PPTX 文件包含过多内部条目，无法安全解析。');
  }

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new FileParseError('PPTX 文件中央目录不完整。');
    }
    const method = view.getUint16(offset + 10, true);
    const flags=view.getUint16(offset+8,true),crc=view.getUint32(offset+16,true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd + extraLength + commentLength > directoryEnd || localOffset>=directoryStart || [compressedSize,uncompressedSize,localOffset].includes(0xffffffff)) {
      throw new FileParseError('PPTX 文件条目名称无效。');
    }

    if(flags&0x41)throw new FileParseError('文档已加密，请解除密码保护后重新上传。');
    const name=decoder.decode(bytes.subarray(nameStart,nameEnd));
    if(names.has(name))throw new FileParseError('Office 压缩包包含重复条目，无法可靠解析。');
    names.add(name);
    entries.push({
      name, flags, crc,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  if(offset!==directoryEnd)throw new FileParseError('Office 压缩包中央目录尺寸不一致。');
  return { bytes, view, entries, directoryStart };
}

function readZipEntry(zip, entry) {
  const { bytes, view } = zip;
  if (entry.uncompressedSize > MAX_PPTX_ENTRY_BYTES) {
    throw new FileParseError('PPTX 中单个幻灯片内容过大，已停止解析。');
  }
  if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    throw new FileParseError('PPTX 文件本地条目无效。');
  }

  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.directoryStart || dataStart>zip.directoryStart) {
    throw new FileParseError('PPTX 文件内容不完整。');
  }
  if(view.getUint16(entry.localOffset+8,true)!==entry.method || view.getUint16(entry.localOffset+6,true)!==entry.flags || new TextDecoder().decode(bytes.subarray(entry.localOffset+30,entry.localOffset+30+nameLength))!==entry.name)throw new FileParseError('Office 压缩包本地条目与目录不一致。');

  const compressed = bytes.subarray(dataStart, dataEnd);
  let content;
  if (entry.method === 0) {
    if(entry.compressedSize!==entry.uncompressedSize || entry.compressedSize>MAX_PPTX_ENTRY_BYTES)throw new FileParseError('Office 正文条目尺寸不一致或内容过大。');
    content=Buffer.from(compressed);
  } else if (entry.method === 8) {
    try {
      content=inflateRawSync(compressed, { maxOutputLength: MAX_PPTX_ENTRY_BYTES });
    } catch {
      throw new FileParseError('PPTX 幻灯片内容解压失败。');
    }
  } else throw new FileParseError('Office 文档使用了暂不支持的压缩方式。');
  if(content.length!==entry.uncompressedSize || crc32(content)!==entry.crc)throw new FileParseError('文档正文尺寸或校验值不一致，文件可能损坏。');
  return content;
}

function readXml(zip,entry){
  let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(readZipEntry(zip,entry));}catch(error){if(error instanceof FileParseError)throw error;throw new FileParseError('文档正文编码无效，请另存为标准 DOCX/PPTX。');}
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new FileParseError('文档正文包含不支持的 XML 实体声明。');
  return xml;
}

function inlineText(xml){
  return [...xml.matchAll(/<(a|m|w):t(?:\s[^>]*)?>([\s\S]*?)<\/\1:t>|<(a|w):(br|cr|tab)\b[^>]*>/g)].map(token=>token[2]!==undefined?decodeXmlText(token[2]):token[4]==='tab'?'\t':'\n').join('');
}
function extractParagraphsFromSlideXml(xml) {
  const paragraphs = [];
  const paragraphPattern = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
  let paragraphMatch;

  while ((paragraphMatch = paragraphPattern.exec(xml))) {
    const line = inlineText(paragraphMatch[1]).trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs;
}

export function extractPptxText(buffer) {
  const zip = findZipEntries(buffer);
  const slideEntries = zip.entries
    .map((entry) => {
      const match = entry.name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      return match ? { ...entry, number: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);

  if (!slideEntries.length) {
    throw new FileParseError('文件中没有找到可读取的 PPTX 幻灯片。');
  }

  let totalXmlBytes = 0;
  const slides = [];
  const numbers=new Set();
  for (const entry of slideEntries) {
    if(numbers.has(entry.number))throw new FileParseError('PPTX 中存在重复的幻灯片页号。');
    numbers.add(entry.number);
    totalXmlBytes += entry.uncompressedSize;
    if (totalXmlBytes > MAX_PPTX_XML_BYTES) {
      throw new FileParseError('PPTX 解压后的文本内容过大，已停止解析。');
    }
    const xml = readXml(zip,entry);
    const paragraphs = extractParagraphsFromSlideXml(xml);
    if (paragraphs.length) {
      slides.push(`[第${entry.number}页]\n${paragraphs.join('\n')}`);
    }
  }

  if (!slides.length) {
    throw new FileParseError('PPTX 中没有检测到可提取的文字，图片中的文字暂不支持识别。');
  }
  return limitExtractedText(slides.join('\n\n'));
}

export async function extractUploadedFile(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new FileParseError('上传文件为空。', 400, 'EMPTY_FILE');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new FileParseError('文件超过 15 MB 上传限制。', 413, 'FILE_TOO_LARGE');
  }

  const safeName = path.basename(String(fileName || ''));
  const extension = path.extname(safeName).toLowerCase();
  let result;

  if (extension === '.pptx') {
    result = extractPptxText(buffer);
  } else if (extension === '.docx') {
    const zip = findZipEntries(buffer);
    const entry = zip.entries.find(e => e.name === 'word/document.xml');
    if (!entry) throw new FileParseError('DOCX 正文不存在，文件可能损坏。');
    const xml = readXml(zip,entry);
    const paragraphs = [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(p => inlineText(p[0]));
    result = limitExtractedText(paragraphs.join('\n'));
    if (!result.content) throw new FileParseError('DOCX 没有可提取文字，暂不支持图片文字识别。');
  } else if (extension === '.txt' || extension === '.md') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new FileParseError('文本编码不支持，请另存为 UTF-8。'); }
    if(/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))throw new FileParseError('文件包含二进制或控制字符，请上传真正的 UTF-8 文本。');
    result=limitExtractedText(text);
    if (!result.content) throw new FileParseError('文件中没有有效文本。');
  } else if (extension === '.ppt') {
    throw new FileParseError(
      '旧版 .ppt 二进制格式暂不支持，请使用 PowerPoint 或 WPS 另存为 .pptx 后上传。',
      415,
      'LEGACY_PPT_UNSUPPORTED',
    );
  } else {
    throw new FileParseError('仅支持 TXT、MD、DOCX、PPTX；不能通过修改扩展名转换格式。', 415, 'UNSUPPORTED_FILE_TYPE');
  }

  return {
    name: safeName,
    type: extension.slice(1),
    content: result.content,
    characters: result.content.length,
    truncated: result.truncated,
    originalCharacters:result.originalCharacters,
  };
}
