#!/usr/bin/env node
/**
 * sim-phone — the app's side of the handshake, run against a real sidecar.
 *
 * WHY. device-verify's handshake and surface phases were described as "waiting on a real phone".
 * They are not: they wait on the SIDECAR writing lines — handshake confirmed, PAIRING, webrtc
 * answer sent opusPT=, webrtc ICE pair — and a sidecar writes those for any client that does the
 * protocol. This does the protocol the way the app does: an AEAD handshake over the WS, then a
 * WebRTC offer at opus payload type 111 (Android libwebrtc's number, not werift's default 96),
 * candidates trickled over the same encrypted cmd channel, and the connection held open for as
 * long as the app would be running.
 *
 * WHAT IT IS NOT. It is not libwebrtc. It is werift told to offer 111, which exercises the
 * sidecar's handling of that number and nothing about Android's stack. See webrtc-pt.
 *
 *   --url ws://127.0.0.1:PORT   the sidecar
 *   --pt 111                    opus payload type to offer
 *   --break-webrtc              INJECTED FAILURE: send the offer, never apply the answer, so ICE
 *                               never completes and the sidecar has to fall back to the WS
 *                               downlink. This is the failure the fallback path exists for.
 *   --hold SECONDS              how long to stay connected (the app stays up; default 600)
 *   --java-phone CLASSPATH      run the app's SHIPPED audio path (lib/java-phone.mjs) behind
 *                               this client: downlink audio goes to decodePlay, Stop flushes
 *                               the shipped queues before the interrupt, the mic button is the
 *                               shipped toggle, and the shipped encodeLoop's uplink goes to the
 *                               sidecar. Its log, audio state and what the speaker played are
 *                               written to SIM_PHONE_OUT.{logcat,audio.json,speaker.json,uplink}
 *   --mic                       start the shipped capture loop (a mic in a room with a tone)
 *   --honor-mute                the stub mic goes silent under AudioManager's mute; without it
 *                               the mic IGNORES the mute — hardware that does not honour it
 *   --link-fps N                deliver downlink frames to the app at most N per second — a slow
 *                               link, so part of a burst is still in flight when Stop is pressed
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift';
import { AgentStream } from '../../transport/ws-client.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const URL = String(flag('--url', 'ws://127.0.0.1:8897'));
const PT = Number(flag('--pt', 111));
const BREAK = argv.includes('--break-webrtc');
const HOLD = Number(flag('--hold', 600));
const say = (m) => process.stderr.write(`[sim-phone] ${m}\n`);
const JAVA_CP = flag('--java-phone', null);
const MIC = argv.includes('--mic');
const HONOR = argv.includes('--honor-mute');
const LINK_FPS = Number(flag('--link-fps', 0));
const OUTP = process.env.SIM_PHONE_OUT || null;

const s = new AgentStream({ url: URL, onPair: async () => true });
await s.connect();
say(`AEAD channel up to ${URL}`);

/* ---- the shipped audio path, when asked for ---- */
let java = null;
if (JAVA_CP) {
  const { spawn } = await import('node:child_process');
  const { appendFileSync, writeFileSync } = await import('node:fs');
  java = spawn('java', ['-cp', String(JAVA_CP), 'PhoneAudio', HONOR ? 'honor' : 'ignore'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const audioState = {};
  let jb = '';
  java.stdout.on('data', (d) => {
    jb += d; const ls = jb.split('\n'); jb = ls.pop();
    for (const l of ls) {
      if (l.startsWith('UP ')) {
        const pl = Buffer.from(l.slice(3), 'base64');
        try { s.sendAudio(pl.readUInt32BE(0), Number(pl.readBigUInt64BE(4)), pl.subarray(12)); } catch {}
        if (OUTP) appendFileSync(`${OUTP}.uplink`, `${Date.now()} UP\n`);
      } else if (l.startsWith('L ') && OUTP) {
        const [, lvl, ...rest] = l.split(' ');
        const d = new Date(); const p = (n, w = 2) => String(n).padStart(w, '0');
        appendFileSync(`${OUTP}.logcat`, `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:`
          + `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} 4242 4242 ${lvl} ${rest.join(' ')}\n`);
      } else if (l.startsWith('ST ')) {
        Object.assign(audioState, JSON.parse(l.slice(3)));
        if (OUTP) writeFileSync(`${OUTP}.audio.json`, JSON.stringify(audioState));
      } else if (l.startsWith('SPK ') && OUTP) {
        writeFileSync(`${OUTP}.speaker.json`, l.slice(4));
      }
    }
  });
  /* Downlink: the plaintext of each audio frame, exactly what the app's onFrame hands decodePlay
   * (u32 seq, u64 ts, opus). At --link-fps the frames queue here, as they would in a slow pipe. */
  /* The pipe carries audio AND control replies in arrival order — a slow link delays both, and
   * the ack must never overtake audio that was sent before it. */
  const pipe = [];
  const deliver = (line) => { try { java.stdin.write(line + '\n'); } catch {} };
  const toJava = (line) => { if (LINK_FPS > 0) pipe.push(line); else deliver(line); };
  s.onRemoteAudio = (seq, rest) => {
    const h = Buffer.alloc(4); h.writeUInt32BE(seq >>> 0, 0);
    toJava(`A ${Buffer.concat([h, rest]).toString('base64')}`);
  };
  global.__controlReply = (d) => toJava(`C ${JSON.stringify(d)}`);
  if (LINK_FPS > 0) setInterval(() => { const l = pipe.shift(); if (l) deliver(l); }, Math.max(1, Math.round(1000 / LINK_FPS)));
  s.onPush = (d) => {
    if (OUTP && d && typeof d.level === 'number') appendFileSync(`${OUTP}.uplink`, `${Date.now()} LEVEL ${d.level}\n`);
  };
  if (MIC) java.stdin.write('MICSTART\n');
  say(`shipped audio path running (${HONOR ? 'mic honours' : 'mic IGNORES'} the hardware mute${LINK_FPS ? `, link ${LINK_FPS} fps` : ''})`);
}
const dumpJava = () => new Promise((res) => {
  if (!java) return res();
  try { java.stdin.write('DUMP\n'); } catch { return res(); }
  setTimeout(() => { try { java.stdin.write('QUIT\n'); } catch {} setTimeout(res, 200); }, 400);
});

const pc = new RTCPeerConnection({
  iceServers: [],
  codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000,
                                                channels: 2, payloadType: PT })] },
});
await pc.addTrack(new MediaStreamTrack({ kind: 'audio' }));
await pc.setLocalDescription(await pc.createOffer());
const t0 = Date.now();
while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));

