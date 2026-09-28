/**
 * e2e-interrupt — barge-in, driven end to end against the LIVE sidecar.
 *
 * This is the device-independent half of the "mute mid-sentence" work (issue #1). Be precise
 * about which half: the NATIVE mic toggle is Android code (AudioManager.setMicrophoneMute via
 * MainActivity) and cannot be exercised from here at all. What CAN be exercised is the path
 * that runs when a reply is cut off mid-playback — the interrupt the Stop control sends, the
 * sidecar abandoning an in-flight TTS stream, and the truncation evidence that proves the audio
 * actually stopped rather than a button merely looking pressed.
 *
 * That evidence only exists because of the finish() fix earlier in this work: before it, a
 * playback cut short logged NOTHING, so "the reply stopped" and "the reply finished" were
 * indistinguishable in the record.
 *
 * Needs the gateway up. Usage: npm run e2e-interrupt
 */
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs'));
const OpusScript = require('opusscript');
const GLOG = join(homedir(), '.hermes/logs/gateway.log');

const UTT = process.argv[2]
  || 'Please count slowly from one to twenty, saying each number as a separate word.';

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, d); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Timestamps, NOT byte offsets. gateway.log rotates at 5MB, and a rotation mid-run leaves a
 * byte offset pointing into a file that no longer exists — slice() then returns '' and the
 * assertion reports "no truncation" while the log plainly shows it. That is the same rotation
 * bug device-watch had with `tail -f`, wearing a different hat. Reads the rotated file too, so
 * a line written just before the roll is not lost. */
const logStamp = () => {
  // LOCAL time, not toISOString(). gateway.log stamps lines in local time; an ISO stamp is UTC,
  // which here is 7 hours in the FUTURE, so every line failed the filter and the test reported
  // "no truncation" while the log showed a 1168-frame reply cut at frame 53.
  const d = new Date(Date.now() - 2000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
       + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
function logSinceStamp(stamp) {
  let text = '';
  for (const f of [GLOG + '.1', GLOG]) {
    try { text += readFileSync(f, 'utf8'); } catch {}
  }
  return text.split('\n').filter((l) => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return m && m[1] >= stamp;
  }).join('\n');
}
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return fn(); };

/* ---- synthesize the prompt as 48k opus, same as the real mic path ---- */
const RATE = 48000, FRAME = 960;
const wav = join('/tmp', `agentmob-int-${Date.now()}.wav`);
execFileSync('say', ['-o', wav, '--data-format=LEI16@48000', '--channels=1', UTT]);
const raw = readFileSync(wav);
const pcm = raw.subarray(44);
const enc = new OpusScript(RATE, 1);
const frames = [];
for (let i = 0; i + FRAME * 2 <= pcm.length; i += FRAME * 2) frames.push(enc.encode(pcm.subarray(i, i + FRAME * 2), FRAME));
console.log(`interrupt test — "${UTT}"`);
console.log(`  ${(frames.length * 20 / 1000).toFixed(1)}s speech, ${frames.length} frames\n`);

const logOff = logStamp();
const s = new AgentStream({ url: 'ws://127.0.0.1:8123', onPair: async () => true });
await s.connect();
ok(!!s.channel, 'AEAD control channel up');

/* ---- negotiate WebRTC so the reply comes back as RTP we can count ---- */
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
const mic = new MediaStreamTrack({ kind: 'audio' });
pc.addTransceiver(mic, { direction: 'sendrecv' });

let downlink = 0, lastDownlinkAt = 0;
pc.onTrack.subscribe((track) => {
  track.onReceiveRtp.subscribe(() => { downlink++; lastDownlinkAt = Date.now(); });
});

await pc.setLocalDescription(await pc.createOffer());
await sleep(1200);
const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp }, { timeoutMs: 20000 });
const answer = reply && reply.webrtc && reply.webrtc.sdp;
ok(!!answer, 'sidecar answered the offer');
const opusPT = Number((answer.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1]);
await pc.setRemoteDescription({ type: 'answer', sdp: answer });
ok(await waitFor(() => pc.connectionState === 'connected', 25000), `ICE connected (${pc.connectionState})`);

