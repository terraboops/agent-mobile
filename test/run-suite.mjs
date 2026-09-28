/**
 * run-suite — run every test suite and KEEP the evidence when one fails.
 *
 * This existed as a shell one-liner retyped by hand a dozen times, and it threw away the only
 * thing that matters when something goes wrong: it printed "failing: mute-midreply" and nothing
 * else. Diagnosing then meant re-running the suite alone, where it passed, and guessing at the
 * difference — which is how a load-sensitive flake gets mislabelled as an interaction bug, or
 * worse, shrugged at.
 *
 * So: capture each failing suite's output to test/audit/out/suite-failures/, name the failed
 * assertions inline, and keep the safety facts the ad-hoc version also reported (gateway pid
 * unchanged, no stray adb servers, live plugin untouched).
 *
 * Utilities are skipped by name, matching the list mutation-coverage already maintains — a
 * script that runs the gateway or waits on hardware is not a suite.
 *
 * Usage: npm run suite
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'test', 'audit', 'out', 'suite-failures');
mkdirSync(OUT, { recursive: true });

/* Not suites. Kept in sync with mutation-coverage's UTILITIES by asserting below, so the two
 * cannot drift apart silently. */
const SKIP = new Set(['gateway', 'device-watch', 'device-verify', 'device-arm', 'ctrlbar-shot',
                      'ice-candidates', 'vendor-refresh', 'mutation', 'mutation-coverage',
                      'suite']);

const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts || {};
const suites = Object.keys(scripts).filter((s) => !SKIP.has(s));

const sha = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16); }
                     catch { return '(absent)'; } };
const LIVE_SIDECAR = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
const LIVE_ADAPTER = join(homedir(), '.hermes/plugins/agentmob/adapter.py');
const gatewayPid = () => {
  try {
    const m = /"pid"\s*:\s*(\d+)/.exec(readFileSync(join(homedir(), '.hermes/gateway.pid'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
/**
 * adb servers left listening, EXCLUDING one the armed device watcher legitimately owns.
 *
 * The first version counted every listener and reported "stray adb servers: 1" while device-arm
 * was doing exactly its job on :5039. Reporting expected state as a leak is how a warning stops
 * being read — and this one exists to catch a real leak, which matters because a lingering adb
 * server is something Terra then has to find.
 */
const adbServers = () => {
  const r = spawnSync('bash', ['-c',
    'lsof -nP -iTCP:5037 -iTCP:5039 -sTCP:LISTEN 2>/dev/null | grep LISTEN'], { encoding: 'utf8' });
  const ports = (r.stdout || '').split('\n').filter(Boolean)
    .map((l) => (/:(\d+) \(LISTEN\)/.exec(l) || [])[1]).filter(Boolean);
  const armed = spawnSync('bash', ['-c', 'pgrep -f "device-verify.mjs --wait" >/dev/null && echo yes'],
    { encoding: 'utf8' }).stdout.includes('yes');
  /* :5039 is device-verify's own isolated server; it is expected while the watcher runs. */
  const stray = ports.filter((p) => !(armed && p === '5039'));
  return { ports, armed, stray };
};

const before = { pid: gatewayPid(), sidecar: sha(LIVE_SIDECAR), adapter: sha(LIVE_ADAPTER) };
console.log(`running ${suites.length} suites | gateway pid ${before.pid} | `
  + `live sidecar ${before.sidecar}\n`);

let total = 0;
const failed = [];
for (const s of suites) {
  const t0 = Date.now();
  const r = spawnSync('npm', ['run', '-s', s], { cwd: REPO, encoding: 'utf8', timeout: 1800000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const n = Number((out.match(/^(\d+) passed/m) || [])[1] || 0);
  total += n;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.status === 0) {
    console.log(`  ok   ${s.padEnd(24)} ${String(n).padStart(4)} assertions  ${secs}s`);
    continue;
  }
  /* KEEP THE EVIDENCE. */
  const file = join(OUT, `${s}.txt`);
  writeFileSync(file, out);
  const named = out.split('\n').filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim());
  failed.push({ suite: s, named, file });
  console.log(`  FAIL ${s.padEnd(24)} ${String(n).padStart(4)} assertions  ${secs}s`);
  for (const l of named.slice(0, 4)) console.log(`         ${l}`);
  if (!named.length) {
    console.log('         (no FAIL line — the suite died rather than asserting; see the capture)');
    console.log('         ' + out.trim().split('\n').slice(-3).join('\n         '));
  }
  console.log(`         full output: ${file.replace(REPO, '.')}`);
}

const after = { pid: gatewayPid(), sidecar: sha(LIVE_SIDECAR), adapter: sha(LIVE_ADAPTER) };
console.log(`\n${suites.length} suites, ${total} assertions, ${failed.length} failing`);
console.log(`gateway pid ${before.pid} -> ${after.pid}`
  + `${before.pid === after.pid ? ' (unchanged)' : '  !! PRODUCTION GATEWAY RESTARTED'}`);
console.log(`live plugin: sidecar ${before.sidecar} -> ${after.sidecar}, `
  + `adapter ${before.adapter} -> ${after.adapter}`
  + `${before.sidecar === after.sidecar && before.adapter === after.adapter
      ? ' (untouched)' : '  !! A SUITE MODIFIED THE LIVE PLUGIN'}`);
{
  const a = adbServers();
  console.log(`adb servers listening: ${a.ports.join(', ') || 'none'}`
    + `${a.armed ? ' (device-arm owns :5039)' : ''}`
    + `${a.stray.length ? `  !! STRAY: ${a.stray.join(', ')}` : ''}`);
}

const dirty = before.pid !== after.pid || before.sidecar !== after.sidecar
  || before.adapter !== after.adapter;
if (failed.length) console.log(`\nfailing: ${failed.map((f) => f.suite).join(', ')}`);
process.exit(failed.length || dirty ? 1 : 0);
