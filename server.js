#!/usr/bin/env node
/**
 * 零依赖静态服务器。
 *   npm start            启动并自动打开浏览器
 *   npm start -- --no-open   只启动，不打开浏览器
 *   PORT=6000 npm start  指定端口
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, 'public');
const BASE_PORT = Number(process.env.PORT) || 5188;
const MAX_PORT_TRIES = 25;
const OPEN_BROWSER = !process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // 路径穿越防护：解析后必须仍位于 ROOT 之内
  const target = path.resolve(ROOT, '.' + pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  try {
    const stat = await fsp.stat(target);
    const file = stat.isDirectory() ? path.join(target, 'index.html') : target;
    const data = await fsp.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (req.method === 'HEAD') return send(res, 200, '', { 'Content-Type': type });
    return send(res, 200, data, { 'Content-Type': type });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return send(res, 404, '404 Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 打不开就算了，用户手动访问即可 */
  }
}

function listen(port, attempt = 0) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES) {
      server.removeListener('error', onError);
      return listen(port + 1, attempt + 1);
    }
    console.error('\n  Failed to start:', err.message, '\n');
    process.exit(1);
  };

  server.once('error', onError);
  server.listen(port, () => {
    // 刻意只用 ASCII：Windows 控制台默认不是 UTF-8 代码页，中文和制表符会变成乱码
    const url = `http://localhost:${port}/`;
    const line = '='.repeat(56);
    console.log(`\n  ${line}`);
    console.log('    Chromatic Acuity Test');
    console.log('    color discrimination threshold (CIEDE2000)');
    console.log(`  ${line}`);
    console.log(`    Local:  ${url}`);
    console.log('    Stop:   Ctrl+C');
    console.log(`  ${line}\n`);
    if (OPEN_BROWSER) openBrowser(url);
  });
}

listen(BASE_PORT);
