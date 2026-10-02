// Local dashboard server — http://127.0.0.1:8765
// Serves ONLY the dashboard/ folder and screenshots (.png) from output/.
// Application data comes from the helper service (127.0.0.1:9999), never from project files,
// so .env, profile.json and CVs are not reachable from the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const ROOT = path.join(__dirname, '..');
const DASHBOARD_DIR = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function resolve(urlPath) {
  if (urlPath === '/') return path.join(DASHBOARD_DIR, 'local.html');
  if (urlPath.startsWith('/dashboard/')) return path.join(DASHBOARD_DIR, urlPath.slice('/dashboard/'.length));
  if (urlPath.startsWith('/output/') && urlPath.toLowerCase().endsWith('.png')) return path.join(OUTPUT_DIR, urlPath.slice('/output/'.length));
  return null;
}

http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) { res.writeHead(400); return res.end(); }
  const filePath = resolve(urlPath);
  const allowedBase = filePath && (filePath.startsWith(DASHBOARD_DIR + path.sep) || filePath.startsWith(OUTPUT_DIR + path.sep));
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  if (!allowedBase || !MIME[ext] || ext === '.cjs') { res.writeHead(404); return res.end('Not found'); }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] Dashboard: http://127.0.0.1:${PORT}/`);
});

process.on('uncaughtException', e => console.error('CRASH:', e.message));
