/**
 * device-handoff — arm, wait for the phone, then run the passes unattended.
 *
 * The toggle is the operator's and the passes are mine; this closes the gap between them so
 * flipping Wireless debugging needs no further round-trip. It polls cheaply, and when an adb
 * target appears it runs the full sweep AND the WS-fallback Stop pass, because the full sweep
 * negotiates WebRTC and cannot reach the case stop-control's flush was written for.
 *
 * It reports what it did in terms that cannot be mistaken for a device verification when no
 * device ever appeared — the arming loop finding nothing and a pass with no failures are
 * different sentences.
 *
 *   npm run device-handoff                 arm for 6h, both passes
 *   npm run device-handoff -- --hours 1    shorter
 *   npm run device-handoff -- --no-ws      full sweep only
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanPorts, DEFAULT_SCAN_RANGES, parseMdnsServices, pickAdbEndpoints,
         parseTailscalePeer } from './lib/adb-discover.mjs';
import { tickPlan, passPlan, usableEndpoint, handoffVerdict, TICK_S } from './lib/handoff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const HOURS = Number(flag('--hours', 6));
const WS = !argv.includes('--no-ws');
const APK = process.env.AGENTMOB_APK
  || 'android/app/build/outputs/apk/release/app-release.apk';
const PHONE_HOST = String(flag('--host', process.env.AGENTMOB_PHONE_HOST || '100.112.255.69'));
const ADB_PORT = Number(process.env.AGENTMOB_ADB_PORT || 5039);
const OUT = join(HERE, 'audit/out/device');
mkdirSync(OUT, { recursive: true });

const ADB = ['/opt/homebrew/bin/adb',
             '/opt/homebrew/share/android-commandlinetools/platform-tools/adb', 'adb']
  .find((p) => { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!ADB) { console.error('device-handoff: no adb on PATH or in the SDK'); process.exit(2); }

const adb = (args, timeout = 30000) => {
  const r = spawnSync(ADB, ['-P', String(ADB_PORT), ...args], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};
const stopAdb = () => { try { adb(['kill-server'], 10000); } catch { /* best effort */ } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.log(`\n${sig} — stopping adb before exit.`); stopAdb(); process.exit(130); });
}
process.on('exit', stopAdb);

const tsBin = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']
  .find((p) => { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const tsStatus = () => {
  if (!tsBin) return '';
  try { return execFileSync(tsBin, ['status'], { encoding: 'utf8', timeout: 15000 }); } catch { return ''; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;

console.log(`device-handoff — arming for ${HOURS}h, then ${WS ? 'two passes' : 'one pass'}`);
console.log(`  apk   ${APK}`);
console.log(`  phone ${PHONE_HOST}`);
console.log('  The phone needs Settings > System > Developer options > Wireless debugging ON.');
console.log('  Nothing here can flip it; this only removes the round trip afterwards.\n');

/* REMEMBER the LAN address, because tailscale forgets it.
 *
 * The status row carries `direct 192.168.10.53:38864` only while the peer is active; once the
 * phone's screen has been off a while the row goes to `-` and parseTailscalePeer returns
 * lan: null. The address is still reachable — measured, ECONNREFUSED on 5555, which only a
 * host that answered can produce — but the loop would fall back to the tailnet sweep, which
 * costs minutes for the same answer the LAN gives in seconds. Caught on the first tick of the
 * first armed run: it went straight to the slow sweep against a phone whose LAN path was fine.
 *
 * So the last LAN address seen is kept, and --lan seeds it for a cold start. */
let lastKnownLan = String(flag('--lan', process.env.AGENTMOB_PHONE_LAN || '')) || null;
let lastLan = -Infinity, lastTailnet = -Infinity, endpoint = null;
const deadline = t0 + HOURS * 3600 * 1000;

while (Date.now() < deadline && !endpoint) {
  const peer = parseTailscalePeer(tsStatus(), PHONE_HOST);
  if (peer.lan) lastKnownLan = peer.lan;
  const lanAddr = peer.lan || lastKnownLan;
  const plan = tickPlan({ elapsedS: elapsed(), lastLanSweepS: lastLan,
                          lastTailnetSweepS: lastTailnet, hasLan: !!lanAddr });

  if (plan.mdns) {
    const picks = pickAdbEndpoints(parseMdnsServices(adb(['mdns', 'services']).stdout),
                                   { host: lanAddr || PHONE_HOST });
    if (picks.length) endpoint = `${picks[0].host}:${picks[0].port}`;
  }
  if (!endpoint && plan.lanSweep) {
    lastLan = elapsed();
    console.log(`  [${Math.round(elapsed())}s] sweeping ${lanAddr}`
      + `${peer.lan ? '' : ' (last known — tailscale drops the direct endpoint when the phone idles)'}`
      + ` (${plan.why})`);
    const open = await scanPorts(lanAddr, DEFAULT_SCAN_RANGES, { concurrency: 800, timeoutMs: 1500 });
    if (open.length) endpoint = `${lanAddr}:${open[0]}`;
    else console.log(`  [${Math.round(elapsed())}s] nothing open on ${lanAddr}`);
  }
  if (!endpoint && plan.tailnetSweep) {
    lastTailnet = elapsed();
    console.log(`  [${Math.round(elapsed())}s] sweeping ${PHONE_HOST} (${plan.why})`);
    const open = await scanPorts(PHONE_HOST, DEFAULT_SCAN_RANGES, { concurrency: 400, timeoutMs: 2000 });
    if (open.length) endpoint = `${PHONE_HOST}:${open[0]}`;
    else console.log(`  [${Math.round(elapsed())}s] nothing open on ${PHONE_HOST}`);
  }
  if (!endpoint) await sleep(TICK_S * 1000);
}

let ran = 0;
const results = [];
if (endpoint && usableEndpoint(endpoint)) {
  console.log(`\n  ENDPOINT FOUND: ${endpoint} after ${Math.round(elapsed())}s — running the passes.\n`);
  adb(['connect', endpoint], 30000);
  for (const p of passPlan({ apk: APK, wsFallback: WS })) {
    console.log(`\n=== ${p.name} — ${p.why}\n`);
    const r = spawnSync(process.execPath, [join(HERE, 'device-verify.mjs'), ...p.args],
      { stdio: 'inherit', env: { ...process.env, ...p.env }, timeout: 45 * 60 * 1000 });
    ran++;
    results.push({ pass: p.name, exit: r.status });
  }
}

const verdict = handoffVerdict({ found: !!endpoint, ranPasses: ran, elapsedS: elapsed() });
console.log(`\n  ${verdict.note}`);
writeFileSync(join(OUT, 'device-handoff.json'), JSON.stringify({
  generated: new Date().toISOString(), armedHours: HOURS, endpoint, ranPasses: ran,
  results, verdict: verdict.note,
}, null, 2));
console.log(`  handoff log -> ${join(OUT, 'device-handoff.json')}`);
process.exit(endpoint ? (results.every((r) => r.exit === 0) ? 0 : 1) : 3);
