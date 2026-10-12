// Web 服务入口：托管静态页面，并提供教学资源与课堂音频接口。
// 互动候选的运行校验使用已安装的 Playwright 与本机 Chrome。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMaterialsWithLLM, generateOutlineWithLLM } from './src/llm.js';
import { extractUploadedFile, FileParseError, MAX_UPLOAD_BYTES } from './src/fileParser.js';
import { createApi, json } from './src/api.js';
import { stopSpeechWorkers } from './src/speech.js';
import { ModelSettings } from './src/modelSettings.js';

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
const LLM_RATE_LIMIT_MAX = Math.max(1, Number(process.env.LLM_RATE_LIMIT) || 10);
const FILE_PARSE_RATE_LIMIT_MAX = Math.max(1, Number(process.env.FILE_PARSE_RATE_LIMIT) || 30);
const requestBuckets = new Map();
const modelSettings = new ModelSettings(process.env.DATA_DIR || path.join(ROOT, 'data'));

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
  const shared = new Set(['pptExport.js', 'pptGenerator.js', 'codeBlock.js', 'review.js', 'interactive.js', 'docxReader.js', 'frontier.js', 'analyzer.js', 'uploadPolicy.js','classroomShared.js']);
  if (!(relative.startsWith('public/') && !relative.split('/').some(p => p.startsWith('.') || p === '..'))
      && !(relative.startsWith('src/') && shared.has(relative.slice(4)))) return null;
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
    const chunks = [];let bytes=0,tooLarge=false;
    req.on('data', (chunk) => {
      bytes+=chunk.length;
      if(bytes>5*1024*1024){tooLarge=true;return;}
      chunks.push(chunk);
    });
    req.on('end', () => {
      if(tooLarge){reject(new Error('请求体过大。'));return;}
      try {
        const data=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// 读取 PPTX 二进制请求体。限制原始文件大小，防止大文件耗尽服务端内存。
function readBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      req.resume();
      reject(new FileParseError('文件超过 15 MB 上传限制。', 413, 'FILE_TOO_LARGE'));
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new FileParseError('文件超过 15 MB 上传限制。', 413, 'FILE_TOO_LARGE'));
        return;
      }
      resolve(Buffer.concat(chunks));
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

function isValidMaterials(materials) {
  if (!Array.isArray(materials) || materials.length === 0 || materials.length > 20) return false;
  let totalLength = 0;
  for (const item of materials) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.type !== 'string' || item.type.length > 100) return false;
    if (typeof item.title !== 'string' || item.title.length > 255) return false;
    if (typeof item.content !== 'string' || !item.content.trim() || item.content.length > 250000) return false;
    totalLength += item.content.length;
    if (totalLength > 500000) return false;
  }
  return true;
}

function isRateLimited(req, scope, maxRequests) {
  const now = Date.now();
  const client = `${scope}:${req.socket.remoteAddress || 'unknown'}`;
  const recent = (requestBuckets.get(client) || []).filter(
    (time) => now - time < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= maxRequests) {
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
    const result = await generateOutlineWithLLM(analysis, supplements, await modelSettings.read());
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('生成 PPT 大纲失败：', error);
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: 'PPT 大纲生成失败，请稍后重试。' }));
  }
}

// 处理 POST /api/analyze-materials：让大模型从原始资料中提取结构化教学内容。
async function handleAnalyzeMaterials(req, res) {
  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '请求体不是有效的 JSON。' }));
    return;
  }

  const materials = body && body.materials;
  if (!isValidMaterials(materials)) {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '教学资料参数格式不正确或内容过长。' }));
    return;
  }

  try {
    const result = await analyzeMaterialsWithLLM(materials, await modelSettings.read());
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('AI 内容理解失败：', error);
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: '内容理解失败，请稍后重试。' }));
  }
}

// 处理 POST /api/extract-file：在后端安全提取 PPTX 中的文本。
async function handleExtractFile(req, res, requestUrl) {
  const jsonHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
  const fileName = requestUrl.searchParams.get('name') || '';
  if (!fileName || fileName.length > 255) {
    res.writeHead(400, jsonHeaders);
    res.end(JSON.stringify({ error: '请提供有效的文件名。' }));
    return;
  }

  try {
    const buffer = await readBinaryBody(req);
    const result = await extractUploadedFile(buffer, fileName);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(result));
  } catch (error) {
    if (error instanceof FileParseError) {
      res.writeHead(error.statusCode, jsonHeaders);
      res.end(JSON.stringify({ error: error.message, code: error.code }));
      return;
    }
    console.error('解析上传文件失败：', error);
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: '文件解析失败，请稍后重试。' }));
  }
}

const api = createApi(ROOT, { modelSettings });
export const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const requestUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && (['/api/workspace/chat', '/api/workspace/agent', '/api/classroom/analyze','/api/classroom/chat', '/api/model-settings/test'].includes(requestUrl.pathname) || /\/api\/workspace\/agent\/[a-f0-9-]+\/resume$/.test(requestUrl.pathname)) && isRateLimited(req, 'llm', LLM_RATE_LIMIT_MAX)) {
    json(res, { error: '模型请求过于频繁，请一分钟后重试。' }, 429); return;
  }

  try {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      json(res, { error: '拒绝外部来源请求。' }, 403); return;
    }
    if (await api(req, res, requestUrl)) return;
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message || '保存或处理失败，请重试。' }, error.statusCode || 500);
    else res.end();
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/extract-file') {
    if (isRateLimited(req, 'file', FILE_PARSE_RATE_LIMIT_MAX)) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60',
      });
      res.end(JSON.stringify({ error: '文件解析请求过于频繁，请稍后重试。' }));
      return;
    }
    handleExtractFile(req, res, requestUrl);
    return;
  }

  // 新增：AI 生成 PPT 大纲接口（接大模型 API，人机协同编码）。
  if (req.method === 'POST' && requestUrl.pathname === '/api/analyze-materials') {
    if (isRateLimited(req, 'llm', LLM_RATE_LIMIT_MAX)) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60',
      });
      res.end(JSON.stringify({ error: 'AI 内容理解请求过于频繁，请稍后重试。' }));
      return;
    }
    handleAnalyzeMaterials(req, res);
    return;
  }

  // AI 生成 PPT 大纲接口（与内容理解共用每分钟调用上限）。
  if (req.method === 'POST' && requestUrl.pathname === '/api/generate-outline') {
    if (isRateLimited(req, 'llm', LLM_RATE_LIMIT_MAX)) {
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

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
    stopSpeechWorkers(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref();
  });
  server.listen(PORT, HOST, () => {
    console.log(`课堂质量改进智能体已启动：http://${HOST}:${PORT}`);
  });
}
