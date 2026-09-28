// 极简静态文件服务器：让网页版原型可以通过 `npm start` 一键运行。
// 仅使用 Node.js 内置模块，无需安装任何第三方依赖，便于课程答辩现场演示。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const relative = pathname === '/' ? 'public/index.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(ROOT, relative);
  // 解析后的路径必须仍然位于项目根目录之内。
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) {
    return null;
  }
  return absolute;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // 把站点根路径重定向到 public 目录下的入口页，
  // 保证 index.html 中的相对路径（./styles.css、./main.js 等）能正确解析。
  if (url === '/' || url === '/index.html') {
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
  console.log(`课堂质量改进智能体（Sprint 1）已启动：http://localhost:${PORT}`);
});
