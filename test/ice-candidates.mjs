/**
 * ice-candidates — will the REAL phone's WebRTC ever connect?
 *
 * e2e-webrtc proves the media path works, but it connects over loopback, so it proves nothing
 * about reachability. The Pixel is on the tailnet and can only reach this Mac at its TAILNET
 * address; the tailnet lives on a point-to-point utun interface, and ICE implementations
 * routinely skip those when enumerating host candidates. If the sidecar's answer never
 * advertises a candidate the phone can route to, the phone will negotiate, fail ICE, and fall
 * back to the WebSocket — looking exactly like the blind spot that hid H3 for weeks.
 *
 * This asks the live sidecar for an answer and reports what it actually offers to connect on.
 * It is a REACHABILITY check, not proof the phone connects — only the phone proves that.
 *
 * Exit codes are distinguishable, because "it failed" is not a diagnosis:
 *   0  ran and produced a verdict (a missing tailnet candidate is a RISK to report, not a
 *      failure of this tool — see the verdict text)
 *   2  cannot judge: no tailnet address on this host (is Tailscale up here?)
 *   3  the sidecar is not reachable — nothing is listening on the port
 *   4  the channel came up but the sidecar returned no SDP answer
 *   5  the AEAD handshake itself failed
 *   70 unexpected crash
 *
 * Run: npm run ice-candidates [--url ws://host:port]
 */
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const URL_ARG = (() => { const i = argv.indexOf('--url'); return i >= 0 ? argv[i + 1] : null; })();
const WS_URL = URL_ARG || process.env.AGENTMOB_WS_URL || 'ws://127.0.0.1:8123';

/* A raw stack trace tells you something threw, not WHAT is wrong. Anything that escapes is
 * still reported as a named state before exiting. */
process.on('unhandledRejection', (e) => { fatal(70, 'unexpected error', e && (e.stack || e.message) || String(e)); });
process.on('uncaughtException', (e) => { fatal(70, 'unexpected error', e && (e.stack || e.message) || String(e)); });

function fatal(code, headline, detail) {
  console.log(`\n${headline.toUpperCase()}`);
  if (detail) console.log('  ' + String(detail).split('\n').join('\n  '));
  process.exit(code);
}

/** Is anything listening? Asked FIRST, so "sidecar is down" never arrives as a stack trace. */
function portOpen(url, timeoutMs = 3000) {
  const m = String(url).match(/^wss?:\/\/([^/:]+):(\d+)/);
  if (!m) return Promise.resolve({ ok: false, reason: `cannot parse ${url}` });
  const [, host, port] = m;
  return new Promise((resolve) => {
    const sock = createConnection({ host, port: Number(port) });
    const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done({ ok: true, host, port }));
    sock.on('timeout', () => done({ ok: false, host, port, reason: 'timed out' }));
    sock.on('error', (e) => done({ ok: false, host, port, reason: e.code || e.message }));
  });
}

/* Every non-loopback IPv4 this host owns, with the interface it belongs to. */
const local = [];
for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4' && !a.internal) local.push({ ifname, address: a.address });
  }
}
const tailnet = local.filter((a) => /^100\./.test(a.address));

console.log('host IPv4 interfaces:');
for (const a of local) console.log(`  ${a.ifname.padEnd(10)} ${a.address}${/^100\./.test(a.address) ? '   <- tailnet' : ''}`);
if (!tailnet.length) {
  fatal(2, 'cannot judge reachability',
    'No 100.64/10 address on this host, so there is no tailnet path to compare against.\n'
    + 'Is Tailscale up here? (tailscale status)');
}

const probe = await portOpen(WS_URL);
if (!probe.ok) {
  console.log('');
  fatal(3, 'sidecar not reachable',
    `Nothing is listening on ${probe.host}:${probe.port} (${probe.reason}).\n`
    + `The agentmob sidecar is started and supervised by the Hermes gateway, so this normally\n`
    + `means the gateway is down. Check and restart:\n`
    + `  lsof -nP -iTCP:${probe.port} -sTCP:LISTEN\n`
    + `  launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway\n`
    + `(Probe with lsof, NOT bash /dev/tcp — zsh does not support it and reports a false DOWN.)`);
}

