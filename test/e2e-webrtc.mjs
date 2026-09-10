// e2e-webrtc.mjs — the H3 MEDIA path: a fake phone that negotiates REAL WebRTC
// with the live sidecar, then speaks over the SRTP mic track and listens for the
// agent's reply on the downlink track.
//
// Why this exists: every run of e2e-voice logs `webrtc ready=false`, so the TTS
// downlink silently falls back to the WebSocket. That fallback is exactly what
// masked H3 — the media path has never been exercised at all without a device.
// This drives it end to end in Node:
//
//   offer (werift) -> sidecar handleOffer -> answer + opus PT
//   ICE -> connected -> mic opus over SRTP -> VAD/whisper -> agent turn
//   agent TTS -> sidecar writeReply -> RTP on OUR receiver (downlink proof)
//
// Needs the gateway up. Usage: npm run e2e-webrtc ["utterance"]
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { unpack, T } from '../transport/wsframes.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const OpusScript = createRequire('/Users/terra/.hermes/plugins/agentmob/sidecar/index.mjs')('opusscript');

const UTT = process.argv.filter((a) => !a.startsWith('--'))[2]
  || 'What is six times seven? Answer in one short sentence.';
let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, d); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
  return fn();
};

// ---- 1. synthesize the utterance as 48k opus (WebRTC clock rate) -------------
const RATE = 48000, FRAME = 960;           // 20ms @ 48k, matches the negotiated clock
const dir = mkdtempSync(join(tmpdir(), 'e2ertc-'));
execFileSync('say', ['-v', 'Samantha', '-o', join(dir, 'u.aiff'), UTT]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'u.aiff'),
  '-ar', String(RATE), '-ac', '1', '-f', 's16le', join(dir, 'u.raw')]);
const speech = readFileSync(join(dir, 'u.raw'));
const sil = (ms) => Buffer.alloc(RATE * 2 * ms / 1000);
const pcm = Buffer.concat([sil(400), speech, sil(6000)]);   // trailing > SILENCE_MS closes the utterance
console.log(`\nH3 media path — "${UTT}"`);
console.log(`  ${(speech.length / 2 / RATE).toFixed(1)}s speech @ ${RATE}Hz, ${pcm.length / 2 / FRAME | 0} frames to send\n`);

// ---- 2. AEAD control channel (same as the real phone) -----------------------
const events = [];
let wsAudioFrames = 0;
const s = new AgentStream({ url: 'ws://127.0.0.1:8123', onPair: async () => true });
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
    if (d && d.type === 'text') console.log(`  ← text: ${JSON.stringify(d.text).slice(0, 120)}`);
  } else if (f.type === T.audio) { wsAudioFrames++; }   // the FALLBACK path we want to see unused
};
await s.connect();
ok(true, 'AEAD control channel up');

// ---- 3. the phone's PeerConnection: offer with a real mic track --------------
const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
const micTrack = new MediaStreamTrack({ kind: 'audio' });
const micSender = await pc.addTrack(micTrack);

let downlinkPkts = 0, downlinkBytes = 0, downlinkPT = null;
pc.onTrack.subscribe((track) => {
  track.onReceiveRtp.subscribe((pkt) => {
    downlinkPkts++; downlinkBytes += pkt.payload.length;
    if (downlinkPT === null) downlinkPT = pkt.header.payloadType;
  });
});
const states = [];
(pc.connectionStateChange ?? pc.iceConnectionStateChange)?.subscribe?.((st) => { states.push(st); });

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
// Non-trickle: wait for gathering so the offer carries our candidates.
await waitFor(() => pc.iceGatheringState === 'complete', 8000);
ok(/m=audio/.test(pc.localDescription.sdp), 'offer contains an audio m-line');
ok(/opus\/48000/i.test(pc.localDescription.sdp), 'offer advertises opus/48000');

// ---- 4. exchange over the SAME AEAD cmd channel the phone uses ---------------
const ansReply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
  { timeoutMs: 20000 }).catch((e) => ({ err: String(e.message || e) }));
