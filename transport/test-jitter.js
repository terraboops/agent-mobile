// test-jitter.js — offline proof for the adaptive jitter buffer.
// Feeds a scripted stream (with real loss, a reorder, and jitter), pulls at the
// frame cadence, and asserts playout comes out ordered + contiguous, with a PLC
// (concealed) marker for every gap and never a dropped out-of-order frame.
import { AdaptiveJitterBuffer } from './adaptive-jitter.js';

const FRAME_MS = 20;
const N = 24;                 // seqs 0..23
const LOST = new Set([5, 9, 17]); // real loss: these never arrive
const REORDER_SEQ = 7;        // arrives late but must still land in order
const REORDER_DELAY = 3 * FRAME_MS;

// Build arrival schedule (per-packet wall-clock arrival, in arrival order).
const arrivals = [];
for (let seq = 0; seq < N; seq++) {
  if (LOST.has(seq)) continue;
  let atMs = seq * FRAME_MS;
  if (seq === REORDER_SEQ) atMs += REORDER_DELAY;       // delayed -> reorder risk
  if (seq === 12) atMs -= 10;                            // jitter: early arrival
  arrivals.push({ atMs, seq, tsMs: seq * FRAME_MS, frame: Buffer.from([seq, 1, 2, 3]) });
}
arrivals.sort((a, b) => a.atMs - b.atMs);

const jb = new AdaptiveJitterBuffer({ baselineFrames: 6, frameMs: FRAME_MS });
const out = [];
const maxAt = arrivals[arrivals.length - 1].atMs;
let ai = 0;

for (let t = 0; t <= maxAt + FRAME_MS * 4; t += FRAME_MS) {
  while (ai < arrivals.length && arrivals[ai].atMs <= t) {
    jb.push(arrivals[ai].seq, arrivals[ai].tsMs, arrivals[ai].frame);
    ai++;
  }
  const r = jb.pull(t);
  if (r) { out.push(r); if (r.seq >= N - 1) { ai = arrivals.length; break; } }
}
// Drain any remaining buffered frames.
for (let t = maxAt + FRAME_MS * 5; t < maxAt + FRAME_MS * 30; t += FRAME_MS) {
  const r = jb.pull(t);
  if (!r) { if (jb.stats().buffered === 0 && jb.stats().target <= jb.stats().baseline) break; continue; }
  out.push(r);
  if (r.seq >= N - 1) break;
}

// ---- assertions ------------------------------------------------------------
const emitted = out.map(r => ({ seq: r.seq, concealed: r.concealed }));
const realSeqs = emitted.filter(e => !e.concealed).map(e => e.seq);
const concealedSeqs = emitted.filter(e => e.concealed).map(e => e.seq);

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL:', m); };

// 1. Real frames strictly increasing (never out-of-order replay).
for (let i = 1; i < realSeqs.length; i++) {
  if (!(realSeqs[i] > realSeqs[i - 1])) fail(`out of order: ...${realSeqs.slice(Math.max(0,i-2), i+1)}`);
}
// 2. Every non-lost seq emitted exactly once, and none missing/extra.
const expectedReal = Array.from({ length: N }, (_, i) => i).filter(s => !LOST.has(s));
if (JSON.stringify(realSeqs) !== JSON.stringify(expectedReal))
  fail(`real frames mismatch:\n   got      ${JSON.stringify(realSeqs)}\n   expected ${JSON.stringify(expectedReal)}`);
// 3. Concealment exactly covers the lost seqs.
if (JSON.stringify([...concealedSeqs].sort((a,b)=>a-b)) !== JSON.stringify([...LOST].sort((a,b)=>a-b)))
  fail(`concealment mismatch: ${JSON.stringify(concealedSeqs)}`);
// 4. The reordered packet landed (not droppedLate), and nothing was dropped-late.
if (!realSeqs.includes(REORDER_SEQ)) fail(`reordered seq ${REORDER_SEQ} was lost`);
const st = jb.stats();
if (st.droppedLate > 0) fail(`dropped ${st.droppedLate} late packets`);
if (st.concealed !== LOST.size) fail(`concealed=${st.concealed} != lost=${LOST.size}`);

console.log(`played=          ${realSeqs.join(' ')}`);
console.log(`concealed=       ${concealedSeqs.join(' ') || '(none)'}`);
console.log(`stats=           ${JSON.stringify(st)}`);
console.log(ok ? '\nPASS: ordered, contiguous, PLC per gap, zero dropped' : '\nFAIL');
process.exit(ok ? 0 : 1);