const s = new AgentStream({ url: WS_URL, onPair: async () => true });
try {
  await s.connect();
} catch (e) {
  fatal(5, 'AEAD handshake failed',
    `${probe.host}:${probe.port} accepted the TCP connection but the encrypted channel did not\n`
    + `come up: ${e && e.message || e}\n`
    + `If the sidecar has AGENTMOB_ALLOWED_CLIENTS pinned, this client is not on the allowlist.`);
}
console.log(`\nAEAD channel up (${WS_URL}).`);

const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
const track = new MediaStreamTrack({ kind: 'audio' });
pc.addTransceiver(track, { direction: 'sendrecv' });
await pc.setLocalDescription(await pc.createOffer());
await sleep(1500);   // let gathering settle

const reply = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
  { timeoutMs: 20000 });
const answer = (reply && reply.webrtc && reply.webrtc.sdp) || '';
if (!answer) {
  fatal(4, 'no SDP answer',
    'The channel is up and the offer was accepted, but the sidecar returned no answer.\n'
    + 'Its WebRTC module may have failed to load — check the gateway log for "webrtc err".');
}

/* a=candidate:<foundation> <comp> <proto> <pri> <ip> <port> typ <type> ... */
const cands = [...answer.matchAll(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/gim)]
  .map((m) => ({ proto: m[1], ip: m[2], port: +m[3], type: m[4] }));

console.log(`\nsidecar answer advertises ${cands.length} candidate(s):`);
for (const c of cands) {
  const tn = /^100\./.test(c.ip);
  console.log(`  ${c.type.padEnd(6)} ${c.proto.padEnd(4)} ${c.ip}:${c.port}${tn ? '   <- TAILNET (phone-routable)' : ''}`);
}

const hasTailnet = cands.some((c) => /^100\./.test(c.ip));
const hasSrflx = cands.some((c) => c.type === 'srflx');
const hasLanHost = cands.some((c) => c.type === 'host' && !/^100\./.test(c.ip));

/* The verdict depends on WHERE the phone is, so say so rather than pretending one answer
 * fits both. The August logs show 155 downlink sends over WebRTC from the real Pixel
 * (opus PT 111) — ICE worked then, almost certainly off the LAN host candidate below with
 * the phone on the same home network. That says nothing about a phone that is remote. */
console.log('');
console.log('candidate coverage:');
console.log(`  LAN host  : ${hasLanHost ? 'yes' : 'NO'}   — works when the phone is on this same network`);
console.log(`  STUN srflx: ${hasSrflx ? 'yes' : 'NO'}   — works only if both NATs cooperate`);
console.log(`  tailnet   : ${hasTailnet ? 'yes' : 'NO'}   — the only path that works for a REMOTE phone`);
console.log(`  TURN relay: none configured  — no fallback when the above all fail`);

if (hasTailnet) {
  console.log('\nPASS: a tailnet candidate is advertised; a remote phone has a routable path.');
} else {
  console.log('\nCO-LOCATED phone (same Wi-Fi): OK' + (hasLanHost ? ' — the LAN host candidate covers it.' : ', but NO LAN host candidate is offered.'));
  console.log('REMOTE phone: AT RISK — no tailnet candidate and no TURN relay, so ICE can only');
  console.log('  succeed if the STUN srflx pair happens to be mutually reachable. If Tailscale');
  console.log('  itself reports "direct connection not established" for the phone, it has already');
  console.log('  failed to punch through the same NAT, and WebRTC has no DERP to fall back on.');
  console.log('  Symptom to expect: handshake fine, ICE never reaches connected, downlink');
  console.log('  silently falls back to the WebSocket (webrtc ready=false).');
  console.log('  Lever: AGENTMOB_ICE (add a TURN relay) or bind so the tailnet address is gathered.');
}

try { pc.close(); } catch {}
try { s.close?.(); } catch {}
/* Exit 0: an un-advertised tailnet candidate is a RISK for the remote case, not a failure of
 * the sidecar, and this tool reports reachability rather than gating a build on it. */
process.exit(0);
