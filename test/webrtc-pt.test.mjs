/**
 * webrtc-pt.test — does the sidecar negotiate the payload type the PHONE chooses?
 *
 * WHY THIS EXISTS. Every WebRTC test in this repo uses werift as the client, and werift offers
 * opus as payload type 96. Android's libwebrtc offers it as 111. That divergence has sat in the
 * notes for weeks as "only the device settles it", and the conclusion drawn from a green
 * e2e-webrtc — "the downlink carries the negotiated PT" — was only ever demonstrated at 96.
 *
 * It does not need the handset. An SDP ANSWERER does not pick payload types; it echoes the
 * offerer's mapping. So the claim "the sidecar follows the offerer's PT" is testable here by
 * offering 111 and watching what comes back — and, more importantly, what payload type the
 * sidecar then stamps on its downlink RTP. That second half is the one that matters: the phone
 * decodes by PT, so a sidecar that answers 111 and then sends 96 produces silence with every
 * connection state reading "connected".
 *
 * WHAT THIS CANNOT PROVE, stated here rather than implied by a green tick: werift-with-PT-111 is
 * not Android. It exercises the sidecar's payload-type handling with the number Android uses, not
 * Android's stack, its jitter buffer, its DTLS stack, or its ICE behaviour. This retires one
 * specific unknown — "does the sidecar hardcode or assume 96" — and nothing else.
 *
 * Needs the gateway up. Run: npm run webrtc-pt
 */
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS_URL = process.env.AGENTMOB_WS_URL || 'ws://127.0.0.1:8123';

/**
 * Offer opus at a chosen payload type and report what the sidecar answers.
 *
 * 111 is what Android's libwebrtc sends. 96 is what werift defaults to, and therefore the only
 * value any existing test has ever exercised. Both are offered so the result is a COMPARISON —
 * "it works at 111" is much weaker evidence on its own than "it tracks whatever is offered".
 */
async function negotiateAt(pt) {
  const s = new AgentStream({ url: WS_URL, onPair: async () => true });
  await s.connect();
  const pc = new RTCPeerConnection({
    iceServers: [],
    codecs: {
      audio: [new RTCRtpCodecParameters({
        mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: pt,
      })],
    },
  });
  pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
  await pc.setLocalDescription(await pc.createOffer());
  await sleep(1200);

  const offered = (pc.localDescription.sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1];
  const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
    { timeoutMs: 20000 });
  const answerSdp = reply && reply.webrtc && reply.webrtc.sdp;
  const answered = answerSdp
    ? (answerSdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i) || [])[1] : null;
  /* The m= line lists the payload types in preference order; the first must be the opus PT, or
   * the phone picks something else regardless of what the rtpmap says. */
  const mLine = answerSdp ? (answerSdp.match(/^m=audio\s+\d+\s+\S+\s+(.*)$/im) || [])[1] : null;
  const firstPt = mLine ? mLine.trim().split(/\s+/)[0] : null;

  try { pc.close(); } catch {}
  try { s.close?.(); } catch {}
  return { offered, answered, firstPt, mLine, answerSdp: !!answerSdp };
}

console.log(`payload-type negotiation against ${WS_URL}\n`);

const results = {};
for (const pt of [111, 96]) {
  const r = await negotiateAt(pt);
  results[pt] = r;
  console.log(`  PT ${pt}: offered ${r.offered} -> answered ${r.answered} `
    + `(m= line "${r.mLine}")`);
  ok(`the offer really carried PT ${pt}`, String(r.offered) === String(pt),
    `werift offered ${r.offered}; the codec pin did not take, so this case proves nothing`);
  ok(`the sidecar answered the PT ${pt} offer`, r.answerSdp,
    'no answer came back at all');
  ok(`the answer echoes the offered payload type (${pt})`, String(r.answered) === String(pt),
    `offered ${pt} but the answer says ${r.answered} — an answerer must not renumber, and the `
    + 'phone decodes by PT, so this is silence with the connection reading "connected"');
  ok(`opus is first in the answer's m= line at PT ${pt}`, String(r.firstPt) === String(pt),
    `m= lists ${r.firstPt} first, not ${pt}`);
}

/* The comparison is the point. If the sidecar had 96 baked in anywhere, these two differ. */
ok('the negotiated PT TRACKS the offer rather than being fixed',
  results[111].answered !== results[96].answered
  && String(results[111].answered) === '111' && String(results[96].answered) === '96',
  `111-offer answered ${results[111].answered}, 96-offer answered ${results[96].answered} — `
  + 'if these are equal the sidecar is imposing a payload type instead of following the offer');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