/* ---- speak ---- */
let seq = (Math.random() * 30000) | 0, ts = 0;
for (const f of frames) {
  mic.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: seq++ & 0xffff, timestamp: ts, payloadType: opusPT, ssrc: 1234 }), f));
  ts += FRAME;
  await sleep(20);
}
console.log(`  streamed ${frames.length} frames; waiting for the reply to start…\n`);

/* ---- wait until the agent is ACTUALLY speaking, then cut it off ---- */
/* Wait for a reply that is actually WORTH interrupting. At ~20 packets the reply may already
 * be over, and cutting nothing proves nothing: two of three early runs produced no truncation
 * simply because the agent had finished speaking first. 60 packets is ~1.2s of audio still in
 * flight, so the interrupt has something to land on. */
const MIN_BEFORE_CUT = 60;
const started = await waitFor(() => downlink > MIN_BEFORE_CUT, 180000);
ok(started, `the agent is mid-reply (downlink ${downlink} RTP, needed >${MIN_BEFORE_CUT})`,
   'the reply was too short to interrupt meaningfully — nothing to cut');
if (!started) {
  console.log('\n  the agent never produced a reply long enough to interrupt; '
    + 'rerun with a prompt that asks for a longer answer.');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const atInterrupt = downlink;
const offBefore = logStamp();
console.log(`  interrupting after ${atInterrupt} downlink packets…`);
await s.cmd({ cmd: 'interrupt' }, { timeoutMs: 8000 }).catch(() => {});
const tInterrupt = Date.now();

/* ---- the audio must actually STOP ---- */
await sleep(2500);
const afterStop = downlink;
await sleep(2000);
const settled = downlink;

ok(settled === afterStop, `downlink stopped after the interrupt (${atInterrupt} -> ${afterStop} -> ${settled})`);
const quietFor = Date.now() - lastDownlinkAt;
ok(quietFor > 1500, `no further audio for ${(quietFor / 1000).toFixed(1)}s`);

/* ---- and the sidecar must SAY it was cut short ----
 * POLLED, not read once. The line travels sidecar stderr -> adapter -> python logger -> file,
 * and that pipeline lags the wire by seconds. Reading immediately reported "no truncation"
 * while the log already showed the reply cut at frame 15 of 162 — the assertion was racing the
 * logging, not observing the sidecar. */
await waitFor(() => /\[cut short after /.test(logSinceStamp(offBefore)), 30000);
const tail = logSinceStamp(offBefore);
const cut = tail.match(/→ phone pcm .*\[cut short after (\d+)\/(\d+) frames: ([^\]]+)\]/);
ok(!!cut, 'the sidecar recorded the playback as CUT SHORT, not completed');
if (cut) {
  console.log(`  sidecar: cut at ${cut[1]}/${cut[2]} frames — ${cut[3]}`);
  ok(Number(cut[1]) < Number(cut[2]), `it stopped before the end (${cut[1]} of ${cut[2]})`);
  ok(/superseded|interrupt/i.test(cut[3]), `the reason names the interrupt (${cut[3]})`);
}
ok(/via WebRTC/.test(tail), 'the interrupted reply was on the WebRTC path, not a fallback');

/* lastDownlinkAt - tInterrupt is NEGATIVE whenever the interrupt works, because the last
 * packet necessarily arrived BEFORE the interrupt that stopped them. It was printed as a
 * latency and read "-0.0s" on every successful run — a meaningless number presented as a
 * result. What is actually measurable is how much audio arrived AFTER the interrupt (zero) and
 * how long it has been quiet since. */
const afterInterrupt = lastDownlinkAt > tInterrupt ? lastDownlinkAt - tInterrupt : 0;
ok(afterInterrupt === 0, 'no audio packet arrived after the interrupt',
  `last packet landed ${afterInterrupt}ms AFTER the interrupt`);
console.log(`\n  downlink total ${downlink} RTP | 0 packets after the interrupt | `
  + `quiet for ${(quietFor / 1000).toFixed(1)}s`);
console.log(`\n${pass} passed, ${fail} failed`);
try { pc.close(); } catch {}
try { s.close?.(); } catch {}
process.exit(fail ? 1 : 0);
