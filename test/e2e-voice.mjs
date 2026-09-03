// e2e-voice.mjs — a FAKE PHONE against the LIVE sidecar (ws://127.0.0.1:8123).
// Real v2 handshake + AEAD channel, a synthesized utterance streamed as 20ms
// opus frames, then everything the adapter pushes back is captured: text
// replies, TTS audio frames, render envelopes, status. This is the only path
// that exercises the adapter end-to-end without the device. Not part of the
// default suite (needs the gateway up). Usage: node test/e2e-voice.mjs "utterance"
import { AgentStream } from '../transport/ws-client.mjs';
import { pack, unpack, T } from '../transport/wsframes.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/Users/terra/.hermes/plugins/agentmob/sidecar/index.mjs');
const OpusScript = require('opusscript');

const NEW = process.argv.includes('--new');
const UTT = process.argv.filter((a) => !a.startsWith('--'))[2] || 'What is two plus two? Answer in one short sentence.';
const RATE = 24000, FRAME = 480; // sidecar uplink decoder: 24k mono, 20ms
const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
execFileSync('say', ['-v', 'Samantha', '-o', join(dir, 'u.aiff'), UTT]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'u.aiff'), '-ar', String(RATE), '-ac', '1', '-f', 's16le', join(dir, 'u.raw')]);
const speech = readFileSync(join(dir, 'u.raw'));
const sil = (ms) => Buffer.alloc(RATE * 2 * ms / 1000);
const pcm = Buffer.concat([sil(600), speech, sil(6000)]); // >SILENCE_MS trailing so the utterance closes
console.log(`utterance: "${UTT}" (${(speech.length / 2 / RATE).toFixed(1)}s speech, ${(pcm.length / 2 / RATE).toFixed(1)}s total)`);

const events = [];
const s = new AgentStream({ url: 'ws://127.0.0.1:8123', onPair: async (id, agentId) => { console.log('TOFU pair: agent', agentId, 'identity', Buffer.from(id).toString('base64').slice(0, 24) + '…'); return true; } });
let audioFrames = 0;
// Capture EVERY inbound cmd (the stock client only resolves its own pending ids).
s._onFrame = function (raw) {
  let f; try { f = unpack(Buffer.from(raw)); } catch { return; }
  if (!this.channel) return;
  const pt = this.channel.recvBytes(f); if (pt === null) return;
  if (this.failures > 0) this._onLiveness();
  if (f.type === T.pong) return;
  if (f.type === T.cmd) {
    const { i, d } = JSON.parse(pt.toString('utf8'));
    const p = this._pending.get(i);
    if (p) { clearTimeout(p.t); this._pending.delete(i); p.resolve(d); return; }
    events.push(d);
    const kind = d && d.type;
    if (kind === 'text') console.log(`  ← text: ${JSON.stringify(d.text).slice(0, 200)}`);
    else if (kind === 'render') { console.log(`  ← render: ${JSON.stringify(d.ui || d).slice(0, 160)}`);
      const comps = ((d.ui || d).components || []); comps.forEach((c) => { if (c.t === 'chart') { const o = c.options || {}; const bad = [];
        if (o.colors) bad.push('colors'); if (o.chart && (o.chart.background || o.chart.foreColor)) bad.push('chart.background/foreColor'); if (o.grid && o.grid.borderColor) bad.push('grid.borderColor'); if (o.theme) bad.push('theme');
        console.log(`     chart: type=${o.chart && o.chart.type} points=${(o.series && o.series[0] && o.series[0].data || []).length} hard-coded colours: ${bad.length ? bad.join(', ') : 'NONE (themed by the surface)'}`); } }); }
    else if (kind === 'surface') console.log(`  ← surface ops: ${(d.ops || []).map(o => o.op).join(',')}`);
    else if (kind === 'status') { if (d.heard || d.working !== undefined || d.speaking !== undefined) console.log(`  ← status: ${JSON.stringify(d).slice(0, 160)}`); }
    else console.log(`  ← ${kind}: ${JSON.stringify(d).slice(0, 160)}`);
    // Honour the render feedback contract like the phone does.
    if (kind === 'surface') for (const op of (d.ops || [])) if (op.key) s.cmd({ type: 'render_result', key: op.key, ok: true }).catch(() => {});
  } else if (f.type === T.audio) { audioFrames++; }
};
await s.connect();
console.log('handshake OK — AEAD channel up');
// NOTE: a plain cmd string is a TYPED TURN to the agent (not an echo).
// --new sends '/new' first: the adapter rotates the session, reloading skills.
if (NEW) { console.log('sending /new (session reset, skills reload)…'); s.cmd('/new', { timeoutMs: 30000 }).catch(() => {}); await new Promise((r) => setTimeout(r, 8000)); events.length = 0; audioFrames = 0; }

const enc = new OpusScript(RATE, 1);
let seq = 1; const t0 = Date.now();
for (let off = 0; off + FRAME * 2 <= pcm.length; off += FRAME * 2) {
  const op = enc.encode(pcm.subarray(off, off + FRAME * 2), FRAME);
  s.sendAudio(seq++, Date.now(), Buffer.from(op));
  const due = t0 + (seq - 1) * 20; const wait = due - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
console.log(`streamed ${seq - 1} opus frames; waiting for the agent (up to 120s)…`);
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  // Done = the agent spoke a reply to THIS utterance and finished speaking.
  const spoke = events.some((d) => d && d.type === 'status' && d.speaking === true);
  const quiet = spoke && events[events.length - 1] && events[events.length - 1].type === 'status' && events[events.length - 1].speaking === false;
  if (quiet && events.some((d) => d && d.type === 'text') && audioFrames > 0) { await new Promise((r) => setTimeout(r, 1500)); break; }
}
console.log(`\nsummary: ${events.length} cmd events, ${audioFrames} TTS audio frames`);
const texts = events.filter((d) => d.type === 'text').map((d) => d.text);
const renders = events.filter((d) => d.type === 'render' || d.type === 'surface');
console.log(`texts: ${texts.length}  renders: ${renders.length}  heard: ${events.filter((d) => d.type === 'status' && d.heard).map((d) => d.heard).join(' | ') || '(none)'}`);
s.close(); process.exit(texts.length && audioFrames ? 0 : 1);
