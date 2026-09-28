/**
 * mute-webrtc.test — issue #1 on the path where the claim can actually FAIL.
 *
 * mute-midreply proves the same behaviour over the WebSocket downlink, and its header records
 * why five different mutations could not break it: on that path the reply is BURST-SENT
 * ("→ phone pcm 100224b -> 104 opus packets via WS"). Barge-in cancels a pacing token, and there
 * is no pacing left to cancel — the bytes are already gone. So "muting cannot cut the reply off"
 * held there BY CONSTRUCTION, and a test nothing can falsify is a test that proves nothing about
 * the guard it claims to cover.
 *
 * The WebRTC downlink is different, and the difference is the whole point. It paces at 20ms per
 * frame and re-checks `tok.cancelled` BEFORE EVERY FRAME (sendW in the sidecar), so a barge-in
 * mid-reply genuinely truncates and the sidecar logs it:
 *
 *     [cut short after 57/445 frames: superseded or interrupted]
 *
 * That line is the falsifiable claim. Muting must not produce it.
 *
 * THE FAILURE THIS GUARDS. A muted Android mic does not stop AudioRecord — buffers keep arriving
 * full of digital silence. If that silence is ever heard as speech onset, maybeBargeIn() cancels
 * the in-flight reply and tells the agent to stop. The user mutes themselves and the agent is cut
 * off mid-sentence, which is issue #1's symptom arriving through the sidecar rather than the UI.
 * Drop the VAD threshold and that is exactly what happens — which is what makes this suite
 * mutation-provable where the WS one was not.
 *
 * Scoped gateway. A test that deliberately streams silence mid-turn has no business doing it to
 * the instance serving Terra's phone.
 *
 * Run: npm run mute-webrtc
 */
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { setupScopedHome, startScoped, stopScoped, liveGatewayPid, SCOPED_WS_URL, logTail,
         SCOPED_ADAPTER, SCOPED_HOME } from './lib/scoped-gateway.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
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

const SCOPED_LOG = join(SCOPED_HOME, 'scoped-gateway.log');
/* Read the scoped log from a byte offset taken before the reply, so a truncation recorded by an
 * EARLIER run cannot be mistaken for this one's. */
const logOffset = () => { try { return statSync(SCOPED_LOG).size; } catch { return 0; } };
const logSince = (off) => {
  try { const b = readFileSync(SCOPED_LOG); return b.subarray(Math.min(off, b.length)).toString('utf8'); }
  catch { return ''; }
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

/* ---- a prompt that earns a long reply, so there is plenty left to cut ---- */
const RATE = 48000, FRAME = 960;
const UTT = 'Please count slowly from one to twenty five, saying each number clearly.';
const wav = join('/tmp', `agentmob-mute-${Date.now()}.wav`);
execFileSync('say', ['-o', wav, '--data-format=LEI16@48000', '--channels=1', UTT]);
const pcm = readFileSync(wav).subarray(44);
const enc = new OpusScript(RATE, 1);
const frames = [];
for (let i = 0; i + FRAME * 2 <= pcm.length; i += FRAME * 2) {
  frames.push(enc.encode(pcm.subarray(i, i + FRAME * 2), FRAME));
}
/* Digital silence, encoded the same way a muted mic's buffers would be. */
const silenceFrame = enc.encode(Buffer.alloc(FRAME * 2), FRAME);

const s = new AgentStream({ url: SCOPED_WS_URL, onPair: async () => true });
await s.connect();
ok('AEAD control channel up against the scoped gateway', !!s.channel);
cleanup.push(() => { try { s.close?.(); } catch {} });

/* ---- WebRTC, so the downlink is PACED and cancellable per frame ---- */
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
cleanup.push(() => { try { pc.close(); } catch {} });
const mic = new MediaStreamTrack({ kind: 'audio' });
pc.addTransceiver(mic, { direction: 'sendrecv' });
let downlink = 0, lastDownlinkAt = 0;
pc.onTrack.subscribe((t) => { t.onReceiveRtp.subscribe(() => { downlink++; lastDownlinkAt = Date.now(); }); });

await pc.setLocalDescription(await pc.createOffer());
await sleep(1200);
const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
  { timeoutMs: 20000 });
