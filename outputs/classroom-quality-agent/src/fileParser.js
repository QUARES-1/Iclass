// PowerPoint 教学资料解析模块。
// PPTX 本质是 ZIP 压缩包，这里直接读取其中的幻灯片 XML，
// 避免把二进制文件交给浏览器当作普通文本读取。

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 250_000;

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
    return { content: normalized, truncated: false };
  }
  return {
    content: normalized.slice(0, MAX_EXTRACTED_CHARACTERS).trimEnd()
      + '\n\n[内容过长，系统仅保留前 250000 个字符]',
    truncated: true,
  };
}

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
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
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new FileParseError('PPTX 文件结构无效或文件已经损坏。');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const entries = [];

  if (entryCount > 5000) {
    throw new FileParseError('PPTX 文件包含过多内部条目，无法安全解析。');
  }

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new FileParseError('PPTX 文件中央目录不完整。');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > bytes.length) {
      throw new FileParseError('PPTX 文件条目名称无效。');
    }

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameEnd)),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return { bytes, view, entries };
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
  if (dataEnd > bytes.length) {
    throw new FileParseError('PPTX 文件内容不完整。');
  }

  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: MAX_PPTX_ENTRY_BYTES });
    } catch {
      throw new FileParseError('PPTX 幻灯片内容解压失败。');
    }
  }
  throw new FileParseError('PPTX 使用了暂不支持的压缩方式。');
}

function extractParagraphsFromSlideXml(xml) {
  const paragraphs = [];
  const paragraphPattern = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi;
  let paragraphMatch;

  while ((paragraphMatch = paragraphPattern.exec(xml))) {
    const parts = [];
    const textPattern = /<(?:a|m):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|m):t>/gi;
    let textMatch;
    while ((textMatch = textPattern.exec(paragraphMatch[1]))) {
      parts.push(decodeXmlText(textMatch[1]));
    }
    const line = parts.join('').trim();
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
  for (const entry of slideEntries) {
    totalXmlBytes += entry.uncompressedSize;
    if (totalXmlBytes > MAX_PPTX_XML_BYTES) {
      throw new FileParseError('PPTX 解压后的文本内容过大，已停止解析。');
    }
    const xml = readZipEntry(zip, entry).toString('utf8');
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
  } else if (extension === '.ppt') {
    throw new FileParseError(
      '旧版 .ppt 二进制格式暂不支持，请使用 PowerPoint 或 WPS 另存为 .pptx 后上传。',
      415,
      'LEGACY_PPT_UNSUPPORTED',
    );
  } else {
    throw new FileParseError('仅支持解析 PPTX 文件。', 415, 'UNSUPPORTED_FILE_TYPE');
  }

  return {
    name: safeName,
    type: extension.slice(1),
    content: result.content,
    characters: result.content.length,
    truncated: result.truncated,
  };
}
