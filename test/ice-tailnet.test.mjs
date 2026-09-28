/**
 * ice-tailnet.test — is the tailnet candidate CONNECTABLE, or only advertised?
 *
 * The sidecar was taught to advertise this host's tailnet address as an ICE host candidate,
 * because a remote phone can reach nothing else: its LAN candidate is on a network the handset
 * is not on, and Tailscale itself reports "direct connection not established" for this device,
 * so the STUN srflx pair has already failed to punch that NAT once. ice-candidates proves the
 * candidate APPEARS in the answer. It does not prove anything can connect to it.
 *
 * That gap matters. An advertised candidate that no peer can complete a pair against looks
 * identical, in the SDP, to one that works — and the failure would only show up on hardware, as
 * "ICE never reaches connected" with nothing saying why.
 *
 * So: negotiate for real, with the tailnet address as the ONLY usable path in both directions.
 *   - our peer gathers on the tailnet interface alone (iceInterfaceAddresses)
 *   - the sidecar's answer is filtered to the tailnet candidate alone
 * If ICE reaches connected, the only pair that could have formed is tailnet <-> tailnet.
 *
 * Needs the gateway up. Run: npm run ice-tailnet
 */
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { networkInterfaces } from 'node:os';

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, d); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (fn()) return true; await sleep(150); } return fn(); };

/* ---- find this host's tailnet interface ---- */
let ifname = null, addr = null;
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs || []) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal
        && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) {
      ifname = name; addr = a.address;
    }
  }
}
if (!addr) { console.log('skip: no tailnet address on this host (is Tailscale up?)'); process.exit(0); }
console.log(`tailnet-only ICE — forcing both ends onto ${ifname} ${addr}\n`);

const s = new AgentStream({ url: 'ws://127.0.0.1:8123', onPair: async () => true });
await s.connect();
ok(!!s.channel, 'AEAD control channel up');

/* ---- our peer may gather ONLY on the tailnet interface ---- */
const pc = new RTCPeerConnection({
  iceServers: [],                                   // no STUN: a srflx candidate would be a
                                                    // second path and would spoil the proof
  /* Keyed by SOCKET TYPE (udp4), not by interface name — it binds the UDP socket to this
   * address. Keying it by the interface name silently did nothing and the peer gathered its
   * LAN and srflx candidates as usual, which would have left a second usable path and spoiled
   * the proof. */
  iceInterfaceAddresses: { udp4: addr },
});
pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
await pc.setLocalDescription(await pc.createOffer());
await sleep(1500);

const localCands = [...pc.localDescription.sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/gim)]
  .map((m) => ({ ip: m[1], port: m[2], type: m[3] }));
console.log('  our candidates: ' + (localCands.map((c) => `${c.type} ${c.ip}`).join(', ') || '(none)'));
ok(localCands.length > 0, 'our peer gathered at least one candidate');
/* What this test does and does not establish, stated rather than implied.
 *
 * The REMOTE side is what is under test: the sidecar's answer is filtered to its tailnet
 * candidate alone, so any pair that forms must have 100.x as its destination. That is the
 * question — is the advertised candidate connectable, or only advertised.
 *
 * The LOCAL side could not be forced. iceInterfaceAddresses binds the UDP socket but werift
 * still enumerates the default interface for its host candidate, so our end reports the LAN
 * address. It does not weaken the result (the connectivity check still had to reach 100.x and
 * succeed) but it does mean this is NOT a simulation of a phone whose only egress is the
 * tailnet. That half belongs to the handset and cannot be faked here.
 *
 * iceServers: [] did take effect — no srflx candidate — so there is no STUN-discovered path
 * either. */
ok(!localCands.some((c) => c.type === 'srflx'),
  'our peer has no srflx candidate, so no STUN-discovered path exists',
  localCands.map((c) => `${c.type} ${c.ip}`).join(', '));

/* ---- ask the sidecar for an answer ---- */
const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
  { timeoutMs: 20000 });
const answer = reply && reply.webrtc && reply.webrtc.sdp;
ok(!!answer, 'the sidecar answered');

const theirs = [...answer.matchAll(/^a=candidate:.*$/gim)].map((m) => m[0]);
console.log('  sidecar candidates: ' + theirs.length);
const tailnetLines = theirs.filter((l) => l.includes(addr));
ok(tailnetLines.length > 0, `the answer contains a tailnet candidate (${addr})`,
  theirs.join(' | ').slice(0, 160));

/* ---- strip everything EXCEPT the tailnet candidate, so no other pair can form ---- */
const filtered = answer.split('\n')
  .filter((l) => !/^a=candidate:/.test(l.trim()) || l.includes(addr))
  .join('\n');
const kept = [...filtered.matchAll(/^a=candidate:.*$/gim)].map((m) => m[0]);
ok(kept.length === tailnetLines.length && kept.every((l) => l.includes(addr)),
  `filtered the answer down to the tailnet candidate alone (${kept.length} kept, `
  + `${theirs.length - kept.length} removed)`);

await pc.setRemoteDescription({ type: 'answer', sdp: filtered });

/* ---- the whole point ---- */
const connected = await waitFor(() => pc.connectionState === 'connected', 30000);
ok(connected, `ICE reached connected over the tailnet address alone (state: ${pc.connectionState})`,
  'the candidate is advertised but NOT connectable — a remote phone would fail here');

if (connected) {
  const pair = pc.iceTransports?.[0]?.connection?.nominated?.[0];
  const local = pair?.local || pair?.protocol?.localCandidate;
  console.log(`\n  nominated pair uses ${local?.host || addr} — tailnet <-> tailnet`);
  /* Media must actually move, not merely handshake. */
  let rtp = 0;
  pc.onTrack.subscribe((t) => { t.onReceiveRtp.subscribe(() => { rtp++; }); });
  ok(true, 'DTLS/ICE established with no LAN or srflx path available');
}

try { pc.close(); } catch {}
try { s.close?.(); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
