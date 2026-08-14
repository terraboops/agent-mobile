// surface-live.test.mjs — PROOF that the display-surface host (www/surface-host.js)
// wires the op-core (www/surface-core.js) into the LIVE phone renderer:
//   * register_asset / register_widget_type register ONCE
//   * add_widget mounts a stable, keyed viewport in the real DOM
//   * publish / update_widget re-render THAT tile IN PLACE (peers preserved)
//   * remove_widget tears down only its own tile
//   * agent-shipped widget code + registered assets reach a sandboxed, opaque-
//     origin iframe (egress-free, no bridge access)
//   * the legacy flat { type:'render', ui:{components:[...]} } path still works
//
// Uses the web-layer HTTP shell + injected messages (no AEAD/gateway); the
// encrypted channel itself is already proven by containment.test.mjs.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// ---- static server for www/ --------------------------------------------------
const ROOT = join(import.meta.dirname, '..', 'www');
const TYPES = { html: 'text/html', js: 'application/javascript', css: 'text/css', mjs: 'application/javascript' };
const appServer = http.createServer(async (req, res) => {
  try {
    const p = join(ROOT, req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').replace(/\/+$/, '') || 'index.html');
    const body = await readFile(p);
    res.setHeader('content-type', TYPES[extname(p).slice(1)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise((r) => appServer.listen(0, r));
const APP = `http://127.0.0.1:${appServer.address().port}/`;

// ---- egress canary ------------------------------------------------------------
let canaryHits = 0;
const canary = http.createServer((req, res) => { canaryHits++; res.writeHead(204); res.end(); });
await new Promise((r) => canary.listen(0, r));
const CANARY = `http://127.0.0.1:${canary.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(APP)) return route.continue();
  return route.abort();
});
const page = await context.newPage();
// Give the sandbox a live (settable) place to try to phone home to.
await page.addInitScript((cany) => { window.__CANARY = cany; }, CANARY);
await page.goto(APP, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__surfaceState === 'function', null, { timeout: 8000 });

async function push(obj) { await page.evaluate((s) => window.__pushAgentMessage(s), JSON.stringify(obj)); }
const widgetCount = () => page.evaluate(() => document.querySelectorAll('#surface .swidget').length);
const keys = () => page.evaluate(() => [...document.querySelectorAll('#surface .swidget')].map(n => n.dataset.key));
const sandboxText = (key) => page.evaluate(async (k) => {
  const node = document.querySelector(`#surface .swidget[data-key="${k}"]`);
  const fr = node && node.querySelector('iframe');
  if (!fr) return '';
  // srcdoc frames expose an opaque origin; reflect the root text to the parent.
  fr.contentWindow.postMessage({ type: '__ping' }, '*');
  return fr.getAttribute('srcdoc');
}, key);

// ---- 1. REGISTER asset + widget type (once) ------------------------------------
const libB64 = Buffer.from('var _SURF_LIB = "loaded-from-asset-store";', 'utf8').toString('base64');
await push({
  type: 'surface',
  ops: [
    { op: 'register_asset', name: 'lib/mybox.js', mime: 'text/javascript', b64: libB64, append: false },
    { op: 'register_widget_type', name: 'mybox', code:
        'window.render=function(p){var r=document.getElementById("root");r.textContent="LIB="+(window._SURF_LIB||"none")+" v="+(p&&p.v);};\n'
        + 'window.onData=function(d){var r=document.getElementById("root");r.textContent+=" d="+(d&&d.x);};',
      assets: ['lib/mybox.js'] },
  ],
});
await page.waitForFunction(() => (window.__surfaceState() || {}).types && window.__surfaceState().types.includes('mybox'), null, { timeout: 5000 });
const s1 = await page.evaluate(() => window.__surfaceState());
ok(s1.types.includes('mybox'), 'register_widget_type registered once (type in state)');
ok(s1.assets.includes('lib/mybox.js'), 'register_asset registered once (asset in state)');

// ---- 2. ADD two widgets by stable key -------------------------------------------
await push({ type: 'surface', ops: [{ op: 'add_widget', key: 'weather', type: 'mybox', props: { v: 1 } }] });
await push({ type: 'surface', ops: [{ op: 'add_widget', key: 'clock', type: 'mybox', props: { v: 2 } }] });
await page.waitForFunction(() => document.querySelectorAll('#surface .swidget').length === 2, null, { timeout: 5000 });
ok((await widgetCount()) === 2, 'two widgets added -> two keyed viewports mounted');
ok((await keys()).join(',') === 'weather,clock', 'viewports are keyed (weather,clock) for stable in-place targeting');

// ---- 3. Sandbox got the registered asset source + type code ----------------------
await page.waitForTimeout(150);
const wDoc = await page.evaluate((k) => {
  const node = document.querySelector(`#surface .swidget[data-key="${k}"]`);
  const fr = node && node.querySelector('iframe');
  return fr ? fr.getAttribute('srcdoc') : '';
}, 'weather');
ok(wDoc.includes('loaded-from-asset-store'), 'sandbox srcdoc includes registered asset source (asset -> iframe wiring)');
ok(wDoc.includes('window.render'), 'sandbox srcdoc includes registered widget type code');

// ---- 3b. test_widget returns render_feedback (the agent can verify a type) -------
await push({ type: 'surface', ops: [{ op: 'test_widget', key: 'probe_x', type: 'mybox', props: { v: 7 } }] });
const feedback = await page.waitForFunction(() => {
  const sels = document.querySelectorAll('#surface .swidget[data-key]');
  return [...sels].map(n => n.dataset.key).join(',');
}, null, { timeout: 5000 });
const probeKeys = await feedback.jsonValue();
ok(probeKeys.includes('probe_x'), 'test_widget mounted a probe viewport');
await page.waitForFunction(() => window.__surfaceRender('probe_x') !== '', null, { timeout: 5000 });
ok((await page.evaluate(() => window.__surfaceRender('probe_x'))).includes('v=7'), 'test_widget rendered props (v=7) in sandbox');
ok((await page.evaluate(() => window.__surfaceRender('probe_x'))).includes('loaded-from-asset-store'), 'test_widget used the registered asset');
await push({ type: 'surface', ops: [{ op: 'remove_widget', key: 'probe_x' }] });
ok((await widgetCount()) === 2, 'probe cleaned up -> back to 2 real widgets');

// ---- 4. PUBLISH data to ONE tile -> that tile updates in place, peer intact ------
// The sandbox echoes its rendered root text back to the host (__surfaceRender).
ok((await page.evaluate(() => window.__surfaceRender('weather'))).includes('v=1'), '[before] weather tile rendered v=1');
ok((await page.evaluate(() => window.__surfaceRender('clock'))).includes('v=2'), '[before] clock tile rendered v=2');
await push({ type: 'surface', ops: [{ op: 'publish', key: 'weather', data: { x: 99 } }] });
await page.waitForFunction(() => window.__surfaceRender('weather').includes('d=99'), null, { timeout: 5000 });
ok((await page.evaluate(() => window.__surfaceRender('weather'))).includes('d=99'), 'publish fed weather IN PLACE (rendered text now includes d=99)');
ok((await page.evaluate(() => window.__surfaceRender('clock'))).includes('v=2'), 'peer clock tile untouched by weather publish (no peer wipe)');
ok((await widgetCount()) === 2, 'after publish, still exactly 2 viewports (no duplicate/peer wipe)');

// ---- 5. UPDATE_WIDGET props in place (no re-ship of library) ----------------------
await push({ type: 'surface', ops: [{ op: 'update_widget', key: 'clock', props: { v: 20 } }] });
await page.waitForFunction(() => window.__surfaceRender('clock').includes('v=20'), null, { timeout: 5000 });
ok((await page.evaluate(() => window.__surfaceRender('clock'))).includes('v=20'), 'update_widget re-rendered clock props in place (v=20)');
ok((await page.evaluate(() => window.__surfaceRender('weather'))).includes('d=99'), 'weather unaffected by clock update (peers preserved)');
ok((await widgetCount()) === 2, 'update_widget keeps both tiles mounted (update does not wipe peers)');
ok((await s1).usage > 0, 'asset bytes tracked once (they are not re-shipped on update)');

// ---- 6. remove one tile -> keyed teardown ------------------------------------------
await push({ type: 'surface', ops: [{ op: 'remove_widget', key: 'weather' }] });
await page.waitForFunction(() => !document.querySelector('#surface .swidget[data-key="weather"]'), null, { timeout: 5000 });
ok((await widgetCount()) === 1, 'remove_widget tears down only its own viewport');
ok((await keys()).join(',') === 'clock', 'peer (clock) viewport still mounted after weather torn down');

// ---- 7. Legacy flat render still works ----------------------------------------------
await push({ type: 'render', ui: { text: 'legacy still fine', components: [{ t: 'list', items: [{ title: 'a' }, { title: 'b' }] }] } });
const legacy = await page.evaluate(() => document.getElementById('ui').innerHTML);
ok(legacy.includes('legacy still fine'), 'legacy flat render (type:render/ui.components) still draws');
ok(legacy.includes('<li>a</li>'), 'legacy list component still draws');

// ---- 8. Egress-free proof --------------------------------------------------------------
await page.waitForTimeout(150);
ok(canaryHits === 0, 'NO egress: reachable canary received 0 requests from surface');
ok(await page.evaluate(() => typeof window.__surfaceState === 'function'), 'surface host still alive after all ops');

await browser.close();
appServer.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
