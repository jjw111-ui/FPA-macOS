import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || path.join(root, 'vendor/weebpaint/weebpaint-v0.12.31.html');
const destination = path.join(root, 'public/design-workbench/full-paint.html');
const original = fs.readFileSync(source, 'utf8');
const license = fs.readFileSync(path.join(root, 'vendor/weebpaint/LICENSE'), 'utf8');
let html = original;
function replaceOnce(from, to) {
  if (html.split(from).length !== 2) throw new Error(`Expected one upstream anchor: ${from.slice(0, 100)}`);
  html = html.replace(from, () => to);
}

// Change storage identifiers only. ORA's upstream XML and archive names stay compatible.
html = html.replaceAll('weebpaint-bd6cece69075d759', 'fpa-full-paint-v1')
  .replaceAll('weebpaint.boot.', 'fpa-full-paint-v1.boot.')
  .replaceAll('weebpaint-doc:', 'fpa-full-paint-v1-doc:')
  .replaceAll('weebpaint.storage-probe', 'fpa-full-paint-v1.storage-probe')
  .replaceAll('weebpaint.nostore', 'fpa-full-paint-v1.nostore')
  .replaceAll('"weebpaint"', '"fpa-full-paint"');
replaceOnce('<html lang="en" data-theme="auto">', '<html lang="zh-CN" data-theme="day" data-fpa-paint="full">');
replaceOnce('<title>WeebPaint — free drawing app for iPad, PC &amp; phone</title>', '<title>FPA - WeebPaint</title>');
replaceOnce('\n  <head>\n    <meta charset="UTF-8" />', `\n  <head>\n    <meta charset="UTF-8" />\n<!-- WeebPaint by fangzhangmnm: https://github.com/fangzhangmnm/weebpaint\nUpstream standalone SHA-256: ${createHash('sha256').update(original).digest('hex')}\nThe complete upstream drawing engine and attribution are retained.\n${license}\n-->\n<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'none'">`);
replaceOnce('function H3(){return NC()??jC(DC("lang"))??OC()}', 'function H3(){return NC()??jC(DC("lang"))??"zh"}');
replaceOnce('function GC(){let t=NC();W0("lang",t),(t??OC())!==On()&&location.reload()}', 'function GC(){let t=NC();W0("lang",t);if(t&&t!==On())location.reload()}');

// A mouse has no pressure sensor. Upstream's synthetic half-pressure reduces
// opacity even with the dial at 100% (e.g. black becomes RGB 76 on white).
// Use full pressure for mouse strokes; leave tablet pressure and smoothing intact.
replaceOnce('function HP(t,e,n,r,o){let i;if(e==="mouse")i=.5;',
  'function HP(t,e,n,r,o){let i;if(e==="mouse")i=1;');

// The embedding host restores the selected source explicitly, avoiding startup races.
replaceOnce('B3.then(()=>M3(Gt))', 'B3.then(()=>{we.beginTransientBlank();return Cm(false)})');
replaceOnce('P3(Gt);{let t=io();', '/* FPA restores its own draft; native crash records remain isolated. */{let t=io();');
const updaterStart = html.indexOf('new d0({showUpdateNotice:');
const updaterEnd = html.indexOf('var wY=6e4;', updaterStart);
if (updaterStart < 0 || updaterEnd < 0) throw new Error('Upstream updater anchor missing');
html = html.slice(0, updaterStart) + '/* The FPA host owns service workers and app updates. */' + html.slice(updaterEnd);
// Upstream's PWA recovery button clears the entire origin. An embedded editor
// must only clear its own caches and must never unregister the FPA host worker.
replaceOnce('if(navigator.serviceWorker){let o=await navigator.serviceWorker.getRegistrations();for(let i of o)await i.unregister().catch(()=>{})}if(typeof caches<"u"){let o=await caches.keys();for(let i of o)await caches.delete(i).catch(()=>{})}',
  'if(typeof caches<"u"){let o=await caches.keys();for(let i of o)if(i.startsWith("fpa-full-paint"))await caches.delete(i).catch(()=>{})}');
// Language changes and native reset actions must let the host persist the current
// ORA before recreating the frame. A direct reload would orphan its in-memory API.
html = html.replaceAll('location.reload()', 'window.FpaFullPaint?.requestReload()');

const modules = [...html.matchAll(/<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)];
const engine = modules.find(match => match[1].includes('var Lm=Py.blank'));
if (!engine) throw new Error('Complete upstream drawing engine module missing');
const bridge = fs.readFileSync(path.join(root, 'public/design-workbench/full-paint-bridge.js'), 'utf8');
replaceOnce(engine[0], engine[0].replace('</script>', () => `\n${bridge}\n</script>`));
replaceOnce('\n  </head>', '\n<link rel="stylesheet" href="./full-paint-theme.css">\n  </head>');
replaceOnce('\n  </body>', '\n<script src="./full-paint-chrome.js" defer></script>\n  </body>');
fs.writeFileSync(destination, html);
console.log(`Built complete WeebPaint engine (${Buffer.byteLength(html)} bytes): ${destination}`);