const answer = reply && reply.webrtc && reply.webrtc.sdp;
ok('the scoped sidecar answered the offer', !!answer);
if (!answer) finish(1);
const opusPT = Number((answer.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1]);
await pc.setRemoteDescription({ type: 'answer', sdp: answer });
const connected = await waitFor(() => pc.connectionState === 'connected', 25000);
ok('ICE/DTLS reached connected', connected, `state: ${pc.connectionState}`);
if (!connected) finish(1);

/* ---- speak ---- */
let seq = (Math.random() * 30000) | 0, ts = 0;
const send = (payload) => {
  mic.writeRtp(new RtpPacket(new RtpHeader({
    sequenceNumber: seq++ & 0xffff, timestamp: ts, payloadType: opusPT, ssrc: 4242,
  }), payload));
  ts += FRAME;
};
for (const f of frames) { send(f); await sleep(20); }
console.log(`  streamed ${frames.length} frames; waiting for the reply to start…`);

/* The reply must be genuinely in flight — and on the PACED path, or this proves nothing. */
const MIN_BEFORE_MUTE = 60;
const started = await waitFor(() => downlink > MIN_BEFORE_MUTE, 240000);
ok('the agent is mid-reply on the WebRTC downlink', started,
  `only ${downlink} RTP — too little to mute into`);
if (!started) finish(1);

/* Offset taken HERE: any "cut short" after this point belongs to the mute, not to setup. */
const offAtMute = logOffset();
const atMute = downlink;
console.log(`  MUTED after ${atMute} downlink RTP — streaming digital silence over SRTP`);

/* ---- THE MUTE: keep the stream alive, send silence, exactly as the hardware does ---- */
let muting = true;
const muteStream = (async () => { while (muting) { send(silenceFrame); await sleep(20); } })();
cleanup.push(() => { muting = false; });

/* ---- the reply must keep flowing and finish ---- */
const grew = await waitFor(() => downlink > atMute + 40, 90000);
ok('the reply KEPT PLAYING while the mic streamed silence (issue #1)', grew,
  `downlink stalled at ${downlink} (was ${atMute}) — the mute cut the agent off mid-sentence`);

const settled = await waitFor(() => Date.now() - lastDownlinkAt > 4000, 240000);
ok('the reply finished rather than being left hanging', settled,
  `still receiving RTP after ${downlink} packets`);

muting = false;
await muteStream.catch(() => {});

/* ---- THE FALSIFIABLE CLAIM: the sidecar must not record a truncation --------------------------
 * This is the line the WS path could never produce. On the paced WebRTC downlink the sidecar
 * checks the cancel token before every frame and, if barge-in fired, records exactly how far it
 * got. Muting must never produce it. */
await sleep(1500);
const tail = logSince(offAtMute);
const cut = /cut short after (\d+)\/(\d+) frames: ([^\]]+)/.exec(tail);
ok('the sidecar recorded NO truncation of the reply after the mute',
  !cut,
  cut ? `[cut short after ${cut[1]}/${cut[2]} frames: ${cut[3]}] — silence from a muted mic was `
        + 'heard as speech onset, barge-in cancelled the in-flight reply, and the agent stopped '
        + 'mid-sentence. That is issue #1.'
      : '');
ok('the reply was served over WebRTC, not a fallback',
  /via WebRTC/.test(tail) || /via WebRTC/.test(logSince(0)),
  'the downlink fell back to WS/UDP, where a cancel cannot truncate — this suite would then be '
  + 'proving nothing it claims to prove');

console.log(`\n  downlink ${atMute} RTP before the mute, ${downlink} after`);
finish(0);
