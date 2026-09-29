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

const s = new AgentStream({ url: URL, onPair: async () => true });
await s.connect();
say(`AEAD channel up to ${URL}`);

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
  s.cmd({ cmd: 'interrupt' }, { timeoutMs: 8000 }).then(() => say('interrupt sent (Stop)'))
    .catch((e) => say(`interrupt failed: ${e.message || e}`));
});

/* Stay up, the way the app does, until told to stop. */
const stop = () => { try { pc.close(); } catch {} try { s.close?.(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setTimeout(stop, HOLD * 1000);
