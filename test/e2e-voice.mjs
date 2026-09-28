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
/* --render asks for a reply that is PURELY VISUAL. The default utterance produces a text reply,
 * so the narration path — the one line spoken over a chart — is never exercised by it. The two
 * shapes travel differently (a render is a cmd on the control channel, narration is audio
 * frames) and only this mode can order one against the other. */
const RENDER = process.argv.includes('--render');
const DEFAULT_UTT = RENDER
  ? 'Draw me a chart of the numbers one through five. Just the chart.'
  : 'What is two plus two? Answer in one short sentence.';
const UTT = process.argv.filter((a) => !a.startsWith('--'))[2] || DEFAULT_UTT;
/* AGENTMOB_WS_URL points this suite at a SCOPED gateway instance instead of the live one, which is
 * how the adapter mutations run without restarting production (test/lib/scoped-gateway.mjs). */
const WS_URL = process.env.AGENTMOB_WS_URL || 'ws://127.0.0.1:8123';
if (process.env.AGENTMOB_WS_URL) console.log(`endpoint: ${WS_URL} (scoped instance)`);
const RATE = 24000, FRAME = 480; // sidecar uplink decoder: 24k mono, 20ms
const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
execFileSync('say', ['-v', 'Samantha', '-o', join(dir, 'u.aiff'), UTT]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'u.aiff'), '-ar', String(RATE), '-ac', '1', '-f', 's16le', join(dir, 'u.raw')]);
const speech = readFileSync(join(dir, 'u.raw'));
const sil = (ms) => Buffer.alloc(RATE * 2 * ms / 1000);
const pcm = Buffer.concat([sil(600), speech, sil(6000)]); // >SILENCE_MS trailing so the utterance closes
console.log(`utterance: "${UTT}" (${(speech.length / 2 / RATE).toFixed(1)}s speech, ${(pcm.length / 2 / RATE).toFixed(1)}s total)`);

const events = [];
const chartColourViolations = [];
const s = new AgentStream({ url: WS_URL, onPair: async (id, agentId) => { console.log('TOFU pair: agent', agentId, 'identity', Buffer.from(id).toString('base64').slice(0, 24) + '…'); return true; } });
let audioFrames = 0;
/* ---- cross-rail ordering ----------------------------------------------------------------
 * Render envelopes are cmd frames; narration is audio frames. Counting each separately proves
 * both were SENT and says nothing about their order, which is the whole question for a
 * render-only turn: narration that precedes its render is narrating nothing. One counter
 * bumped in both branches puts them on a single timeline. Only the FIRST audio frame is
 * stamped — later ones cannot move the boundary. */
let tick = 0;
let firstAudioTick = null;
let audioAfterRender = 0;     // frames that arrived once a render envelope had been sent
const renderTicks = [];
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
    const myTick = ++tick;
    if (kind === 'render' || kind === 'surface') renderTicks.push(myTick);
    if (kind === 'text') console.log(`  ← text: ${JSON.stringify(d.text).slice(0, 200)}`);
    else if (kind === 'render') { console.log(`  ← render: ${JSON.stringify(d.ui || d).slice(0, 160)}`);
      const comps = ((d.ui || d).components || []); comps.forEach((c) => { if (c.t === 'chart') { const o = c.options || {}; const bad = [];
        if (o.colors) bad.push('colors'); if (o.chart && (o.chart.background || o.chart.foreColor)) bad.push('chart.background/foreColor'); if (o.grid && o.grid.borderColor) bad.push('grid.borderColor'); if (o.theme) bad.push('theme');
        if (bad.length) chartColourViolations.push(...bad);
        console.log(`     chart: type=${o.chart && o.chart.type} points=${(o.series && o.series[0] && o.series[0].data || []).length} hard-coded colours: ${bad.length ? bad.join(', ') : 'NONE (themed by the surface)'}`); } }); }
    else if (kind === 'surface') console.log(`  ← surface ops: ${(d.ops || []).map(o => o.op).join(',')}`);
    else if (kind === 'status') { if (d.heard || d.working !== undefined || d.speaking !== undefined) console.log(`  ← status: ${JSON.stringify(d).slice(0, 160)}`); }
    else console.log(`  ← ${kind}: ${JSON.stringify(d).slice(0, 160)}`);
    // Honour the render feedback contract like the phone does.
    if (kind === 'surface') for (const op of (d.ops || [])) if (op.key) s.cmd({ type: 'render_result', key: op.key, ok: true }).catch(() => {});
  } else if (f.type === T.audio) {
    audioFrames++;
    if (firstAudioTick === null) firstAudioTick = ++tick;
    if (renderTicks.length > 0) audioAfterRender++;
  }
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
  const answered = events.some((d) => d && d.type === 'text') || renderTicks.length > 0;
  if (quiet && answered && audioFrames > 0) { await new Promise((r) => setTimeout(r, 1500)); break; }
}
console.log(`\nsummary: ${events.length} cmd events, ${audioFrames} TTS audio frames`);
const texts = events.filter((d) => d.type === 'text').map((d) => d.text);
const renders = events.filter((d) => d.type === 'render' || d.type === 'surface');
const heard = events.filter((d) => d.type === 'status' && d.heard);
console.log(`texts: ${texts.length}  renders: ${renders.length}  heard: ${heard.map((d) => d.heard).join(' | ') || '(none)'}`);

