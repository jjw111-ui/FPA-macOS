import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { wardrobeStudioApi } from './studio-api.mjs';

const HOST = '127.0.0.1';
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

const COMPRESSIBLE = new Set(['.css', '.html', '.js', '.json', '.svg', '.webmanifest']);

async function sendFile(req, res, filename, cache = false) {
  const metadata = await stat(filename);
  if (!metadata.isFile()) return false;
  const ext = path.extname(filename).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', cache ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') { res.setHeader('Content-Length', metadata.size); return res.end(), true; }
  const useGzip = COMPRESSIBLE.has(ext) && (req.headers['accept-encoding'] || '').includes('gzip');
  if (useGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    createReadStream(filename).pipe(createGzip()).pipe(res);
  } else {
    res.setHeader('Content-Length', metadata.size);
    createReadStream(filename).pipe(res);
  }
  return true;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function listenAvailable(server, preferredPort) {
  for (let port = preferredPort; port < preferredPort + 50; port++) {
    const result = await new Promise(resolve => {
      const onError = error => {
        server.off('listening', onListening);
        resolve(error.code === 'EADDRINUSE' ? false : error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    });
    if (result === true) return port;
    if (result instanceof Error) throw result;
  }
  throw new Error(`端口 ${preferredPort}-${preferredPort + 49} 均被占用。`);
}

export async function startPortableServer(options = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(options.appRoot || path.join(scriptDir, '..'));
  const distDir = path.resolve(options.distDir || path.join(appRoot, 'dist'));
  const portableData = path.basename(appRoot).toLowerCase() === 'app'
    ? path.join(appRoot, '..', 'data')
    : path.join(appRoot, 'data');
  const dataDir = path.resolve(options.dataDir || portableData);
  await access(path.join(distDir, 'index.html'));

  const plugin = wardrobeStudioApi({
    env: { ...process.env, WARDROBE_DATA_DIR: dataDir },
    ...(options.imageEdit ? { imageEdit: options.imageEdit } : {}),
    ...(Object.hasOwn(options, 'designConfigImportPath') ? { designConfigImportPath: options.designConfigImportPath } : {}),
    ...(options.designFetch ? { designFetch: options.designFetch } : {}),
    ...(Object.hasOwn(options, 'designGenerationConfigImportPath') ? { designGenerationConfigImportPath: options.designGenerationConfigImportPath } : {}),
    ...(options.designGenerationFetch ? { designGenerationFetch: options.designGenerationFetch } : {}),
    ...(options.designImageEdit ? { designImageEdit: options.designImageEdit } : {}),
  });
  await plugin.configResolved({ root: appRoot });
  let studioHandler;
  plugin.configureServer({ middlewares: { use(handler) { studioHandler = handler; } } });

  const fallback = async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: '不支持该请求方式。' }));
    }
    const url = new URL(req.url, 'http://localhost');
    const legacy = url.pathname.match(/^\/api\/import\/library\/([\w.-]+\.png)$/i);
    if (legacy) {
      try { return await sendFile(req, res, path.join(dataDir, 'imported', legacy[1]), true); }
      catch { res.statusCode = 404; return res.end('Not found'); }
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { res.statusCode = 400; return res.end('Bad request'); }
    const requested = path.resolve(distDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!inside(distDir, requested)) { res.statusCode = 403; return res.end('Forbidden'); }
    try {
      if (await sendFile(req, res, requested, pathname.startsWith('/assets/'))) return;
    } catch { /* SPA fallback below. */ }
    try { await sendFile(req, res, path.join(distDir, 'index.html')); }
    catch { res.statusCode = 500; res.end('FPA build is missing.'); }
  };

  const server = createServer((req, res) => {
    Promise.resolve(studioHandler(req, res, () => fallback(req, res))).catch(error => {
      if (res.headersSent) return res.destroy(error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: '本地服务发生错误。' }));
    });
  });
  const port = await listenAvailable(server, Number(options.port) || 5173);
  const url = `http://${HOST}:${port}/`;
  return { server, url, port, appRoot, dataDir };
}

async function main() {
  const args = process.argv.slice(2);
  const preferredPort = Number(flag(args, '--port', '5173'));
  const dataDir = flag(args, '--data-dir');
  const result = await startPortableServer({ port: preferredPort, dataDir });
  console.log('');
  console.log(`FPA 已启动：${result.url}`);
  console.log(`本地数据：${result.dataDir}`);
  console.log('关闭此窗口即可停止应用。');
  if (args.includes('--open')) openBrowser(result.url);
  const shutdown = () => result.server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`FPA 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