const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
                          { timeoutMs: 20000 }).catch((e) => ({ err: String(e.message || e) }));
const answer = reply && reply.webrtc;
if (!answer || !answer.sdp) { say(`no answer: ${JSON.stringify(reply).slice(0, 120)}`); }
else if (BREAK) {
  /* The injected failure. The sidecar has sent its answer and is waiting for ICE; the app never
   * applies it, so no pair ever forms — the same end state as an unroutable candidate, which is
   * the case the WS fallback and the ICE deadline exist for. */
  say('INJECTED: answer received and deliberately NOT applied — ICE will never complete');
} else {
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  pc.onIceCandidate.subscribe(async (e) => {
    if (!e || !e.candidate) return;
    await s.cmd({ cmd: 'webrtc', sdp_type: 'candidate', candidate: {
      candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid,
      sdpMLineIndex: e.candidate.sdpMLineIndex } }, { timeoutMs: 5000 }).catch(() => {});
  });
  say(`answer applied (opus PT ${(answer.sdp.match(/a=rtpmap:(\d+)\s+opus/i) || [])[1]})`);
}

/* The Stop control. bridge.js sends {"cmd":"interrupt"} over this same AEAD channel; the
 * scripted adb signals SIGUSR1 when a tap lands on Stop, and this sends it. The TRUNCATION is
 * then the real sidecar's decision, not the harness's. */
process.on('SIGUSR1', () => {
  /* bridge.js order: the local flush FIRST, then the interrupt round trip. */
  if (java) { try { java.stdin.write('STOP\n'); } catch {} }
  s.cmd({ cmd: 'interrupt' }, { timeoutMs: 8000 })
    .then((d) => { if (global.__controlReply) global.__controlReply(d); say('interrupt sent (Stop)'); })
    .catch((e) => say(`interrupt failed: ${e.message || e}`));
});

/* The native mic button (MainActivity) — the shipped toggle, when the shipped path is running. */
process.on('SIGUSR2', () => { if (java) { try { java.stdin.write('MICTOGGLE\n'); } catch {} } });
/* A timestamp on the app's own clock, for a test marking "from here on" (SIGHUP). */
process.on('SIGHUP', () => { if (java) { try { java.stdin.write('MARK\n'); } catch {} } });

/* Stay up, the way the app does, until told to stop. */
const stop = async () => { await dumpJava(); try { pc.close(); } catch {} try { s.close?.(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setTimeout(stop, HOLD * 1000);
