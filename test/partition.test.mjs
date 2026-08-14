// partition.test.mjs — PROOF of partition resilience on the WebSocket channel.
//
//  1. connect + command round-trip over the AEAD WS channel
//  2. agent goes silent (network partition simulated on the gateway)
//  3. client's keepalive backoff detects it and starts buffering (unbounded)
//  4. 20 audio frames + a command are buffered — none dropped by policy
//  5. network returns → keepalive succeeds → buffer flushes IN ORDER
//  6. agent receives all 20 frames contiguous + the command reply resolves

import { startWsGateway } from '../transport/ws-gateway.js';
import { AgentStream } from '../transport/ws-client.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); }
  return fn();
};

const gw = await startWsGateway();
gw.setDead(false);

// Fast keepalive timings so the test is quick and deterministic.
const s = new AgentStream({ url: `ws://127.0.0.1:${gw.port}`, base: 200, probeTimeout: 150, P: 2, max: 1600 });
await s.connect();
s.startKeepalive();

console.log('=== command round-trip over AEAD WS ===');
const echo = await s.cmd('hi');
ok(echo && echo.echo === 'hi', 'command round-trips over the encrypted channel');

console.log('\n=== partition: agent goes silent, client buffers ===');
gw.setDead(true);
ok(await waitFor(() => s.partitioned, 6000), 'client declares the partition via failed keepalives');

for (let seq = 1; seq <= 20; seq++) s.sendAudio(seq, Date.now(), Buffer.alloc(48)); // 20ms-ish opus frames
const cmdPromise = s.cmd('during-partition', { timeoutMs: 15000 });
ok(s.stats.buffered === 21, `while partitioned, all 21 frames buffer (20 audio + 1 cmd), none dropped by policy`);

console.log('\n=== recovery: network returns, buffer flushes in order ===');
gw.setDead(false);
ok(await waitFor(() => !s.partitioned && s.stats.flushed === 21, 8000), 'partition clears and buffer flushes fully');

const cmdReply = await cmdPromise;
ok(cmdReply && cmdReply.echo === 'during-partition', 'buffered command reply resolves after recovery');

await sleep(150); // let the server process the flushed audio frames
const seqs = gw.state.audioSeqs;
ok(seqs.length === 20, `agent received all ${seqs.length}/20 buffered audio frames`);
ok(
  seqs.every((v, i) => v === i + 1),
  `in-order delivery: ${seqs[0]}..${seqs[seqs.length - 1]}`,
);

console.log('\n=== keepalive backoff doesn\'t hammer a dead link ===');
// Over the partition window, probes froze within [base, max]=[200,1600]ms.
ok(s.stats.probes < 12, `exponential backoff kept probes low (${s.stats.probes} probes) during a dead link`);

s.close();
await gw.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
