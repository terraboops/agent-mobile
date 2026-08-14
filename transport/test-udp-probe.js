// test-udp-probe.js — loopback proof of the UDP probe/ack handshake.
// The "phone" AEAD-sends a kind-2 probe; the "sidecar" must (a) accept the
// sender WITHOUT any source-address allowlist (AEAD is the authenticator),
// (b) learn the reply peer, and (c) reply with an authenticated kind-2 ack
// that echoes the probe seq so the phone can correlate. Mirrors what the
// Android phone does before it flips its uplink to UDP.
import { randomBytes } from 'node:crypto';
import { Channel } from '../proto.js';
import { UdpMedia } from './udp-media.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const kA = randomBytes(32), kB = randomBytes(32);

// phone tx=A, sidecar rx=A; sidecar tx=B, phone rx=B. Phone mirrors the Java
// app (sends probes, never acks). Sidecar is the gateway (acks kind-2 probes).
const phone = new UdpMedia({ channel: new Channel(kA, kB), allow: () => true, respondToProbes: false });
const sidecar = new UdpMedia({ channel: new Channel(kB, kA), allow: () => true }); // relaxed: AEAD gates

const phoneProbes = [], sidecarProbes = [];
let sidecarPeerSeen = false;
phone.on('probe', p => phoneProbes.push(p));
sidecar.on('probe', p => sidecarProbes.push(p));
sidecar.on('peer', () => { sidecarPeerSeen = true; });

await sidecar.start({ port: 0, host: '127.0.0.1' });
await phone.start({ port: 0, host: '127.0.0.1' }); // attach phone's receive listener

// Phone sends a probe every second until acked (we send one round here).
await phone.send({ kind: 2, seq: 42, tsMs: Date.now(), opus: Buffer.alloc(0), addr: '127.0.0.1', port: sidecar.port });
await sleep(150); // let the probe arrive and the ack come back

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL:', m); };

// Sidecar saw the probe, accepted it (relaxed allow), learned the peer.
if (!sidecarProbes.some(p => p.seq === 42 && p.from.address === '127.0.0.1'))
  fail(`sidecar did not see the kind-2 probe (saw=${JSON.stringify(sidecarProbes)})`);
if (!sidecarPeerSeen) fail('sidecar did not learn/announce the reply peer');
if (!sidecar.learnedPeer) fail('sidecar.learnedPeer is not set');

// The authenticated ack round-tripped back to the phone with the echoed seq.
if (!phoneProbes.some(p => p.seq === 42))
  fail(`phone did not receive the kind-2 ack echoing seq 42 (got=${JSON.stringify(phoneProbes)})`);

// A forged box (wrong key) must be REJECTED even with the allow = true gate.
const attacker = new UdpMedia({ channel: new Channel(randomBytes(32), randomBytes(32)), allow: () => true });
let authFailCount = 0;
sidecar.on('authfail', () => authFailCount++);
const before = authFailCount;
await attacker.send({ kind: 2, seq: 99, tsMs: Date.now(), opus: Buffer.alloc(0), addr: '127.0.0.1', port: sidecar.port });
await sleep(100);
if (authFailCount === before) fail('forged datagram (wrong key) was not rejected by AEAD');

console.log('sidecar probes   =', JSON.stringify(sidecarProbes));
console.log('phone acks seen  =', JSON.stringify(phoneProbes));
console.log('learnedPeer      =', sidecar.learnedPeer && `${sidecar.learnedPeer.address}:${sidecar.learnedPeer.port}`);
console.log('auth fails on forged box =', authFailCount - before);
console.log(ok ? '\nPASS: UDP probe/ack handshake + AEAD authenticator' : '\nFAIL');
phone.close(); sidecar.close(); attacker.close();
process.exit(ok ? 0 : 1);
