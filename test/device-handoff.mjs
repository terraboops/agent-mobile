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
import { discoveryPlan, passPlan, usableEndpoint, handoffVerdict, subnetHosts,
         aliveFromProbe, foundVia, excludedHosts, endpointState, identityMatches,
         TICK_S } from './lib/handoff.mjs';
import { createConnection } from 'node:net';

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
let found = null;                       // {tier, endpoint, note}
const last = {};                        // tier -> elapsed seconds when it last ran
let liveHosts = [];
const deadline = t0 + HOURS * 3600 * 1000;

/** One TCP probe. `alive` means the host answered — refused counts, timeout does not. */
const probeHost = (host, port, timeoutMs) => new Promise((resolve) => {
  const sock = createConnection({ host, port });
  let done = false;
  const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
  sock.setTimeout(timeoutMs);
  sock.on('connect', () => finish('open'));
  sock.on('timeout', () => finish(null));
  sock.on('error', (e) => finish(e.code || 'error'));
});

/** Which of the /24 answer at all. Cheap, and it makes the expensive tier affordable. */
async function sweepSubnet(hosts, concurrency = 120) {
  const alive = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (i < hosts.length) {
      const h = hosts[i++];
      const r = await probeHost(h, 5555, 1200);
      if (r === 'open') { alive.push({ host: h, adb: true }); }
      else if (aliveFromProbe(r)) alive.push({ host: h, adb: false });
    }
  }));
  return alive;
}

while (Date.now() < deadline && !found) {
  const peer = parseTailscalePeer(tsStatus(), PHONE_HOST);
  if (peer.lan) lastKnownLan = peer.lan;
  const selfLan = lastKnownLan || '192.168.10.55';
  const plan = discoveryPlan({ elapsedS: elapsed(), last, liveHosts: liveHosts.map((h) => h.host),
                               hasTailnet: true });

  /* --- usb: the only path that works with the toggle off ----------------------------------- */
  if (plan.tiers.includes('usb')) {
    last.usb = elapsed();
    const out = adb(['devices', '-l']).stdout || '';
    const usb = out.split('\n').slice(1)
      .map((l) => l.trim()).filter((l) => l && !/^\S+:\d+\s/.test(l))
      .find((l) => /\sdevice\b/.test(l));
    if (usb) found = foundVia('usb', usb.split(/\s+/)[0], usb.slice(0, 80));
  }

  /* --- mdns: the designed mechanism, and this Mac IS on the phone's segment ------------------ */
  if (!found && plan.tiers.includes('mdns')) {
    last.mdns = elapsed();
    const picks = pickAdbEndpoints(parseMdnsServices(adb(['mdns', 'services']).stdout),
                                   { host: lastKnownLan || PHONE_HOST });
    if (picks.length) found = foundVia('mdns', `${picks[0].host}:${picks[0].port}`, picks[0].type);
  }

  /* --- subnet: 254 hosts, one port. Seconds, and it yields the live-host list ---------------- */
  if (!found && plan.tiers.includes('subnet')) {
    last.subnet = elapsed();
    /* NEVER this machine. The first tiered run swept its own address, found rapportd on
     * 49152, and started installing an APK against localhost. */
    const skip = excludedHosts({ selfLan });
    const hosts = (subnetHosts(selfLan) || []).filter((h) => !skip.has(h));
    if (hosts.length) {
      const t = Date.now();
      liveHosts = await sweepSubnet(hosts);
      console.log(`  [${Math.round(elapsed())}s] swept ${hosts.length} addresses on `
        + `${selfLan.replace(/\.\d+$/, '.0')}/24 in ${((Date.now() - t) / 1000).toFixed(1)}s — `
        + `${liveHosts.length} alive (${plan.why})`);
      const open = liveHosts.find((h) => h.adb);
      if (open) found = foundVia('subnet', `${open.host}:5555`, 'port 5555 was open');
    }
  }

  /* --- hosts: the full wireless-debug range, aimed only at hosts that answered --------------- */
  if (!found && plan.tiers.includes('hosts')) {
    last.hosts = elapsed();
    for (const h of liveHosts) {
      const open = await scanPorts(h.host, DEFAULT_SCAN_RANGES,
                                   { concurrency: 800, timeoutMs: 1200 });
      if (open.length) { found = foundVia('hosts', `${h.host}:${open[0]}`, `${open.length} port(s) open`); break; }
    }
    if (!found) console.log(`  [${Math.round(elapsed())}s] no wireless-debug port on any of `
      + `${liveHosts.length} live host(s) (${plan.why})`);
  }

  /* --- tailnet: the phone is not on this network. Slow, and the only path that says so ------- */
  if (!found && plan.tiers.includes('tailnet')) {
    last.tailnet = elapsed();
    console.log(`  [${Math.round(elapsed())}s] sweeping ${PHONE_HOST} (${plan.why})`);
    const open = await scanPorts(PHONE_HOST, DEFAULT_SCAN_RANGES, { concurrency: 400, timeoutMs: 2000 });
    if (open.length) found = foundVia('tailnet', `${PHONE_HOST}:${open[0]}`, 'over the tailnet');
    else console.log(`  [${Math.round(elapsed())}s] nothing open on ${PHONE_HOST}`);
  }

  if (!found) await sleep(TICK_S * 1000);
}
const endpoint = found ? found.endpoint : null;

