// bench/latency.mjs — rough latency benchmarks for the AEAD channel.
//
// Measures "time to first reply" (TTFT-equivalent for the channel transport leg)
// of one encrypted message through the gateway, in the best case and under
// modeled network degradation (added RTT, jitter, packet loss -> TCP RTO).
//
// Honest scope: there is no ASR/LLM/TTS here. This measures the TRANSPORT + codec
// leg we built. A real agent adds ASR+decode+model-TTFT on top. The value is the
// network budget + a structural streaming finding (see output).

import { startGateway, httpClientSession } from '../gateway.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { min: +Math.min(...arr).toFixed(2), mean: +mean.toFixed(2),
           p50: +pct(arr, 0.5).toFixed(2), p95: +pct(arr, 0.95).toFixed(2),
           p99: +pct(arr, 0.99).toFixed(2) };
}

// ---- virtual network ---------------------------------------------------------
// Models one-way latency RTT/2 each direction (+/- jitter), and packet loss
// handled as TCP-style retransmission (a fixed RTO penalty) — which is exactly
// what an HTTP/TLS transport does under loss.
function makeNet({ rttMs = 0, jitterMs = 0, loss = 0, rtoMs = 250 } = {}) {
  const leg = () => {
    const L = rttMs / 2 + (jitterMs ? (Math.random() * 2 - 1) * (jitterMs / 2) : 0);
    return Math.max(0, L);
  };
  return {
    async before() { const L = leg(); if (L) await sleep(L); },
    async after() { const L = leg(); if (L) await sleep(L); },
    isLost() { return loss > 0 && Math.random() < loss; },
    rtoMs,
  };
}

// ---- setup ------------------------------------------------------------------
const gw = await startGateway();
let t = Date.now();
const session = await httpClientSession(gw.baseUrl);   // /pair + /hello + MAC + /confirm
const appCh = session.channel;
const clientId = session.clientId;
const handshakeMs = Date.now() - t;

function rawRoundtrip(payload) {
  return (async () => {
    const frame = appCh.send(payload, 0);
    const r = await (await fetch(`${gw.baseUrl}/msg`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, type: frame.type, nonce: frame.nonce.toString('base64'), ct: frame.ct.toString('base64'), tag: frame.tag.toString('base64') }),
    })).json();
    appCh.recv({ type: r.type | 0, nonce: Buffer.from(r.nonce, 'base64'), ct: Buffer.from(r.ct, 'base64'), tag: Buffer.from(r.tag, 'base64') });
  })();
}

// One message, TTFT = time from send until the first reply frame arrives.
// The gateway answers in a single frame, so TTFT == one request/reply here.
async function oneMsg(net) {
  const start = performance.now();
  await net.before();
  if (net.isLost()) { await sleep(net.rtoMs); return { dt: performance.now() - start, lost: true }; }
  await rawRoundtrip(JSON.stringify({ type: 'action', rpc: 'ping', args: {} }));
  await net.after();
  return { dt: performance.now() - start, lost: false };
}

async function run(scenario) {
  const net = makeNet(scenario);
  const samples = [];
  let lost = 0;
  for (let i = 0; i < scenario.warm; i++) await oneMsg(net); // warm path (crypto already warm)
  for (let i = 0; i < scenario.n; i++) {
    const r = await oneMsg(net);
    if (r.lost) lost++; else samples.push(r.dt);
  }
  const s = stats(samples);
  return { ...scenario, ...s, lost, sampleCount: samples.length };
}

// Scenario list: mean frame writes to 0, 3, 10, 25 (small/med/large)
const scenarios = [
  { label: 'best (localhost, no net)', rttMs: 0, warm: 10, n: 60 },
  { label: 'good mobile WAN (+80ms/leg)', rttMs: 160, warm: 5, n: 40 },
  { label: 'poor mobile (+300ms/leg, jitter 50)', rttMs: 600, jitterMs: 50, warm: 3, n: 30 },
  { label: 'bad link (+800ms/leg, 3% loss)', rttMs: 1600, loss: 0.03, rtoMs: 400, warm: 2, n: 15 },
];

console.log(`handshake (pair+hello+derive): ${handshakeMs.toFixed(1)} ms`);
console.log(`agent id ${gw.agentId} · channel: X25519 4-DH + ChaCha20-Poly1305\n`);
console.log('time to first reply frame (ms)  [TTFT-equivalent for the transport leg]');
console.log('label'.padEnd(34), 'n ', 'min', 'mean', 'p50 ', 'p95 ', 'p99 ', 'lost');
console.log('-'.repeat(78));
const results = [];
for (const sc of scenarios) {
  const r = await run(sc);
  results.push(r);
  console.log(
    r.label.padEnd(34),
    String(r.sampleCount).padEnd(3),
    String(r.min).padStart(5),
    String(r.mean).padStart(6),
    String(r.p50).padStart(6),
    String(r.p95).padStart(6),
    String(r.p99).padStart(6),
    r.lost ? String(r.lost).padStart(4) : '    '
  );
}

// ---- streaming analysis ------------------------------------------------------
// Audio: Opus 24kHz, 20 ms frame => 50 frames/s one-way. On a request/reply
// channel, frames/sec is capped at 1000 / TTFT. On a persistent stream it is
// decoupled from RTT (latency only delays the FIRST frame).
console.log('\n--- streaming / request-reply analysis ---');
const FRAME_MS = 20;
const NEEDED = 1000 / FRAME_MS; // 50 frames/s
for (const r of results) {
  const cap = 1000 / r.mean;
  console.log(
    `  ${r.label.padEnd(32)} req/reply max ${cap.toFixed(1)} fps (need ${NEEDED} -> ${cap >= NEEDED ? 'OK' : 'FAIL'})`
  );
}
console.log('\n  Opus 24kHz/20ms @32kbps ≈ ' + (32000 / 8).toFixed(0) + ' B/s per direction — trivial bandwidth; latency, not throughput, is the constraint.');

gw.close();
