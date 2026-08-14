// test-webrtc-loopback.mjs — prove werift's media engine carries real opus audio
// between two RTCPeerConnections (A "phone", B "gateway"), over localhost ICE.
// If werift's DTLS-SRTP + opus RTP send/receive works here, the same primitives
// work across Tailscale with the real Android libwebrtc peer.
import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, RtpPacket, RtpHeader } from 'werift';
import OpusScript from '/Users/terra/.hermes/plugins/agentmob/sidecar/node_modules/opusscript/index.js';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- two peers, host-candidate only (localhost), non-trickle SDP exchange ---
const a = new RTCPeerConnection({ iceServers: [] }); // "phone"
const b = new RTCPeerConnection({ iceServers: [] }); // "gateway"

async function gathered(pc) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pc.iceGatheringState !== 'complete') await sleep(50);
}

const gotB = [];   // opus payloads the gateway received
const gotA = [];   // opus payloads the phone received
let bCodecPT = null, aCodecPT = null;

// B (gateway) receives audio from A (phone)
b.onTrack.subscribe((track) => {
  track.onReceiveRtp.subscribe((pkt) => { gotB.push(pkt.payload); });
});
// A (phone) receives audio from B (gateway)
a.onTrack.subscribe((track) => {
  track.onReceiveRtp.subscribe((pkt) => { gotA.push(pkt.payload); });
});

import { MediaStreamTrack } from 'werift';
const outTrack = new MediaStreamTrack({ kind: 'audio' });
const aSender = await a.addTrack(outTrack);
const outTrackB = new MediaStreamTrack({ kind: 'audio' });
const bSender = await b.addTrack(outTrackB);

// Determine negotiated opus payload type from each sender once connected.
const enc = new OpusScript(24000, 1);
const dec = new OpusScript(24000, 1);
let seqA = 1000, tsA = 0, ssrcA = 0x11110001;
let seqB = 3000, tsB = 0, ssrcB = 0x22220001;

async function sendOne(sender, track, seqRef, tsRef, ssrcRef, sampleHdr) {
  // generate a 20ms frame of 24k s16: a 220Hz ramp so we can verify content
  const n = 480;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 220 * i / 24000) * 12000); pcm.writeInt16LE(v, i * 2); }
  const opus = enc.encode(pcm, n);
  const pt = sender.codec?.payloadType;
  if (!pt) return;
  // werift leaves timestampOffset/seqOffset undefined until its replaceRTP path
  // fires; we supply absolute seq/timestamp, so force neutral offsets.
  sender.timestampOffset ??= 0;
  sender.seqOffset ??= 0;
  const header = new RtpHeader({
    version: 2, ssrc: ssrcRef.value,
    sequenceNumber: seqRef.value++ % 65536,
    timestamp: tsRef.value, payloadType: pt,
  });
  const pkt = new RtpPacket(header, opus);
  track.writeRtp(pkt);
  tsRef.value += 480;
  return opus.length;
}

// --- offer/answer (non-trickle: gather, then exchange full SDP) ---
const offer = await a.createOffer();
await a.setLocalDescription(offer);
await gathered(a);
await b.setRemoteDescription(a.localDescription);          // passes a's host candidates
await b.setLocalDescription(await b.createAnswer());
await gathered(b);
await a.setRemoteDescription(b.localDescription);          // passes b's host candidates
console.log('offer/answer exchanged (gathering state a=%s b=%s)', a.iceGatheringState, b.iceGatheringState);

// wait for DTLS-SRTP to connect (long enough for host-candidate + DTLS handshake)
let connected = false;
const dl = Date.now() + 15000;
while (Date.now() < dl) {
  const cs = [a, b].some(p => (p.connectionState ?? p.iceConnectionState) === 'connected')
    && [a, b].some(p => (p.connectionState ?? p.iceConnectionState) === 'connected');
  if ([a, b].every(p => (p.connectionState ?? p.iceConnectionState) === 'connected') && aSender.codec && bSender.codec) { connected = true; break; }
  await sleep(100);
}
console.log('connected=', connected, 'state a=', a.connectionState ?? a.iceConnectionState,
            ' b=', b.connectionState ?? b.iceConnectionState);
console.log('sender codecs: aPT=%s bPT=%s', aSender.codec?.payloadType, bSender.codec?.payloadType);

if (connected) {
  // send 20 frames each way (address only after codecs negotiated)
  for (let i = 0; i < 20; i++) {
    await sendOne(aSender, outTrack, {value:seqA}, {value:tsA}, {value:ssrcA});
    await sendOne(bSender, outTrackB, {value:seqB}, {value:tsB}, {value:ssrcB});
    await sleep(10);
  }
  await sleep(300); // let SRTP/RTCP settle
}

console.log('gateway received opus frames from phone:', gotB.length);
console.log('phone   received opus frames from gateway:', gotA.length);
const ok = gotB.length > 0 && gotA.length > 0;
// decode one to prove it is genuine opus -> PCM (not empty)
let probe = 0;
if (gotB.length) { const d = dec.decode(gotB[0], 480, 's16'); probe = d ? d.length : 0; }
console.log('decoded inbound frame sample count:', probe);
console.log(ok && probe > 0 ? '\nPASS: werift opus audio round-trips (DTLS-SRTP RTP)' : '\nFAIL');
await a.close(); await b.close();
process.exit(ok && probe > 0 ? 0 : 1);
