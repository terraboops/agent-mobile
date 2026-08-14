// test-udp-media.js — loopback proof of the UDP media transport.
// A fake "phone" transceiver AEAD-sends RTP-ish audio (with real loss + a
// reorder) over an actual UDP socket to the "gateway" transceiver; the gateway's
// adaptive jitter buffer must emit ordered, contiguous playout with a PLC
// marker for every gap and zero dropped late packets.
import { randomBytes } from 'node:crypto';
import { Channel } from '../proto.js';
import { UdpMedia } from './udp-media.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FRAME_MS = 20;
const N = 24;
const DROPPED = new Set([5, 9, 17]);
const REORDER_A = 8, REORDER_B = 7; // A arrives before B (a reorder)

// Mirrored AEAD channels: phone.tx == agent.rx, agent.tx == phone.rx.
const kA = randomBytes(32), kB = randomBytes(32);
const phone = new UdpMedia({ channel: new Channel(kA, kB), allow: () => false });
const agent = new UdpMedia({ channel: new Channel(kB, kA), allow: (r) => r.address === '127.0.0.1' });

const media = [];
agent.on('media', m => media.push(m));

await agent.start({ port: 0, host: '127.0.0.1' });

// Send order: all non-dropped seqs, with a deliberate reorder (8 before 7).
const sendOrder = [];
for (let s = 0; s < N; s++) if (!DROPPED.has(s)) sendOrder.push(s);
const ia = sendOrder.indexOf(REORDER_A), ib = sendOrder.indexOf(REORDER_B);
[sendOrder[ia], sendOrder[ib]] = [sendOrder[ib], sendOrder[ia]];

for (const s of sendOrder) {
  await phone.send({ kind: 0, seq: s, tsMs: s * FRAME_MS, opus: Buffer.from([s, 9, 9, 9]), addr: '127.0.0.1', port: agent.port });
  await sleep(5); // let datagrams arrive in near-order over loopback
}
await sleep(100); // let late arrivals + prefilled buffer settle

// Advance the playout clock so the jitter buffer conceals gaps and drains.
// Stop once the final expected seq (N-1) has been emitted — the buffer has no
// concept of stream end, so we don't pump past it.
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  agent.pump(t0 + i * FRAME_MS);
  if (media.some(m => m.seq >= N - 1)) break;
}

const real = media.filter(m => !m.concealed).map(m => m.seq);
const concealed = media.filter(m => m.concealed).map(m => m.seq);
const expected = Array.from({ length: N }, (_, i) => i).filter(s => !DROPPED.has(s));

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL:', m); };
for (let i = 1; i < real.length; i++) if (real[i] <= real[i - 1]) fail(`out of order: ${real.slice(i - 1, i + 1)}`);
if (JSON.stringify(real) !== JSON.stringify(expected)) fail(`playout mismatch got=${JSON.stringify(real)} exp=${JSON.stringify(expected)}`);
if (JSON.stringify(concealed.sort((a, b) => a - b)) !== JSON.stringify([...DROPPED].sort((a, b) => a - b))) fail(`concealed=${JSON.stringify(concealed)}`);
const st = agent.jb ? agent.jb.stats() : null;
if (st && st.droppedLate > 0) fail(`dropped ${st.droppedLate} late frames`);

console.log('played     =', real.join(' '));
console.log('concealed  =', concealed.join(' ') || '(none)');
console.log('jb stats   =', st && JSON.stringify(st));
console.log(ok ? '\nPASS: UDP AEAD transport + adaptive jitter buffer' : '\nFAIL');
phone.close(); agent.close();
process.exit(ok ? 0 : 1);