let ran = 0;
const results = [];
let confirmed = null;
if (found && (found.tier === 'usb' || usableEndpoint(endpoint))) {
  console.log(`\n  CANDIDATE ${endpoint} after ${Math.round(elapsed())}s — ${found.note}`);
  if (found.detail) console.log(`  ${found.detail}`);

  /* A SWEEP HIT IS A CANDIDATE, NOT A PHONE. An open port proves a socket answered; adb has to
   * say it is a device, and the device has to say it is the right one. Skipping either is how a
   * run installs this app on a stranger's handset and runs a mute test on it. */
  if (found.tier !== 'usb') adb(['connect', endpoint], 30000);
  const st = endpointState(adb(['devices', '-l']).stdout, endpoint);
  if (!st.present) {
    console.log(`  REJECTED: adb does not list ${endpoint} as a device — an open port is not `
      + 'an adb endpoint. Continuing to look.');
  } else if (!st.ready) {
    console.log(`  ${endpoint} is present but ${st.state}. If it says unauthorized, accept the `
      + '"Allow wireless debugging?" prompt on the phone; nothing here can answer it.');
  } else {
    const model = adb(['-s', endpoint, 'shell', 'getprop', 'ro.product.model']).stdout.trim();
    const serialProp = adb(['-s', endpoint, 'shell', 'getprop', 'ro.serialno']).stdout.trim();
    const id = identityMatches({ model, serial: serialProp,
                                 expectModel: String(flag('--model', 'Pixel')),
                                 expectSerial: flag('--serial', null) });
    if (!id.ok) {
      console.log(`  REFUSED: ${id.why}`);
      adb(['disconnect', endpoint], 15000);
    } else {
      console.log(`  CONFIRMED: ${id.why}`);
      confirmed = endpoint;
    }
  }
  console.log('');
}

if (confirmed) {
  for (const p of passPlan({ apk: APK, wsFallback: WS })) {
    console.log(`\n=== ${p.name} — ${p.why}\n`);
    const r = spawnSync(process.execPath, [join(HERE, 'device-verify.mjs'), ...p.args],
      { stdio: 'inherit', env: { ...process.env, ...p.env }, timeout: 45 * 60 * 1000 });
    ran++;
    results.push({ pass: p.name, exit: r.status });
  }
}

const verdict = handoffVerdict({ found: !!confirmed, ranPasses: ran, elapsedS: elapsed() });
console.log(`\n  ${verdict.note}`);
writeFileSync(join(OUT, 'device-handoff.json'), JSON.stringify({
  generated: new Date().toISOString(), armedHours: HOURS, endpoint,
  foundVia: found ? { tier: found.tier, note: found.note } : null,
  liveHostsSeen: liveHosts.map((h) => h.host), ranPasses: ran, results, verdict: verdict.note,
}, null, 2));
console.log(`  handoff log -> ${join(OUT, 'device-handoff.json')}`);
process.exit(confirmed ? (results.every((r) => r.exit === 0) ? 0 : 1) : 3);
