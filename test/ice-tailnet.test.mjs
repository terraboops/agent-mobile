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
 *   - our peer BINDS to the tailnet interface (iceInterfaceAddresses) and advertises the address
 *     that socket is genuinely bound to, checked against lsof
 *   - the sidecar's answer is filtered to the tailnet candidate alone
 * If ICE reaches connected, the only pair that could have formed is tailnet <-> tailnet.
 *
 * WHAT THIS IS NOT, measured rather than hedged. Both peers run on THIS host, and the route to
 * this host's own tailnet address is a LOCAL host route — `route -n get` reports
 * flags <UP,HOST,DONE,LOCAL>, against a plain 100.64.0.0/10 tunnel route for a remote peer. The
 * kernel short-circuits it, so not one byte of this test traverses WireGuard or DERP. It proves
 * the sidecar ACCEPTS and COMPLETES a pair addressed to its tailnet candidate. It does not prove
 * a remote phone can reach that candidate across the tailnet, and no arrangement of two processes
 * on one machine can: that requires a second host, and standing one up means deploying, which is
 * not this session's call. The assertion below pins the LOCAL flag so the limitation is a fact
 * the suite states, not a caveat someone has to remember.
 *
 * (An earlier version of this file said the local side "could not be forced" onto the tailnet and
 * left it there. That was wrong in the useful direction: iceInterfaceAddresses DOES bind the
 * socket correctly — lsof shows it on the tailnet address, on the same port werift was
 * advertising against the LAN address. Only the advertisement was wrong, and an advertisement is
 * fixable. The offer now tells the truth, so the pair is tailnet on BOTH sides rather than one.)
 *
 * Needs the gateway up. Run: npm run ice-tailnet
 */
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';

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
console.log('  our advertised candidates: ' + (localCands.map((c) => `${c.type} ${c.ip}:${c.port}`).join(', ') || '(none)'));
ok(localCands.length > 0, 'our peer gathered at least one candidate');
ok(!localCands.some((c) => c.type === 'srflx'),
  'our peer has no srflx candidate, so no STUN-discovered path exists',
  localCands.map((c) => `${c.type} ${c.ip}`).join(', '));

/* ---- what is our peer ACTUALLY bound to? ----------------------------------------------------
 * This is the part the suite used to get wrong ABOUT ITSELF. The old comment said
 * iceInterfaceAddresses "binds the UDP socket but werift still enumerates the default interface",
 * and treated the local side as unfixable. Measured, the binding is better than that: lsof shows
 * the socket really is on the tailnet address, on the SAME PORT werift advertises against the LAN
 * address. So the egress is already correct and only the ADVERTISEMENT is wrong — werift fills
 * the candidate string from the default interface while binding the configured one.
 *
 * A lie in the candidate is not cosmetic here: the sidecar sends its connectivity checks to the
 * address it is given, so a LAN address in our offer means the return path is LAN, and the pair
 * is tailnet-in-one-direction only. Rewriting it to the address the socket is genuinely bound to
 * makes the offer TRUE and the pair tailnet on both sides.
 *
 * The rewrite is checked against lsof rather than assumed: a candidate pointing at a port nothing
 * is listening on would still look plausible in the SDP and simply never complete. */
const udpLines = (spawnSync('lsof', ['-nP', '-p', String(process.pid), '-iUDP'], { encoding: 'utf8' }).stdout || '')
  .split('\n').filter((l) => /UDP/.test(l)).map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
const tailnetSockets = [...new Set(udpLines)].filter((b) => b.startsWith(addr + ':'));
console.log('  our UDP sockets on the tailnet address: ' + (tailnetSockets.join(', ') || '(none)'));
ok(tailnetSockets.length > 0,
  `iceInterfaceAddresses really bound a socket to ${addr}`,
  'nothing is bound to the tailnet address, so our end is NOT on the tailnet at all and the '
  + 'rest of this suite would be measuring a LAN pair');

