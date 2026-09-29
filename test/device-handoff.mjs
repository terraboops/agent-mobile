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
import { homedir, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanPorts, DEFAULT_SCAN_RANGES, parseMdnsServices, pickAdbEndpoints,
         parseTailscalePeer } from './lib/adb-discover.mjs';
import { discoveryPlan, passPlan, usableEndpoint, handoffVerdict, subnetHosts,
         aliveFromProbe, foundVia, excludedHosts, endpointState, identityMatches,
         hostSweepOrder, ownLanAddress, HOSTS_PER_TICK, TICK_S } from './lib/handoff.mjs';
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
/* Test seams. --tiers keeps a simulated run off the real network (the subnet tier sweeps the
 * actual LAN); --pass-only scopes each pass to a phase so a run against a stand-in adb does
 * not sit in 60-second waits for a sidecar handshake that cannot happen; the tick override lets
 * a scripted "Allow" tap arrive in seconds rather than minutes. */
const TIERS_ALLOWED = flag('--tiers', null) ? new Set(String(flag('--tiers')).split(',')) : null;
const PASS_ONLY = flag('--pass-only', null);
const TICK = Number(process.env.AGENTMOB_HANDOFF_TICK_S || TICK_S);
mkdirSync(OUT, { recursive: true });

/* AGENTMOB_ADB first, so a scripted stand-in can drive the paths no device has exercised —
 * the USB serial and the unauthorized prompt had never run anywhere before it existed. */