const answer = ansReply && ansReply.webrtc;
ok(answer && answer.rtype === 'answer' && !!answer.sdp,
  'sidecar returned an SDP answer over the encrypted cmd channel', JSON.stringify(ansReply).slice(0, 120));
if (!answer || !answer.sdp) { console.log('\nno answer — aborting'); process.exit(1); }

const opusPT = (answer.sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1];
ok(!!opusPT, `answer negotiates opus, payload type ${opusPT}`);
await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
ok(true, 'answer applied as remote description');

// Trickle any candidate we gathered after the offer, exactly as the phone does.
let cands = 0;
pc.onIceCandidate.subscribe(async (e) => {
  if (!e || !e.candidate) return;
  cands++;
  await s.cmd({ cmd: 'webrtc', sdp_type: 'candidate', candidate: {
    candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex,
  } }, { timeoutMs: 5000 }).catch(() => {});
});

// ---- 5. ICE/DTLS must actually reach connected (this is what H3 never proved) -
const connected = await waitFor(() => /connected|completed/.test(states[states.length - 1] || ''), 25000);
ok(connected, `ICE/DTLS reached connected (states: ${states.join(' -> ') || 'none'})`);
if (!connected) { console.log('\nnever connected — aborting before media'); s.close(); pc.close(); process.exit(1); }

// ---- 6. speak over SRTP: real opus RTP on the mic track ----------------------
const enc = new OpusScript(RATE, 1);
const ptNum = Number(opusPT);
let seq = (Math.random() * 60000) | 0, ts = 0, sent = 0;
const t0 = Date.now();
for (let off = 0; off + FRAME * 2 <= pcm.length; off += FRAME * 2) {
  const payload = Buffer.from(enc.encode(pcm.subarray(off, off + FRAME * 2), FRAME));
  const header = new RtpHeader({ payloadType: ptNum, sequenceNumber: (seq++) % 65536, timestamp: ts >>> 0, ssrc: micSender.ssrc ?? 424242, marker: sent === 0 });
  micTrack.writeRtp(new RtpPacket(header, payload));
  ts = (ts + FRAME) >>> 0; sent++;
  const due = t0 + sent * 20, wait = due - Date.now();
  if (wait > 0) await sleep(wait);
}
ok(sent > 100, `streamed ${sent} opus RTP packets over SRTP (${(sent * 20 / 1000).toFixed(1)}s)`);

// ---- 7. the agent must hear it and answer -----------------------------------
console.log('  waiting for the agent (up to 120s)…');
const heard = await waitFor(() => events.some((d) => d && d.type === 'status' && d.heard), 60000);
ok(heard, 'sidecar transcribed the SRTP mic audio (status.heard)');
const spoke = await waitFor(() => events.some((d) => d && d.type === 'text')
  || events.some((d) => d && d.type === 'render'), 120000);
ok(spoke, 'agent produced a reply for the utterance');

// ---- 8. downlink: TTS must arrive as RTP on our receiver, not the WS fallback -
const gotDownlink = await waitFor(() => downlinkPkts > 0, 45000);
ok(gotDownlink, `agent TTS arrived as RTP on the WebRTC downlink (${downlinkPkts} pkts, ${downlinkBytes}B, PT ${downlinkPT})`);
await sleep(2500);
ok(wsAudioFrames === 0,
  `downlink did NOT fall back to the WebSocket (ws audio frames: ${wsAudioFrames})`,
  wsAudioFrames ? 'sidecar still considered webrtc not-ready' : '');

console.log(`\n  states: ${states.join(' -> ')}`);
console.log(`  uplink ${sent} RTP  |  downlink ${downlinkPkts} RTP (${downlinkBytes}B)  |  ws fallback frames ${wsAudioFrames}  |  trickled candidates ${cands}`);
console.log(`\n${pass} passed, ${fail} failed`);
s.close(); pc.close();
process.exit(fail ? 1 : 0);
