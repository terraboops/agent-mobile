// test-webrtc-module.mjs — validate the sidecar's webrtc-media.mjs WebRtcPeer
// against a fake "phone" (a raw werift RTCPeerConnection): offer/answer through
// the module, mic uplink -> onUtterance, and reply downlink -> phone received.
import {
  MediaStreamTrack as RawTrack, RtpHeader, RtpPacket, RTCPeerConnection,
} from '/Users/terra/Developer/agent-mobile/node_modules/werift/lib/index.mjs';
import OpusScript from '/Users/terra/.hermes/plugins/agentmob/sidecar/node_modules/opusscript/index.js';
import { createWebRtcSignal } from '/Users/terra/.hermes/plugins/agentmob/sidecar/webrtc-media.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function gathered(pc) { const d = Date.now() + 6000; while (Date.now() < d && pc.iceGatheringState !== 'complete') await sleep(50); }

const enc = new OpusScript(24000, 1);
const dec = new OpusScript(24000, 1);
const ups = [];   // gateway-side utterances received
const downs = []; // phone-side frames received

// --- fake phone ---
const phone = new RTCPeerConnection({ iceServers: [] });
phone.onTrack.subscribe((tr) => tr.onReceiveRtp.subscribe((pkt) => downs.push(pkt.payload)));
const mic = new RawTrack({ kind: 'audio' });
const micSender = await phone.addTrack(mic);

// --- gateway module ---
const { WebRtcPeer } = createWebRtcSignal();
const gw = new WebRtcPeer({ onUtterance: (opus) => ups.push(opus) }, { iceServers: [] });

// phone offers
const off = await phone.createOffer();
await phone.setLocalDescription(off); await gathered(phone);
// gateway consumes offer -> answer
const ans = await gw.handleOffer(phone.localDescription.sdp);
console.log('handleOffer answered, gateway opusPT=', gw.opusPT, 'answerSdpLen=', ans.sdp.length);
await receivedDone(phone, ans);

async function receivedDone(pc, answer) {
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  // trickle phone candidates to gateway (werift gathers post-remote)
}

// now phone sends mic uplink, gateway writes reply downlink
let seq = 1000, ts = 0, ssrc = 0x77770001;
async function phoneSend() {
  const n = 480; const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*220*i/24000)*12000), i*2);
  const opus = enc.encode(pcm, n);
  micSender.timestampOffset ??= 0; micSender.seqOffset ??= 0;
  const hdr = new RtpHeader({ version:2, ssrc, sequenceNumber: seq++%65536, timestamp: ts, payloadType: micSender.codec?.payloadType });
  ts += 480;
  mic.writeRtp(new RtpPacket(hdr, opus));
}

const dl = Date.now() + 12000;
let connected = false;
while (Date.now() < dl) {
  if (gw.pc.connectionState === 'connected' && phone.connectionState === 'connected' && gw.opusPT) { connected = true; break; }
  await sleep(100);
}
console.log('connected=', connected, 'gwState=', gw.pc.connectionState, 'gw.ready=', gw.ready);

if (connected) {
  for (let i = 0; i < 20; i++) { await phoneSend(); await sleep(10); }
  // gateway reply downlink
  const replyOpus = enc.encode(Buffer.alloc(960), 480); // silence frame (valid opus)
  for (let i = 0; i < 20; i++) { gw.writeReply(replyOpus); await sleep(10); }
  await sleep(300);
}
console.log('gateway uplink utterances:', ups.length);
console.log('phone  downlink frames:   ', downs.length);
let ok = connected && ups.length > 0 && downs.length > 0;
if (ups.length) { const d = dec.decode(ups[0], 480, 's16'); ok = ok && d?.length > 0; }
console.log(ok ? '\nPASS: WebRtcPeer module (offer/answer + uplink + downlink)' : '\nFAIL');
await gw.close(); await phone.close();
process.exit(ok ? 0 : 1);
