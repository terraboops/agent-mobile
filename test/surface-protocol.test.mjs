// surface-protocol.test.mjs — the display-surface OP PROTOCOL, not just its plumbing.
//
// The pre-existing surface tests covered the happy path (assets register, a tile
// mounts). What was never covered — and what actually broke in the field — is the
// protocol's FAILURE behaviour:
//
//   * an op for a key that was never added used to vanish silently, so the agent
//     believed it had rendered while the screen stayed blank and the register ->
//     test -> build feedback loop never fired;
//   * a widget type whose code throws must report ok:false, not fail open;
//   * remove_widget must actually tear the tile down, and later ops against that
//     key must then be reported as unknown.
//
// Each case asserts on the render_result feedback the phone sends UP, because that
// is the only channel by which the agent can learn it was wrong.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const server = createServer((req, res) => {
  const p = join(ROOT, 'www', decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p) || !p.startsWith(join(ROOT, 'www'))) { res.statusCode = 404; return res.end('nope'); }
  res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(`${base}/index.html`);

// Capture everything the surface sends UP to the native side. This is the agent's
// only feedback channel, so the protocol's correctness is observable right here.
await page.evaluate(() => {
  // surface-host.js publishes UP through window.__agent.send and receives ops via
  // the window.__agent.onMessage handler list — intercept the real objects rather
  // than replacing __agent (the host already holds a reference to it).
  window.__sentUp = [];
  const prev = window.__agent && window.__agent.send;
  window.__agent.send = function (o) {
    try { window.__sentUp.push(typeof o === 'string' ? JSON.parse(o) : o); } catch (_) {}
    if (typeof prev === 'function') { try { return prev.apply(this, arguments); } catch (_) {} }
  };
});
await page.waitForTimeout(250);

const feedback = () => page.evaluate(() =>
  (window.__sentUp || []).filter((m) => m && m.type === 'render_result'));
const clearFeedback = () => page.evaluate(() => { window.__sentUp = []; });

// Drive the host exactly as the sidecar does: one {type:'surface', ops:[...]} push.
async function ops(list) {
  await page.evaluate((l) => {
    const ev = { type: 'surface', ops: l };
    (window.__agent.onMessage || []).forEach((fn) => { try { fn(ev); } catch (_) {} });
  }, list);
  await page.waitForTimeout(320);
}

const GOOD_TYPE = 'window.render=function(p){document.body.textContent="ok:"+JSON.stringify(p||{});};'
                + 'window.onData=function(d){document.body.textContent="data:"+JSON.stringify(d||{});};';
const THROWING_TYPE = 'window.render=function(){ throw new Error("widget blew up"); };';

console.log('\nsurface protocol — failure modes');

// 1. publish to a key that was never added must REPORT, not vanish.
await clearFeedback();
await ops([{ op: 'publish', key: 'never-added', data: { x: 1 } }]);
let fb = await feedback();
check('publish to unknown key reports ok:false',
  fb.some((m) => m.ok === false && m.key === 'never-added'),
  `got ${JSON.stringify(fb)}`);

// 2. same for update_widget.
await clearFeedback();
await ops([{ op: 'update_widget', key: 'also-missing', props: { a: 1 } }]);
fb = await feedback();
check('update_widget on unknown key reports ok:false',
  fb.some((m) => m.ok === false && m.key === 'also-missing'),
  `got ${JSON.stringify(fb)}`);

// 3. the error must name the key and say how to fix it (the agent reads this).
check('unknown-key error is actionable',
  fb.some((m) => /also-missing/.test(m.error || '') && /add_widget/.test(m.error || '')),
  `got ${JSON.stringify(fb.map((m) => m.error))}`);

// 4. happy path still works end to end and does NOT emit a failure.
await clearFeedback();
await ops([
  { op: 'register_widget_type', name: 'proto_ok', code: GOOD_TYPE },
  { op: 'add_widget', key: 'w_ok', type: 'proto_ok', props: { hello: 1 } },
]);
fb = await feedback();
check('register -> add emits no failure', !fb.some((m) => m.ok === false),
  `got ${JSON.stringify(fb)}`);

// 5. publish to that now-live key must also not fail.
await clearFeedback();
await ops([{ op: 'publish', key: 'w_ok', data: { v: 42 } }]);
fb = await feedback();
check('publish to a live key succeeds', !fb.some((m) => m.ok === false),
  `got ${JSON.stringify(fb)}`);

// 6. a widget whose code throws must be reported, never fail open.
await clearFeedback();
await ops([
  { op: 'register_widget_type', name: 'proto_bad', code: THROWING_TYPE },
  { op: 'test_widget', key: 'probe_bad', type: 'proto_bad', props: {} },
]);
fb = await feedback();
check('throwing widget reports ok:false',
  fb.some((m) => m.ok === false),
  `got ${JSON.stringify(fb)}`);

// 7. remove_widget tears down, and later ops on that key are then unknown.
await clearFeedback();
await ops([{ op: 'remove_widget', key: 'w_ok' }]);
await clearFeedback();
await ops([{ op: 'publish', key: 'w_ok', data: { v: 1 } }]);
fb = await feedback();
check('publish after remove_widget reports ok:false',
  fb.some((m) => m.ok === false && m.key === 'w_ok'),
  `got ${JSON.stringify(fb)}`);

await browser.close();
server.close();

console.log(failures === 0
  ? '\nsurface-protocol: ALL PASS'
  : `\nsurface-protocol: ${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);
