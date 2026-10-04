// Word (.docx) 文档读取模块。
// .docx 本质是一个 ZIP 压缩包，正文存放在 word/document.xml 中。
// 这里用浏览器内置的 DecompressionStream 解压、DOMParser 解析 XML，实现零依赖的文本抽取，
// 使“资料上传”环节除了 .txt / .md 之外，也能直接读取 Word 文档。

// 从 ZIP 字节流中读取指定条目的解压后内容（返回 Uint8Array）。
// ZIP 结构：本地文件头(0x04034b50)、中央目录(0x02014b50)、中央目录结束记录 EOCD(0x06054b50)。
async function extractZipEntry(arrayBuffer, entryName) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const decoder = new TextDecoder('utf-8');

  // 从文件末尾向前扫描 EOCD，得到中央目录偏移与条目数量。
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('文件不是有效的 ZIP 压缩包');

  const entryCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));

    if (name === entryName) {
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const compressed = u8.subarray(dataStart, dataStart + compSize);

      if (method === 0) return compressed.slice(); // 未压缩
      if (method === 8) {
        // Deflate（ZIP 中为不带 zlib 头的 raw deflate）。
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([compressed]).stream().pipeThrough(ds);
        const out = await new Response(stream).arrayBuffer();
        return new Uint8Array(out);
      }
      throw new Error('暂不支持该压缩方式：' + method);
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error('在文档中找不到正文条目：' + entryName);
}

// 从 document.xml 中抽取纯文本：按段落（w:p）分组，段落内拼接文本片段（w:t）。
function extractTextFromDocumentXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Word 文档 XML 解析失败');
  }
  const paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'p'));
  const lines = paragraphs.map((paragraph) => {
    const runs = paragraph.getElementsByTagNameNS('*', 't');
    return Array.from(runs)
      .map((run) => run.textContent || '')
      .join('');
  });
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

// 读取 .docx 文件并返回纯文本内容，供“内容理解”模块解析。
export async function readDocxText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const xmlBytes = await extractZipEntry(arrayBuffer, 'word/document.xml');
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
  return extractTextFromDocumentXml(xmlText);
}