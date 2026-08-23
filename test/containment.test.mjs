// containment.test.mjs — PROOF that the locked webview contains arbitrary
// injected agent JS, while the encrypted channel still works.
//
// Stack exercised end-to-end:
//   gateway (mock agent)  <-AEAD->  Node "shell" (the app's native layer)
//                                       |  exposes ONE native fn to the webview
//                                       v
//   Chromium webview (strict CSP, channel-only I/O) hosting the agent's bundle
//
// The agent pushes its UI (a declarative render) AND a malicious script through
// the encrypted channel. The script must be contained: every network/storage/
// popup attempt fails, the channel round-trips.

import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { startGateway, httpClientSession } from '../gateway.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

// ---- static server for the app web-layer ------------------------------------
const ROOT = join(import.meta.dirname, '..', 'app');
const TYPES = { html: 'text/html', js: 'application/javascript', css: 'text/css' };
const appServer = http.createServer(async (req, res) => {
  try {
    const p = join(ROOT, req.url === '/' ? 'index.html' : req.url);
    const body = await readFile(p);
    const ext = extname(p).slice(1);
    res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('nf');
  }
});
await new Promise((r) => appServer.listen(0, r));
const APP = `http://127.0.0.1:${appServer.address().port}/`;

// A REAL reachable "attacker" endpoint: if the webview ever egresses, this
// receives the data. It must stay at zero requests for the containment proof.
const canaryHits = [];
const canary = http.createServer((req, res) => { canaryHits.push(req.url); res.writeHead(204); res.end(); });
await new Promise((r) => canary.listen(0, r));
const CANARY = `http://127.0.0.1:${canary.address().port}`;

// ---- start the agent gateway + do the mutual handshake (Node shell = native) --
const gw = await startGateway(0, CANARY);
// Full v2 handshake over HTTP: /pair pins the agent key, /hello + MAC verify, /confirm.
const session = await httpClientSession(gw.baseUrl);
const roundtrip = session.roundtrip;

// ---- launch the locked webview ----------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext();

// The shell policy: no outbound network from the webview. CSP is layer 1;
// this route is the native network-boundary filter (the analog of WKWebView's
// NSURLProtocol backend / Android WebView network handling). Every external
// request is refused here — CSP alone proved insufficient for xhr/sendBeacon.
const blockedExternal = [];
await context.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(APP)) return route.continue();
  blockedExternal.push(u);
  return route.abort();
});

// Neutralize storage + popups at the engine level (the native policy).
await context.addInitScript(() => {
  try {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('storage disabled'); } });
    Object.defineProperty(window, 'sessionStorage', { get: () => { throw new Error('storage disabled'); } });
    window.open = function () { throw new Error('popups disabled'); };
  } catch (_) {}
});

const page = await context.newPage();

// The ONE native capability the shell grants the webview: put a message on the
// encrypted channel. Everything else the webview does is dead.
await page.exposeFunction('__native_send', async (payload) => {
  return roundtrip(String(payload));
});

await page.goto(APP, { waitUntil: 'networkidle' });
await page.evaluate((id) => window.__setAgentId(id), gw.agentId);

// ---- agent pushes its UI through the encrypted channel ----------------------
const renderReply = await roundtrip({ type: 'render' });
await page.evaluate((s) => window.__pushAgentMessage(s), renderReply);

// ---- agent pushes its (malicious) code through the channel; shell injects it -
const scriptReply = await roundtrip({ type: 'script' });
const source = JSON.parse(scriptReply).source;
await page.evaluate((src) => {
  const el = document.createElement('script');
  el.textContent = src;
  document.body.appendChild(el);
}, source);

// ---- let the async attacks settle, then read the verdicts --------------------
await page.waitForFunction(() => {
  const a = window.__attacks || {};
  return ['fetch', 'beacon', 'xhr', 'img', 'storage', 'open'].every((k) => k in a);
}, { timeout: 8000 }).catch(() => {});

const attacks = await page.evaluate(() => window.__attacks || {});
console.log('  API-level attack results:', JSON.stringify(attacks));

console.log('\n=== containment verdicts ===');
// Layer-1 (CSP / API policy): these must throw or be refused synchronously.
for (const k of ['fetch', 'img', 'storage', 'open']) {
  const a = attacks[k];
  ok(a && a.ok === false, `agent JS cannot ${k} (refused)`);
}

// Layer-2 (no egress): the load-bearing proof. The bundle fires xhr/sendBeacon/
// fetch/img at a LIVE canary. Whether CSP stops them before the network layer
// OR the native boundary filter refuses them (or both), ZERO bytes may land on
// the canary. This is the honest guarantee — not whether the API threw.
ok(
  canaryHits.length === 0,
  `NO egress: the reachable canary received 0 requests (CSP + network boundary held)`
);
console.log('        canary hits:', canaryHits.length, '| refused at network boundary:', blockedExternal.map((u) => new URL(u).host).join(', ') || '(none — CSP blocked earlier)');

console.log('\n=== channel must still work ===');
const bodyText = await page.textContent('main');
ok(bodyText.includes('channel works'), 'channel round-trip delivered agent content to the webview');

console.log('\n=== identity badge ===');
const badge = await page.textContent('#badge');
ok(badge.includes(gw.agentId), 'unforgeable identity badge shows the pinned agent key');

await browser.close();
appServer.close();
gw.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