const boundPorts = new Set(tailnetSockets.map((b) => b.slice(b.lastIndexOf(':') + 1)));
const rewritable = localCands.filter((c) => c.type === 'host' && boundPorts.has(String(c.port)));
ok(rewritable.length > 0,
  'an advertised host candidate uses a port that is bound to the tailnet address',
  `advertised ports ${localCands.map((c) => c.port).join(',')} vs tailnet-bound ${[...boundPorts].join(',')}`
  + ' — without an overlap the rewrite below would be inventing an endpoint');

/* Rewrite ONLY those host candidates, and only to the address their own socket is bound to. */
let offerSdp = pc.localDescription.sdp;
for (const c of rewritable) {
  offerSdp = offerSdp.split('\n').map((line) => (/^a=candidate:/.test(line.trim())
      && line.includes(` ${c.ip} ${c.port} typ host`))
    ? line.replace(` ${c.ip} ${c.port} typ host`, ` ${addr} ${c.port} typ host`)
    : line).join('\n');
}
const rewritten = [...offerSdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/gim)]
  .map((m) => ({ ip: m[1], port: m[2], type: m[3] }));
console.log('  our offer after rewrite:   ' + rewritten.map((c) => `${c.type} ${c.ip}:${c.port}`).join(', '));
ok(rewritten.every((c) => c.type !== 'host' || c.ip === addr),
  'every host candidate we OFFER now names the tailnet address',
  rewritten.map((c) => `${c.type} ${c.ip}`).join(', '));
ok(rewritten.every((c) => c.type !== 'host' || boundPorts.has(String(c.port))),
  'every rewritten candidate points at a port genuinely bound to the tailnet address');

/* ---- the limitation, measured -------------------------------------------------------------
 * Stated as an assertion rather than a comment so it cannot quietly stop being true. If someone
 * points this suite at a REMOTE tailnet address one day, this fails — and it should, because the
 * suite would then be testing something materially different and its claims would need rewriting
 * rather than silently widening. */
{
  const rt = spawnSync('route', ['-n', 'get', addr], { encoding: 'utf8' }).stdout || '';
  const isLocal = /flags:.*\bLOCAL\b/.test(rt);
  const iface = (/interface:\s*(\S+)/.exec(rt) || [])[1];
  console.log(`  route to ${addr}: interface ${iface}, ` + (isLocal ? 'LOCAL host route' : 'not local'));
  ok(isLocal,
    'this is a SAME-HOST pair: the route to our tailnet address is LOCAL, so no traffic here '
    + 'crosses WireGuard or DERP',
    `route -n get ${addr} did not report the LOCAL flag — if this became a genuinely remote `
    + 'peer, this suite proves more than its comments claim and they must be rewritten');
}

/* ---- ask the sidecar for an answer ---- */
const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: offerSdp },
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
  /* Print what werift ACTUALLY exposes. This used to fall back to `addr` when the nominated
   * candidate carried no host, so it printed the tailnet address as though it had been measured
   * — a log line asserting the very thing under test, from a default. */
  console.log(local?.host
    ? `\n  nominated pair uses ${local.host}`
    : '\n  nominated pair: werift does not expose the local candidate host here');
  /* Media must actually move, not merely handshake. */
  let rtp = 0;
  pc.onTrack.subscribe((t) => { t.onReceiveRtp.subscribe(() => { rtp++; }); });
  /* No assertion here, deliberately.
   *
   * There used to be `ok(true, 'DTLS/ICE established...')`, which cannot fail. Replacing it with
   * a check on the nominated pair's address does not work either: werift does not expose the
   * host for this transport, so the check would pass on an empty string — the same nothing,
   * wearing a condition.
   *
   * The claim is already made, and made properly, by "ICE reached connected over the tailnet
   * address alone" above: the answer was filtered to the tailnet candidate, so a pair that
   * formed at all could only have formed against it. A second assertion that cannot observe the
   * address adds a green tick and no evidence. */
  /* Named precisely. The pair is tailnet<->tailnet at both ends and no other path existed —
   * that is the claim. Reachability ACROSS the tailnet from another host is item #3 in
   * test/lib/device-acceptance.mjs and stays unproven here by construction. */
}

try { pc.close(); } catch {}
try { s.close?.(); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
