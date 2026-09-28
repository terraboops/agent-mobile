/**
 * mute-midreply.test — issue #1, end to end against a REAL pipeline.
 *
 * WHAT WAS ALREADY PROVEN, AND WHAT WAS NOT. mic-mute covers the web layer: muting does not clear
 * the speaking widget, sends no interrupt, flatlines the meter. Sixteen assertions, red-proofed.
 * But it stubs the native plugin, so it never touches the sidecar or the adapter — the whole
 * claim lives inside one browser page.
 *
 * On the wire, muting means one thing: THE UPLINK STOPS. And a pipeline that reads a gap in the
 * uplink as end-of-utterance will transcribe the silence, dispatch a turn, and that new turn
 * SUPERSEDES the reply already playing. The user hears the agent cut off mid-sentence moments
 * after muting themselves — which is issue #1's symptom exactly, produced by machinery mic-mute
 * cannot see.
 *
 * So: speak for real, wait until the agent is actually talking back, then go silent the way a
 * mute does — stop sending entirely — and require the reply to finish.
 *
 * Runs on the SCOPED gateway. The production gateway is never restarted and its config is never
 * written; a test that deliberately drops the uplink mid-turn has no business doing it to the
 * instance serving Terra's phone.
 *
 * WHAT THIS SUITE CANNOT FALSIFY, established by trying three times and failing.
 *
 * The interesting failure — a muted mic being heard as speech, triggering barge-in, truncating
 * the reply — cannot be produced on THIS path, and the mutation harness is what proved it:
 *
 *   1. dropping the whisper hallucination filter        -> MISSED. Unreachable: the VAD never
 *      opens a capture on digital zeros, so whisper is never invoked at all.
 *   2. (before that) the suite sent NOTHING after the mute -> the wrong hardware model entirely.
 *      setMicrophoneMute does not stop AudioRecord; buffers keep arriving, full of silence.
 *   3. SPEECH_RMS = -1, so flat silence reads as speech  -> MISSED, and the log shows barge-in
 *      DID fire. The reply still grew from 162 to 1238 frames, because on the WebSocket path the
 *      reply is BURST-SENT ("→ phone pcm 100224b -> 104 opus packets via WS"). Cancelling the
 *      pacing token after the burst is already on the wire truncates nothing.
 *
 * So on the WS downlink, "muting cannot cut the reply off" holds BY CONSTRUCTION rather than by
 * a guard, and no mutation of the guard can show otherwise. The falsifiable version of this test
 * needs the PACED WebRTC downlink, where the cancel token is consulted per frame — that is what
 * e2e-interrupt exercises, and extending this suite onto that path is the honest next step.
 *
 * What it does prove, which nothing else did: the real pipeline — sidecar VAD, whisper, adapter,
 * agent, TTS — carries a reply to its natural end while the uplink is flat, and does not
 * transcribe that silence into a phantom turn. That was previously only asserted against a
 * stubbed plugin inside one browser page.
 *
 * Run: npm run mute-midreply
 */
import { AgentStream } from '../transport/ws-client.mjs';
import { unpack, T } from '../transport/wsframes.js';
import { setupScopedHome, startScoped, stopScoped, liveGatewayPid, SCOPED_WS_URL, logTail,
         SCOPED_ADAPTER } from './lib/scoped-gateway.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/Users/terra/.hermes/plugins/agentmob/sidecar/index.mjs');
const OpusScript = require('opusscript');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(200); }
  return fn();
};

const livePidBefore = liveGatewayPid();
console.log(`live gateway pid ${livePidBefore} (must be unchanged at the end)\n`);
const cleanup = [() => stopScoped({})];
const finish = (code = 0) => {
  for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
  const after = liveGatewayPid();
  if (after !== livePidBefore) fails.push('the production gateway was restarted');
  console.log(`\nlive gateway pid ${livePidBefore} -> ${after}`);
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length || code) process.exit(1);
  console.log('ALL PASS');
  process.exit(0);
};
process.on('uncaughtException', (e) => { console.error(e); finish(1); });

/* ---- scoped gateway ---- */
stopScoped({});
setupScopedHome({ configOnly: existsSync(SCOPED_ADAPTER), log: (m) => console.log(`  [scoped] ${m}`) });
const up = startScoped({ log: (m) => console.log(`  [scoped] ${m}`) });
if (!up.ok) {
  ok('the scoped gateway started', false,
    `${up.note}\n${(up.tail || logTail(up.logPath) || '').split('\n').slice(-10).join('\n')}`);
  finish(1);
}

/* ---- an utterance that earns a LONG reply, so there is something to cut off ---- */
const RATE = 24000, FRAME = 480;
const UTT = 'Please count slowly from one to twenty, saying each number clearly.';
const dir = mkdtempSync(join(tmpdir(), 'mute-'));
execFileSync('say', ['-v', 'Samantha', '-o', join(dir, 'u.aiff'), UTT]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'u.aiff'),
  '-ar', String(RATE), '-ac', '1', '-f', 's16le', join(dir, 'u.raw')]);
const speech = readFileSync(join(dir, 'u.raw'));
const sil = (ms) => Buffer.alloc(RATE * 2 * ms / 1000);
/* Trailing silence long enough to CLOSE the utterance, so the agent starts replying. The mute
 * happens after that, mid-reply — the point is the gap that follows a completed turn, not a gap
 * inside one. */
const pcm = Buffer.concat([sil(400), speech, sil(6000)]);

