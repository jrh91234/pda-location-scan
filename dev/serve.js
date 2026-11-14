// เซิร์ฟเวอร์ทดสอบบนเครื่อง: เสิร์ฟหน้าเว็บ (เหมือน GitHub Pages) + จำลอง Apps Script (appscript/code.gs) ในเบราว์เซอร์
// รัน:  node dev/serve.js  แล้วเปิด http://localhost:5179
// ทดสอบการสแกนโดยไม่มีเครื่อง: พิมพ์ในช่องสแกนแล้วกด Enter (เหมือน DataWedge)
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 5179;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.gs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const MOCK = `<script src="/dev/gas-mock.js"></script>
<script src="/appscript/code.gs"></script>`;

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  let body = fs.readFileSync(file);
  if (url === '/index.html') {
    body = body.toString('utf8')
      .replace(/<script src="js\/config\.js[^"]*"><\/script>/, (tag) => MOCK + '\n' + tag + '<script>PDA_CONFIG.API_URL = MOCK_API_URL;</script>')
      .replace('</body>', '<button onclick="gasMockReset()" style="position:fixed;right:6px;bottom:6px;z-index:99;font-size:11px;opacity:.5">reset mock</button></body>');
  }
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(PORT, () => console.log('PDA Scan mock at http://localhost:' + PORT));