/* ---- ASSERTIONS ---------------------------------------------------------------------------
 * This script used to have none. Its entire verdict was
 *   process.exit(texts.length && audioFrames ? 0 : 1)
 * — one implicit claim (something was said and something was spoken) with everything else
 * merely PRINTED. The chart-colour audit was the worst of it: it computed the violations and
 * then logged them, so a render full of hard-coded hex passed exactly like a clean one. A
 * check that reports a violation without failing is decoration.
 *
 * Each claim the script already makes in its output is now a claim it will fail on. */
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* A reply may be TEXT (spoken) or a RENDER (shown). Asking for a chart produces a render with
 * no narration at all — observed: "texts: 0 renders: 1", no TTS, no speaking status. My first
 * version asserted text AND speech unconditionally and failed on a perfectly ordinary turn.
 * So the guarantee is "the agent responded", and the speech claims apply only when there was
 * something to speak. (Whether a chart SHOULD be narrated on a voice-first surface is a
 * product question, flagged rather than silently encoded here as an assertion either way.) */
ok('the agent responded at all (text or a render)', texts.length > 0 || renders.length > 0,
  'nothing came back — the utterance never reached the agent, or it produced nothing');
ok('the sidecar reported hearing the utterance (status.heard)', heard.length > 0,
  'no heard status — the transcript never made it to the dispatch path');
/* EVERY reply is spoken, including a purely visual one. A render used to arrive in silence —
 * the phone showed the component and said nothing, no TTS and no speaking indicator — which on
 * a voice-first surface is indistinguishable from the request having been lost. The adapter now
 * narrates a render-only reply in one line, so the claim applies to both shapes and FAILS when
 * speech is missing rather than being excused. */
ok('the reply was spoken (TTS audio frames arrived)', audioFrames > 0,
  `${audioFrames} frames — a render-only reply must still be narrated, not left silent`);
ok('the speaking indicator was raised and then cleared',
  events.some((d) => d.type === 'status' && d.speaking === true)
  && events.some((d) => d.type === 'status' && d.speaking === false),
  'the phone would be left with a stuck speaking pill');
ok('no chart carried hard-coded colours (the surface themes them)',
  chartColourViolations.length === 0,
  chartColourViolations.join(', '));

/* ---- the narration ORDER, not merely its existence ----------------------------------------
 * `the reply was spoken` above counts audio frames. That proves the narration was SENT; it says
 * nothing about WHEN. A render envelope is a cmd on the AEAD control channel and the narration
 * is audio frames — two rails, each ordered internally, neither ordered against the other by the
 * protocol. Narration emitted BEFORE its render would count identically and be wrong: the phone
 * would say "Here's the chart" to a blank surface.
 *
 * WHAT THE ORDERING CLAIM IS, after two corrections from real runs.
 *
 * First I compared the turn's FIRST audio frame against the render. It stayed green when I moved
 * _schedule_speak above the render push in the adapter, because _flush_speak sleeps 1.5s before
 * synthesising while the render push is synchronous — so I labelled it a structural guard that
 * could not fail. Then it FAILED on a scoped instance: first audio at tick 88, render at 103.
 *
 * The scoped run showed why, and it was the assertion that was wrong, not the adapter. The agent
 * had spoken a PREAMBLE before rendering — a full speaking:true/false pair precedes the render
 * envelope — so the turn's first audio frame belongs to that preamble, not to the narration. A
 * reply that talks first and then shows something is perfectly good behaviour on a voice-first
 * surface; the claim must not forbid it.
 *
 * What actually matters is that speech arrives AFTER the surface is on screen, so the narration
 * describes something the user can see. That is audioAfterRender, and unlike the first-frame
 * version it is falsifiable: delete _narrate_components and a render-only turn has no audio after
 * its render envelope at all. The mutation entry for this suite proves exactly that.
 *
 * STATED LIMIT, because it is the difference between this and done: this is the HOST's send
 * order. It does not prove the handset PLAYS them in that order — Android buffers audio and the
 * WebView renders on its own schedule, and only the device can answer that. `npm run
 * device-verify` is where that claim lives, and it is currently blocked on hardware. */
if (renderTicks.length > 0 && texts.length === 0) {
  ok('a render-only reply was narrated at all', audioFrames > 0,
    'the phone would show the component in total silence — indistinguishable from a lost request');
  ok('speech arrived AFTER the render envelope, so the narration describes a visible surface',
    audioAfterRender > 0,
    `${audioFrames} audio frames in the turn but ${audioAfterRender} after the render at tick `
    + `${Math.min(...renderTicks)} (first audio at tick ${firstAudioTick}) — everything spoken `
    + 'came before the surface was sent, so the phone talked about a screen that was not there');
} else if (RENDER) {
  /* --render asked for a purely visual answer and did not get one. The narration claim cannot be
   * evaluated, and silently passing would make this suite look like it covers narration when the
   * agent simply replied in prose. Fail loudly rather than vacuously. */
  ok('--render produced a render-only turn (so the narration claim could be evaluated)',
    false, `texts: ${texts.length} renders: ${renderTicks.length} — reword the utterance; `
    + 'a narration assertion that never runs is not coverage');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
s.close();
process.exit(fails.length ? 1 : 0);
