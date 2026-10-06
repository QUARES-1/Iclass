// Web 服务入口：托管静态页面，并提供安全的后端 LLM 大纲生成接口。
// 仅使用 Node.js 内置模块，无需安装第三方依赖。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOutlineWithLLM } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// 本地开发时从项目根目录的 .env 加载密钥；生产环境仍应优先使用部署平台环境变量。
// .env 被 .gitignore 排除，不会进入版本库。Node.js 20.12+ 提供 loadEnvFile。
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    console.warn('读取 .env 失败：' + error.message);
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Math.max(1, Number(process.env.LLM_RATE_LIMIT) || 10);
const requestBuckets = new Map();

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

function isStringArray(value, maxItems = 200) {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length <= 5000);
}

function isValidAnalysis(analysis) {
  return analysis
    && typeof analysis === 'object'
    && isStringArray(analysis.chapters, 50)
    && isStringArray(analysis.objectives, 100)
    && isStringArray(analysis.knowledgePoints, 200)
    && isStringArray(analysis.keyPoints, 100)
    && isStringArray(analysis.difficultPoints, 100);
}

function isValidSupplements(supplements) {
  return Array.isArray(supplements)
    && supplements.length <= 100
    && supplements.every((item) => item && typeof item === 'object');
}

function isRateLimited(req) {
  const now = Date.now();
  const client = req.socket.remoteAddress || 'unknown';
  const recent = (requestBuckets.get(client) || []).filter(
    (time) => now - time < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    requestBuckets.set(client, recent);
    return true;
  }
  recent.push(now);
  requestBuckets.set(client, recent);
  return false;
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

  const { analysis, supplements = [] } = body || {};
  if (!isValidAnalysis(analysis) || !isValidSupplements(supplements)) {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '教学内容参数格式不正确。' }));
    return;
  }

  try {
    const result = await generateOutlineWithLLM(analysis, supplements);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('生成 PPT 大纲失败：', error);
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: 'PPT 大纲生成失败，请稍后重试。' }));
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // 新增：AI 生成 PPT 大纲接口（接大模型 API，人机协同编码）。
  if (req.method === 'POST' && url === '/api/generate-outline') {
    if (isRateLimited(req)) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60',
      });
      res.end(JSON.stringify({ error: '请求过于频繁，请稍后重试。' }));
      return;
    }
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

server.on('error', (error) => {
  console.error('服务器启动失败：' + ((error && error.message) || error));
});

server.listen(PORT, HOST, () => {
  console.log(`课堂质量改进智能体已启动：http://${HOST}:${PORT}`);
});