const ADB = [process.env.AGENTMOB_ADB, '/opt/homebrew/bin/adb',
             '/opt/homebrew/share/android-commandlinetools/platform-tools/adb', 'adb']
  .filter(Boolean).find((p) => { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
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
let lastKnownLan = String(flag('--phone-lan', process.env.AGENTMOB_PHONE_LAN || '')) || null;
const SELF_LAN = String(flag('--lan', '')) || ownLanAddress(networkInterfaces());
if (!SELF_LAN) { console.error('device-handoff: cannot determine this machine\'s LAN address'); process.exit(2); }
console.log(`  self  ${SELF_LAN} (excluded from every sweep)`);
let found = null;                       // {tier, endpoint, note}
let confirmed = null;                   // the endpoint that proved to be the right phone
const rejected = new Set();             // candidates already shown not to be it
const swept = new Set();                // hosts whose full range has been checked once
/* A phone showing "Allow wireless debugging?" is not a rejection, it is a wait. It was handled
 * as one: disconnected — tearing down the very connection whose prompt the user has to tap —
 * and added to `rejected`, so nothing re-offered it. Reproduced against the scripted adb: an
 * endpoint advertised once, Allow tapped three calls later, and the handoff never looked again
 * and ended by saying Wireless debugging was OFF. */
let awaiting = null;                    // {tier, endpoint, note} held while the prompt is up
let awaitingSince = 0;
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

while (Date.now() < deadline && !confirmed) {
  /* Re-check a phone that is waiting on its prompt BEFORE rediscovering anything: rediscovery
   * may never offer it again (a sweep find is one event), and the connection is still up. */
  if (awaiting && !found) found = awaiting;

  const peer = parseTailscalePeer(tsStatus(), PHONE_HOST);
  if (peer.lan) lastKnownLan = peer.lan;
  /* TWO DIFFERENT ADDRESSES, which one variable used to hold. `lastKnownLan` is the PHONE's,
   * learned from tailscale; SELF is this machine's, from the OS. Conflating them made the
   * exclusion remove the phone from discovery and sweep this Mac instead — watched live. */
  const selfLan = SELF_LAN;
  const plan = discoveryPlan({ elapsedS: elapsed(), last, liveHosts: liveHosts.map((h) => h.host),
                               hasTailnet: true });
  if (TIERS_ALLOWED) plan.tiers = plan.tiers.filter((t) => TIERS_ALLOWED.has(t));

  /* --- usb: the only path that works with the toggle off ----------------------------------- */
  if (!found && plan.tiers.includes('usb')) {
    last.usb = elapsed();
    const out = adb(['devices', '-l']).stdout || '';
    const usb = out.split('\n').slice(1)
      .map((l) => l.trim()).filter((l) => l && !/^\S+:\d+\s/.test(l))
      .find((l) => /\sdevice\b/.test(l));
    if (usb && !rejected.has(usb.split(/\s+/)[0])) found = foundVia('usb', usb.split(/\s+/)[0], usb.slice(0, 80));
  }

  /* --- mdns: the designed mechanism, and this Mac IS on the phone's segment ------------------ */
  if (!found && plan.tiers.includes('mdns')) {
    last.mdns = elapsed();
    /* A device already refused is not offered again, by ANY tier. The rejected set was consulted
     * only by the sweep, so a Samsung advertising on the same segment was reconnected, queried
     * and refused on every tick — eight connects in eleven seconds against a simulated one,
     * about a thousand over a six-hour arm — and each `adb connect` to someone else's phone can
     * put an "Allow wireless debugging?" prompt on THEIR screen. */
    const picks = pickAdbEndpoints(parseMdnsServices(adb(['mdns', 'services']).stdout),
                                   { host: lastKnownLan || PHONE_HOST })
      .filter((p) => !rejected.has(`${p.host}:${p.port}`));
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
    /* A FEW PER TICK, likeliest first. One host is ~50s, so all eleven in one pass is nine
     * minutes during which USB and mDNS — either of which could answer instantly — do not run.
     * And each one is logged: a silent nine minutes in a six-hour waiter looks like a hang. */
    const order = hostSweepOrder(liveHosts, { preferred: peer.lan || lastKnownLan, swept });
    for (const host of order.slice(0, HOSTS_PER_TICK)) {
      const t = Date.now();
      const open = await scanPorts(host, DEFAULT_SCAN_RANGES,
                                   { concurrency: 800, timeoutMs: 1200 });
      swept.add(host);
      console.log(`  [${Math.round(elapsed())}s] swept ${host} full range in `
        + `${((Date.now() - t) / 1000).toFixed(0)}s — ${open.length} port(s) open`);
      const fresh = open.map((p) => `${host}:${p}`).find((e) => !rejected.has(e));
      if (fresh) { found = foundVia('hosts', fresh, `${open.length} port(s) open`); break; }
    }
  }

  /* --- tailnet: the phone is not on this network. Slow, and the only path that says so ------- */
  if (!found && plan.tiers.includes('tailnet')) {
    last.tailnet = elapsed();
    console.log(`  [${Math.round(elapsed())}s] sweeping ${PHONE_HOST} (${plan.why})`);
    const open = await scanPorts(PHONE_HOST, DEFAULT_SCAN_RANGES, { concurrency: 400, timeoutMs: 2000 });
    if (open.length) found = foundVia('tailnet', `${PHONE_HOST}:${open[0]}`, 'over the tailnet');
    else console.log(`  [${Math.round(elapsed())}s] nothing open on ${PHONE_HOST}`);
  }

  /* CONFIRM IT HERE, and keep looking if it is not the phone.
   *
   * This lived after the loop, so the first candidate ended the run whatever it turned out to
   * be: an arming run died after 39 seconds because a Plex server on .54:32400 answered a
   * sweep. "Continuing to look" was printed by a branch that could not continue. */
  if (found) {
    const cand = found.endpoint;
    const recheck = awaiting && found === awaiting;
    /* A re-check of a phone waiting on its prompt is not a new discovery, and printing it as
     * one — "CANDIDATE ... via mDNS" every tick, when mDNS advertised it exactly once — made the
     * log claim observations that were not made. Quiet, and at most every 30s. */
    if (!recheck) {
      console.log(`  CANDIDATE ${cand} after ${Math.round(elapsed())}s — ${found.note}`);
      if (found.detail) console.log(`    ${found.detail}`);
    } else if (Math.floor(elapsed() / 30) !== Math.floor((elapsed() - TICK) / 30)) {
      console.log(`  [${Math.round(elapsed())}s] still waiting on "Allow" at ${cand}`);
    }
    /* Shape first. adb connect on a malformed target fails in a way that reads like the phone
     * refusing, and the rewrite above dropped this check until the suite noticed. */
    let why = null;
    let st = { present: false, ready: false, state: null };
    if (found.tier !== 'usb' && !usableEndpoint(cand)) {
      why = `"${cand}" is not a host:port adb could connect to`;
    } else {
      if (found.tier !== 'usb') adb(['connect', cand], 30000);
      st = endpointState(adb(['devices', '-l']).stdout, cand);
    }
    if (why) { /* already decided */ }
    else if (!st.present) {
      why = 'adb does not list it as a device — an open port is not an adb endpoint';
    } else if (st.state === 'unauthorized') {
      if (!awaiting) {
        awaitingSince = elapsed();
        console.log(`  WAITING: ${cand} is a real phone showing "Allow wireless debugging?". Tap `
          + 'Allow (and "Always allow from this computer") on the handset — nothing here can '
          + 'answer it. The connection is being held open; no further step is needed after.');
      }
      awaiting = found;
      found = null;
      if (!confirmed) { await sleep(TICK * 1000); continue; }
    } else if (!st.ready) {
      /* `offline` after connecting to a random service is adb describing a socket it could not
       * speak to — not a phone with a prompt, which is what the first version implied. */
      why = `adb reports it ${st.state} — it answered TCP but does not speak adb`;
    } else {
      const model = adb(['-s', cand, 'shell', 'getprop', 'ro.product.model']).stdout.trim();
      const serialProp = adb(['-s', cand, 'shell', 'getprop', 'ro.serialno']).stdout.trim();
      const id = identityMatches({ model, serial: serialProp,
                                   expectModel: String(flag('--model', 'Pixel')),
                                   expectSerial: flag('--serial', null) });
      if (id.ok) { confirmed = cand; console.log(`  CONFIRMED: ${id.why}\n`); }
      else why = id.why;
    }
    if (confirmed) {
      if (awaiting) console.log(`  (Allow was tapped after ${Math.round(elapsed() - awaitingSince)}s)`);
      awaiting = null;
    }
    if (!confirmed) {
      console.log(`  REJECTED: ${why}`);
      if (found.tier !== 'usb') adb(['disconnect', cand], 15000);
      rejected.add(cand);
      found = null;                    // keep arming; a Plex server is not the end of the run
    }
  }

  if (!confirmed) await sleep(TICK * 1000);
}
const endpoint = confirmed;

let ran = 0;
const results = [];
if (confirmed) {
  const passes = passPlan({ apk: APK, wsFallback: WS }).map((p) => {
    if (!PASS_ONLY) return p;
    const a = [...p.args]; const i = a.indexOf('--only');
    if (i >= 0) a.splice(i, 2);
    return { ...p, args: [...a, '--only', String(PASS_ONLY)] };
  });
  for (const p of passes) {
    /* Say what is RUNNING. With --pass-only the header still read "full sweep — install, launch,
     * handshake, WebRTC, surface, speak, mute, stop" over a pass that did two of those. */
    console.log(`\n=== ${p.name}${PASS_ONLY ? ` (narrowed to --only ${PASS_ONLY})` : ''} — `
      + `${PASS_ONLY ? `only the ${PASS_ONLY} phase(s) of: ` : ''}${p.why}\n`);
    const r = spawnSync(process.execPath, [join(HERE, 'device-verify.mjs'), ...p.args],
      { stdio: 'inherit', env: { ...process.env, ...p.env }, timeout: 45 * 60 * 1000 });
    ran++;
    results.push({ pass: p.name, exit: r.status });
  }
}

const verdict = handoffVerdict({ found: !!confirmed, ranPasses: ran, elapsedS: elapsed(),
                                awaiting: awaiting ? awaiting.endpoint : null });
console.log(`\n  ${verdict.note}`);
/* Same quarantine as device-verify: a handoff against a scripted adb is not a record of the phone. */
const HANDOFF_LOG = join(OUT, process.env.AGENTMOB_ADB ? 'device-handoff.sim.json' : 'device-handoff.json');
writeFileSync(HANDOFF_LOG, JSON.stringify({
  simulated: !!process.env.AGENTMOB_ADB, awaitingAllow: awaiting ? awaiting.endpoint : null,
  generated: new Date().toISOString(), armedHours: HOURS, endpoint,
  foundVia: found ? { tier: found.tier, note: found.note } : null,
  liveHostsSeen: liveHosts.map((h) => h.host), ranPasses: ran, results, verdict: verdict.note,
}, null, 2));
console.log(`  handoff log -> ${HANDOFF_LOG}`);
process.exit(confirmed ? (results.every((r) => r.exit === 0) ? 0 : 1) : 3);
