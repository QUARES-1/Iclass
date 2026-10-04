// 极简静态文件服务器：让网页版原型可以通过 `npm start` 一键运行。
// 仅使用 Node.js 内置模块，无需安装任何第三方依赖，便于课程答辩现场演示。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOutlineWithLLM } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;

// 常用文件类型到 Content-Type 的映射，避免浏览器把 JS/CSS 当作文本误读。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// 将 URL 安全地映射为本地文件路径，并阻止路径穿越（path traversal）攻击。
function resolvePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // 非法百分号编码的 URL 直接拒绝，避免 decodeURIComponent 抛异常导致服务器崩溃。
    return null;
  }
  const relative = pathname === '/' ? 'public/home.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(ROOT, relative);
  // 解析后的路径必须仍然位于项目根目录之内。
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) {
    return null;
  }
  return absolute;
}

// 读取 JSON 请求体（限制大小，避免恶意超大请求）。
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('请求体过大。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// 处理 POST /api/generate-outline：调用大模型生成 PPT 大纲。
async function handleGenerateOutline(req, res) {
  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '请求体不是有效的 JSON。' }));
    return;
  }

  const { analysis, supplements, config } = body || {};
  if (!analysis || !Array.isArray(analysis.knowledgePoints)) {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '缺少有效的 analysis 参数。' }));
    return;
  }

  try {
    const result = await generateOutlineWithLLM(analysis, supplements || [], config || {});
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: (error && error.message) || '生成失败。' }));
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // 新增：AI 生成 PPT 大纲接口（接大模型 API，人机协同编码）。
  if (req.method === 'POST' && url === '/api/generate-outline') {
    handleGenerateOutline(req, res);
    return;
  }

  // 站点入口：根路径到首页；/index.html 兼容旧入口，跳到 Sprint 1。
  if (url === '/') {
    res.writeHead(302, { Location: '/public/home.html' });
    res.end();
    return;
  }
  if (url === '/index.html') {
    res.writeHead(302, { Location: '/public/index.html' });
    res.end();
    return;
  }

  const filePath = resolvePath(url);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // 正确处理 HEAD 请求：只返回响应头，不发送响应体。
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`课堂质量改进智能体已启动：http://localhost:${PORT}`);
});