const events = [];
let audioFrames = 0, lastAudioAt = 0;
const s = new AgentStream({ url: SCOPED_WS_URL, onPair: async () => true });
s._onFrame = function (raw) {
  let f; try { f = unpack(Buffer.from(raw)); } catch { return; }
  if (!this.channel) return;
  const pt = this.channel.recvBytes(f); if (pt === null) return;
  if (f.type === T.pong) return;
  if (f.type === T.cmd) {
    const { i, d } = JSON.parse(pt.toString('utf8'));
    const p = this._pending.get(i);
    if (p) { clearTimeout(p.t); this._pending.delete(i); p.resolve(d); return; }
    events.push({ ...d, at: Date.now() });
  } else if (f.type === T.audio) { audioFrames++; lastAudioAt = Date.now(); }
};
await s.connect();
ok('AEAD channel up against the scoped gateway', !!s.channel);
cleanup.push(() => { try { s.close?.(); } catch {} });

/* ---- speak ---- */
const enc = new OpusScript(RATE, 1);
let seq = 1; const t0 = Date.now();
for (let off = 0; off + FRAME * 2 <= pcm.length; off += FRAME * 2) {
  s.sendAudio(seq++, Date.now(), Buffer.from(enc.encode(pcm.subarray(off, off + FRAME * 2), FRAME)));
  const due = t0 + (seq - 1) * 20, wait = due - Date.now();
  if (wait > 0) await sleep(wait);
}
console.log(`  streamed ${seq - 1} opus frames; waiting for the agent to start speaking…`);

const heard = await waitFor(() => events.some((e) => e.type === 'status' && e.heard), 180000);
ok('the scoped sidecar transcribed the utterance', heard, 'no heard status — nothing to reply to');

/* Wait until the reply is genuinely in flight. Muting after it has finished proves nothing. */
const MIN_BEFORE_MUTE = 40;
const speaking = await waitFor(() => audioFrames > MIN_BEFORE_MUTE, 180000);
ok('the agent is mid-reply before the mute', speaking,
  `only ${audioFrames} audio frames — the reply was too short to mute into`);
if (!speaking) finish(1);

/* ---- THE MUTE, modelled the way the hardware actually behaves ------------------------------
 * My first version stopped sending entirely. That is NOT what muting does.
 * AudioManager.setMicrophoneMute() does not tear down the capture — AudioRecord keeps
 * delivering buffers, they are just full of digital silence. The stream continues; its content
 * goes flat.
 *
 * The distinction is the whole test. With nothing sent, no capture ever closes, whisper is never
 * invoked, and the interesting failure cannot occur — the mutation harness proved that by
 * deleting the hallucination filter and watching this suite pass anyway (MISSED). With silence
 * FLOWING, the sidecar's VAD eventually closes a capture full of nothing, whisper is handed
 * near-silence, and whisper hallucinates: "Thank you.", "Bye.", "Thanks for watching!". Dispatch
 * that phantom and it becomes a new turn, which supersedes the reply still playing.
 *
 * That is issue #1's symptom — the agent cut off moments after you mute yourself — arriving
 * through a path the web-layer test cannot see. */
const atMute = audioFrames;
const mutedAt = Date.now();
console.log(`  MUTED after ${atMute} downlink frames — streaming DIGITAL SILENCE from here on`);
let muting = true;
const silenceFrame = Buffer.alloc(FRAME * 2);
const muteStream = (async () => {
  while (muting) {
    s.sendAudio(seq++, Date.now(), Buffer.from(enc.encode(silenceFrame, FRAME)));
    await sleep(20);
  }
})();
cleanup.push(() => { muting = false; });

/* ---- the reply must CONTINUE and FINISH ----------------------------------------------------- */
const grew = await waitFor(() => audioFrames > atMute + 20, 60000);
ok('the reply KEPT PLAYING after the mic went silent (issue #1)', grew,
  `frames stalled at ${audioFrames} (was ${atMute}) — going silent stopped the agent talking, `
  + 'which is the bug this issue is named for');

/* And it must end by FINISHING, not by being superseded. speaking:false is the adapter saying the
 * turn completed; a truncation would instead show up as a new turn starting. */
const ended = await waitFor(() => {
  const last = events.filter((e) => e.type === 'status' && e.speaking === false).pop();
  return last && last.at > mutedAt && Date.now() - lastAudioAt > 2500;
}, 180000);
ok('the reply reached its natural end after the mute', ended,
  `frames ${audioFrames}, last audio ${Date.now() - lastAudioAt}ms ago — the turn never `
  + 'reported speaking:false after the mute');

/* ---- and the silence must not have been mistaken for speech --------------------------------- */
/* Give the VAD time to close a capture on the silence and run it through whisper — the phantom,
 * if it comes, arrives seconds after the mute, not immediately. */
await sleep(9000);
const heardAfterMute = events.filter((e) => e.type === 'status' && e.heard && e.at > mutedAt);
ok('the silence did not produce a phantom transcript', heardAfterMute.length === 0,
  `${heardAfterMute.length} heard event(s) after muting: `
  + `${heardAfterMute.map((e) => JSON.stringify(e.heard).slice(0, 60)).join(' | ')} — a gap in `
  + 'the uplink was transcribed as an utterance, and the turn it dispatched would supersede the '
  + 'reply still playing');

muting = false;
await muteStream.catch(() => {});
console.log(`\n  downlink ${atMute} frames before the mute, ${audioFrames} after; `
  + `${seq - 1} uplink frames sent in total`);
finish(0);
