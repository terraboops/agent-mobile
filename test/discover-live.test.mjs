/**
 * discover-live.test — "nothing open" must be a measurement, not an unfalsifiable claim.
 *
 * device-verify has printed "nothing open on <ip>" for hours. That line is only worth reading if
 * the same code path would have said something DIFFERENT had a listener been there — and nothing
 * proved that. The unit tests in adb-discover.test.mjs exercise discover()'s logic with a stubbed
 * scan callback; they say nothing about the real wiring device-verify uses: real scanPorts, real
 * concurrency, the AbortSignal bound to the run deadline, the cadence gate, the LAN-then-tailnet
 * host order. A negative produced by a path that has never produced a positive is not evidence.
 *
 * So: bind a listener on a port inside the sweep range, run the REAL discovery path against it,
 * and require it to be found. Then close the port and require the same call to find nothing. Both
 * directions, same code, one run.
 *
 * Loopback, because the claim under test is "the sweep detects a listener in its range", and that
 * is host-independent. Nothing here needs, or pretends to need, the handset.
 *
 * Run: npm run discover-live
 */
import { createServer } from 'node:net';
import { discover, scanPorts, DEFAULT_SCAN_RANGES } from './lib/adb-discover.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const HOST = '127.0.0.1';

/** Bind a listener on an OS-assigned port, then confirm it landed inside the swept range. */
function listen() {
  return new Promise((resolve, reject) => {
    const srv = createServer(() => {});
    srv.on('error', reject);
    /* Port 0 lets the OS pick. macOS hands out ephemeral ports from ~49152, which sits inside
     * DEFAULT_SCAN_RANGES' [50000,65535] band — but that is an assumption, so it is asserted
     * below rather than trusted. */
    srv.listen(0, HOST, () => resolve({ srv, port: srv.address().port }));
  });
}

const inRanges = (p) => DEFAULT_SCAN_RANGES.some(([lo, hi]) => p >= lo && p <= hi);

/* device-verify's REAL discovery wiring, lifted verbatim so this proves that path and not a
 * convenient simplification of it. mDNS returns nothing: loopback advertises no adb service, and
 * the sweep is the half under test.
 *
 * THE RANGE IS NARROWED, and the reason is itself a finding. Sweeping all of DEFAULT_SCAN_RANGES
 * against loopback returned 127.0.0.1:49152 — a port belonging to some other service on this Mac,
 * not to the stub. discover() answers with the FIRST open port it meets, so on a host with any
 * other listener the result was whatever happened to sort lowest, and both the positive and the
 * negative case "passed" by finding a stranger.
 *
 * So the detection claim is measured in a window around the stub, where a hit can only be the
 * stub. The claim that DEFAULT_SCAN_RANGES actually covers the stub's port is asserted separately
 * — the two together are what "the real sweep would have found a listener here" means, without
 * either of them quietly resting on an unrelated service. */
const realDiscover = (hosts, ranges) => discover({
  hosts,
  runMdns: async () => '',
  scan: (h, rs) => scanPorts(h, rs, { concurrency: 500, timeoutMs: 2000 }),
  ranges,
  log: (m) => console.log(`  [discover] ${m}`),
});

console.log('proving the sweep can say DETECTED, not only "nothing open"\n');

const { srv, port } = await listen();
ok('the stub bound a port inside DEFAULT_SCAN_RANGES', inRanges(port),
  `${port} is outside ${JSON.stringify(DEFAULT_SCAN_RANGES)} — a miss would then be correct `
  + 'behaviour rather than a failure, and this run would prove nothing');
console.log(`  stub listening on ${HOST}:${port}`);

/* ---- 1. the positive: the real path must FIND it ------------------------------------------- */
const WINDOW = [[Math.max(1, port - 3), Math.min(65535, port + 3)]];
const t0 = Date.now();
const found = await realDiscover([HOST], WINDOW);
const tookS = ((Date.now() - t0) / 1000).toFixed(0);
ok('the real discovery path DETECTED the listener', found.endpoint === `${HOST}:${port}`,
  `endpoint=${found.endpoint} expected=${HOST}:${port} (swept in ${tookS}s) — if this fails, `
  + 'every "nothing open" this harness has ever printed was unfalsifiable');
ok('it reports the scan as the route it used', found.via === 'scan', String(found.via));
ok('it recorded that a sweep actually happened', found.didScan === true, String(found.didScan));
ok('the open port is reported in the result',
  Array.isArray(found.open) && found.open.includes(port),
  JSON.stringify(found.open));

/* ---- 2. the negative: same path, port closed ----------------------------------------------- */
await new Promise((r) => srv.close(r));
const gone = await realDiscover([HOST], WINDOW);
ok('the same path reports NOTHING once the port is closed', gone.endpoint === null,
  `endpoint=${gone.endpoint} — a sweep that "finds" a closed port is worse than one that finds `
  + 'nothing');
ok('the negative still records that it really swept', gone.didScan === true,
  'a negative from a skipped sweep is the exact confusion this suite exists to prevent');

/* ---- 3. the skip is still distinguishable from a real negative ----------------------------- */
const skipped = await discover({
  hosts: [HOST], runMdns: async () => '',
  scan: async () => null, ranges: [[1, 1]], log: () => {},
});
ok('a skipped sweep is NOT reported as a negative measurement',
  skipped.didScan === false && skipped.scanned[HOST] === null,
  JSON.stringify({ didScan: skipped.didScan, scanned: skipped.scanned }));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
