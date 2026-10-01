import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.cjs': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(root, `.${name}`);
    if (!target.startsWith(root) || name.includes('\\') || name.includes('\0') || name.split('/').some(p => p.startsWith('.'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': name.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://localhost:${port} if this app is already running.` : err);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Pumpkin Studio: http://localhost:${port}\nPress Ctrl+C to stop.`);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process 'http://localhost:${port}'`], { windowsHide: true }, error => {
      if (error) console.error('Open the URL above in your browser.');
    });
  }
});
