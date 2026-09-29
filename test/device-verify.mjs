/**
 * device-verify — the on-device pass, armed to run unattended.
 *
 * Everything here needs the actual Pixel, so it is written to WAIT for one rather than to be
 * run at a moment someone is watching: point it at a wireless-debugging endpoint (or leave a
 * USB cable in), walk away, and it installs, launches, exercises and screenshots the things
 * that only hardware can answer.
 *
 * Stages (each reports built / verified / blocked, and a blocked stage never fails a later one):
 *   1  adb reachable, device authorised
 *   2  install the APK  (-r keeps app data, so the IdentityStore keypair is preserved)
 *   3  launch, confirm the process is alive
 *   4  wait for the AEAD handshake in the gateway log; record identity + opus PT
 *   5  screenshots: boot, connected control bar, widget tiles
 *   6  speaking pill during TTS
 *   7  mute MID-SENTENCE (issue #1) — tap the native mic while the reply is playing
 *
 * Stage 7 is verified through the sidecar's own truncation log. A reply cut short records
 *   → phone pcm ...b -> N opus packets via WebRTC [cut short after i/N frames: ...]
 * so a successful mute leaves proof that the audio actually stopped, rather than a screenshot
 * of a button that merely looks pressed.
 *
 * The mic's tap point is computed from MIC_SIZE_DP / MIC_BOTTOM_GAP_DP in MainActivity.java —
 * the same constants the layout and the geometry test read, so it cannot drift from the button.
 *
 * ALWAYS runs `adb kill-server` on the way out: a lingering adb server leaves Terra with
 * repeated "Allow debugging?" prompts on the phone.
 *
 * Usage:
 *   npm run device-verify                          # discovers the endpoint itself
 *   npm run device-verify -- --connect 100.x.x.x:40123
 *   npm run device-verify -- --wait 7200           # arm for two hours
 *   npm run device-verify -- --dry                 # exercise the logic with no device
 *                                                  # (--dry, not --dry-run: npm eats that)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDevices, stateLabel, describeBlocked, connectErrorOf } from './lib/adb-state.mjs';
import { discover, scanPorts, DEFAULT_SCAN_RANGES, parseTailscalePeer } from './lib/adb-discover.mjs';
import { typedTurn } from './lib/aead-trigger.mjs';
import { localApkPreflight, APK } from './lib/apk-facts.mjs';
import { classifyIcePath } from './lib/ice-path.mjs';
import { logStamp, logSince as logSinceReal } from './lib/gateway-log.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/audit/out/device');
const JAVA = join(ROOT, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');

const PKG = 'com.agentmobile.agent';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
/* --dry, NOT --dry-run: `npm run x -- --dry-run` never reaches us because npm treats
 * --dry-run as its OWN flag and swallows it — the script then ran for real and sat in
 * the 1800s device wait. --dry-run still works when node is invoked directly. */
const DRY = argv.includes('--dry') || argv.includes('--dry-run');
const CONNECT = flag('--connect', process.env.AGENTMOB_ADB_TARGET);
/* The phone's tailnet address. Only the HOST is needed — the port is discovered. */
const PHONE_HOST = String(flag('--host', process.env.AGENTMOB_PHONE_HOST
  || '100.112.255.69'));
const DISCOVER_EVERY_MS = Number(flag('--discover-every', 120000));
/* The port sweep runs on its OWN, much slower cadence.
 *
 * Discovery does two things with very different costs. mDNS is link-local multicast: free, and
 * the path that actually matters here, because the phone shares this LAN and Android advertises
 * _adb-tls-connect._tcp within seconds of the Wireless debugging toggle. The sweep is ~35,000 TCP
 * attempts pushed through the Tailscale tunnel, and it takes LONGER than the 120s discovery
 * interval — so on a long arm the two overlap and it sweeps continuously. A two-hour arm at that
 * rate is on the order of a million connection attempts aimed at someone's phone, and it is
 * self-harming besides: that traffic is exactly what made the reachability probe report a
 * reachable handset as "powered off, asleep, or off the tailnet".
 *
 * So: poll mDNS often, sweep rarely. The sweep stays, because it is the only option when the
 * phone is NOT on this LAN. */
const SCAN_EVERY_MS = Number(flag('--scan-every', 600000));
let lastScan = 0;
/* This run gets its OWN adb server, and that is structural rather than a habit.
 *
 * The armed 2-hour wait shared the default server on :5037 with everything else on this Mac.
 * While it ran, loopback experiments elsewhere in the session did `adb connect` against that
 * same server — and every one of those endpoints appeared in the armed run's device list, which
 * dutifully reported "device 127.0.0.1:49152 is OFFLINE ... Toggle Wireless debugging off/on".
 * A dozen strangers, described to the operator as their phone misbehaving.
 *
 * Promising to be careful next time is not a fix: the device list is shared state, and anything
 * on the machine can write to it. `adb -P <port>` gives this run a private server, so a listener
 * registered on the default one cannot enter its device list at all.
 *
 * 5039, not 5037 (the default) and not 5038 (adb's own second-choice / emulator console
 * neighbourhood). Overridable for the same reason everything else here is. */
const ADB_PORT = Number(flag('--adb-port', process.env.AGENTMOB_ADB_PORT || 5039));
const WAIT_S = Number(flag('--wait', 1800));
const TRIGGER = String(flag('--say', 'Device check. Counting: one, two, three, four, five, '
  + 'six, seven, eight, nine, ten. That is the end of the test sentence.'));

mkdirSync(OUT, { recursive: true });

const ADB = ['/opt/homebrew/bin/adb', '/opt/homebrew/share/android-commandlinetools/platform-tools/adb', 'adb']
  .find((p) => { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });

const report = [];
const stage = (name, status, detail = '') => {
  report.push({ name, status, detail });
  const tag = { verified: 'VERIFIED', built: 'BUILT', blocked: 'BLOCKED', failed: 'FAILED' }[status] || status;
  console.log(`[${tag.padEnd(8)}] ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (args, opts = {}) => {
  if (DRY) return { status: 0, stdout: '', stderr: '(dry-run)' };
  /* -P FIRST, always. Every adb call in this file goes through here precisely so the isolation
   * cannot be forgotten at one call site — which is the failure mode a convention would have. */
  const r = spawnSync(ADB, ['-P', String(ADB_PORT), ...args],
    { encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

/* The gateway-log helpers live in ./lib/gateway-log.mjs so tests can drive the REAL ones.
 * A mutation run showed device-stages was exercising its own reimplementation instead. */
const logSize = () => logStamp();
const logSince = (stamp) => logSinceReal(stamp);
const waitForLog = async (off, re, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = logSince(off).match(re);
    if (m) return m;
    await sleep(1000);
  }
  return null;
};

let cleaned = false;
/** Stop the adb server. Idempotent, because several exit paths may reach it. */
const stopAdb = () => {
  if (cleaned || DRY || !ADB) return;
  cleaned = true;
  /* OUR server, by port. Killing the default one would take down whatever else on this Mac is
   * using adb — the mirror image of the contamination this isolation exists to prevent. */
  try { execFileSync(ADB, ['-P', String(ADB_PORT), 'kill-server'], { stdio: 'ignore' }); } catch {}
};

/* A lingering adb server leaves Terra with repeated "Allow debugging?" prompts on the phone,
 * so the cleanup cannot depend on reaching the end of the script. Before these handlers, any
 * throw in a later stage — or a kill of a backgrounded run — skipped finish() entirely and left
 * the server up. That already happened once: stopping an armed run needed a manual
 * `adb kill-server` afterwards. Crashing loudly is fine; crashing dirty is not. */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.log(`\n${sig} — stopping adb before exit.`); stopAdb(); process.exit(130); });
}
process.on('uncaughtException', (e) => {
  console.error('\nUNCAUGHT: ' + (e && e.stack || e));
  stopAdb(); process.exit(70);
});
process.on('unhandledRejection', (e) => {
  console.error('\nUNHANDLED REJECTION: ' + (e && e.stack || e));
  stopAdb(); process.exit(70);
});
process.on('exit', stopAdb);   // last resort for any path not covered above

const finish = (code) => {
  stopAdb();
  console.log('\nadb server stopped.');
  const path = join(OUT, 'device-verify.json');
  writeFileSync(path, JSON.stringify({ generated: new Date().toISOString(), dryRun: DRY, report }, null, 2));
  console.log(`report -> ${path}`);
  const verified = report.filter((r) => r.status === 'verified').length;
  const blocked = report.filter((r) => r.status === 'blocked').length;
  const failed = report.filter((r) => r.status === 'failed').length;
  console.log(`\n${verified} verified, ${blocked} blocked, ${failed} failed`);
  process.exit(code);
};

if (!ADB) { stage('adb present', 'blocked', 'adb not found on PATH or in the Android SDK'); finish(2); }
console.log(`adb: ${ADB}${DRY ? '   (DRY RUN — no device will be touched)' : ''}`);

/* ---- 0. local preflight: everything knowable WITHOUT the phone ----------------------------
 *
 * These ran after the device gate, which meant they never ran at all — every blocked run
 * finish()es at "no device" long before reaching the install section. So a missing or STALE APK
 * was only discoverable once a handset was connected, i.e. during the one scarce thing this
 * whole harness is waiting for. Finding out then that the bundle is stale wastes the session.
 *
 * Nothing here touches adb. Moving it in front of the gate means a blocked run still reports
 * something useful, and the numbers stop reading "0 verified" when three local facts were in
 * fact established.
 *
 * The checks come from test/lib/apk-facts.mjs, shared with apk-installable rather than copied:
 * two implementations of a staleness check drift, and then one of them goes green on a stale
 * bundle and nobody knows which. */
for (const p of localApkPreflight()) stage(p.name, p.status, p.detail);

/* ---- 1. reach a device -------------------------------------------------------------------
 * Every non-ready outcome is reported as ITSELF. Collapsing them into "no device" is what made
 * this loop lie: an `unauthorized` device means the phone is showing an "Allow wireless
 * debugging?" dialog waiting for a tap — the one failure a person next to the phone fixes in
 * two seconds — and it was being reported as if nothing were plugged in at all. */
/* Resolved, not assumed. A hard-coded path means that on a Mac where Tailscale lives anywhere
 * else the spawn throws ENOENT, the try below swallows it, and the "phone is off the network"
 * vs "the port is shut" distinction — the entire reason this probe exists — silently collapses
 * into the generic message. It degrades to a correct-but-useless answer, which is the quietest
 * kind of wrong. */
const TS_BIN = (() => {
  const candidates = [
    process.env.AGENTMOB_TAILSCALE,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
  ].filter(Boolean);
  for (const c of candidates) { if (existsSync(c)) return c; }
  return null;
})();

/** Is the phone even on the tailnet? Separates "not on the network" from "port is shut". */
/** `tailscale status`, cached for the run — the peer's LAN address comes out of it. */
let _tsStatus = null;
function tailscaleStatus() {
  if (_tsStatus !== null) return _tsStatus;
  if (!TS_BIN) return (_tsStatus = '');
  _tsStatus = spawnSync(TS_BIN, ['status'], { encoding: 'utf8', timeout: 15000 }).stdout || '';
  return _tsStatus;
}

function tailnetProbe(target) {
  const host = String(target || '').split(':')[0];
  if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return { checked: false };
  if (!TS_BIN) {
    // Say so rather than degrade in silence: without this the run cannot tell a sleeping phone
    // from one with the toggle off, and the operator is sent after the wrong thing.
    console.log('  [discover] no tailscale binary found — set AGENTMOB_TAILSCALE to keep the '
      + '"off the network" vs "port shut" distinction');
    return { checked: false, noBinary: true };
  }
  try {
    /* STATUS FIRST, ping second — and that order is the whole fix.
     *
     * This used to decide reachability on ONE `tailscale ping`, and it produced a false negative
     * that sent the operator after entirely the wrong thing: "the phone is NOT REACHABLE ... it
     * is powered off, asleep, or off the tailnet", while `tailscale status` said
     * `active; direct 192.168.10.53, tx 3380716 rx 872412` and a manual ping returned a pong in
     * 414ms.
     *
     * The cause is self-inflicted. Discovery sweeps ~35,000 ports at the tailnet address, which
     * pushes every one of those connection attempts through the tunnel; a probe packet racing
     * that loses. Measured directly: ping idle -> PONG, ping during our own sweep -> NO REPLY,
     * then PONG again on the next attempt, and PONG once the sweep finished. So the verdict was
     * a coin flip on timing, and it was being reported as a fact about the hardware.
     *
     * The peer row does not race our traffic: it is local daemon state, and it says `active` or
     * `offline` outright. Ping stays as corroboration and as the source of the latency detail,
     * retried so a single lost packet cannot overrule the row. */
    const peer = parseTailscalePeer(tailscaleStatus(), host);
    const pingOnce = () => {
      const r = spawnSync(TS_BIN, ['ping', '-c', '1', '--timeout', '5s', host],
        { encoding: 'utf8', timeout: 20000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      return /pong from/i.test(out) ? out.trim().split('\n')[0] : null;
    };
    let pong = null;
    for (let i = 0; i < 3 && !pong; i++) pong = pingOnce();

    if (peer.found && peer.online) {
      return { checked: true, reachable: true,
        note: pong || `tailscale status says active (${peer.relay ? `relay ${peer.relay}`
          : peer.lan ? `direct ${peer.lan}` : 'no path detail'}); ping did not answer, which our `
          + 'own port sweep can cause' };
    }
    if (peer.found && peer.offline) {
      return { checked: true, reachable: false, note: 'tailscale status says offline' };
    }
    /* No usable row: the ping is all there is. */
    if (pong) return { checked: true, reachable: true, note: pong };
    const seen = (peer.line.match(/last seen [^,]*/i) || [])[0];
    return { checked: true, reachable: false,
      note: seen || 'no reply to tailscale ping and no active row in tailscale status' };
  } catch { return { checked: false }; }
}

let serial = null;
if (DRY) {
  stage('device authorised', 'blocked', 'dry run');
} else {
  const t0 = Date.now();
  const deadline = t0 + WAIT_S * 1000;
  console.log(`waiting up to ${WAIT_S}s for a device…`);
  let classified = classifyDevices('');
  let connectError = null;
  let tailnet = { checked: false };
  let lastLabel = null;
  let lastBeat = 0;
  /* Wireless debugging picks a RANDOM port, and it changes every time the toggle is cycled.
   * Waiting on a hand-supplied host:port means the run only ever completes if someone reads a
   * number off a screen — and a stale number fails quietly, so the wait just looks patient.
   * Discover it instead: mDNS when the phone is local, a bounded scan when it is remote. */
  let target = CONNECT;
  let lastDiscover = 0;
  /* Kept across iterations: the connect step below walks every open port the sweep found, not
   * just the one discover() chose. */
  let found = null;
  /* Set when every open port was tried and none spoke adb — so the blocked message does not
   * tell the operator to toggle a setting that may already be correct. */
  let notAdbNote = null;
  while (Date.now() < deadline) {
    if (!target && Date.now() - lastDiscover > DISCOVER_EVERY_MS) {
      lastDiscover = Date.now();
      /* Sweep the LAN address too when Tailscale says the peer is direct on this network.
       * Scanning only 100.x reported "nothing is listening" from a TIMEOUT, which proves nothing;
       * the LAN path returns CONNECTION REFUSED, which proves the phone is up and adbd is not. */
      const peer = parseTailscalePeer(tailscaleStatus(), PHONE_HOST);
      if (peer.lan) console.log(`  [discover] tailscale reports a direct LAN path: ${peer.lan}`);
      /* Bound the sweep by the RUN's deadline, not just by the loop condition.
       *
       * The while() check happens between iterations, so a single discovery pass ran to
       * completion however long it took: `--wait 5` printed "waiting up to 5s" and then sat for
       * 144s finishing a port scan. A bounded wait that is not actually bounded is exactly the
       * kind of thing that makes a healthy run look hung — the failure class this whole harness
       * exists to remove. scanPorts already honours an AbortSignal; nothing was passing one. */
      const remaining = () => Math.max(0, deadline - Date.now());
      const deadlineSignal = () => {
        const ac = new AbortController();
        const ms = remaining();
        if (ms <= 0) ac.abort();
        else { const t = setTimeout(() => ac.abort(), ms); t.unref?.(); }
        return ac.signal;
      };
      /* Decided once per pass, so both hosts in a pass share the same answer. */
      const doScan = Date.now() - lastScan >= SCAN_EVERY_MS;
      if (doScan) lastScan = Date.now();
      found = await discover({
        hosts: peer.lan ? [peer.lan, PHONE_HOST] : [PHONE_HOST],
        runMdns: async () => adb(['mdns', 'services'],
          { timeout: Math.max(1000, Math.min(20000, remaining())) }).stdout,
        /* null, not [] — "skipped" and "swept and found nothing" are different facts, and
         * returning [] made discover() log a sweep and a negative result for a pass that never
         * sent a packet. */
        scan: (h, ranges) => doScan
          ? scanPorts(h, ranges, { concurrency: 500, timeoutMs: 2000, signal: deadlineSignal() })
          : Promise.resolve(null),
        log: (m) => console.log(`  [discover] ${m}`),
      });
      if (found.endpoint) {
        target = found.endpoint;
        stage('wireless-debugging endpoint discovered', 'verified',
          `${target} (via ${found.via}) — no port was supplied by hand`);
      }
    }
    if (target) {
      /* Try EVERY open port the sweep found, not just the lowest.
       *
       * discover() answers with the first open port it meets, and on any host running something
       * else in the ephemeral range that is a stranger. Proven, not theorised: a loopback run
       * with a stub on :50094 latched onto :49152 — an unrelated service — and then reported
       * "device is OFFLINE, toggle Wireless debugging off/on", which is confident, actionable,
       * and wrong. On the Pixel that would have burned the first real device session chasing a
       * toggle that was already correct.
       *
       * So walk the candidates and stop at the first that yields an adb device row of any state.
       * `unauthorized` counts: it means adb reached adbd and the phone is showing the "Allow
       * wireless debugging?" dialog, which is a real endpoint and a two-second fix. */
      const ports = (found && Array.isArray(found.open) && found.open.length)
        ? found.open : [Number(String(target).split(':').pop())];
      const host = String(target).split(':').slice(0, -1).join(':') || String(target);
      let connected = false;
      let weak = null;          // an endpoint that connects but never identifies as adb
      for (const p of ports) {
        const ep = `${host}:${p}`;
        const r = adb(['connect', ep], { timeout: 15000 });
        connectError = connectErrorOf(r.stdout, r.stderr);
        const seen = classifyDevices(adb(['devices', '-l']).stdout);
        /* ONLY ready or unauthorized prove adbd is on the other end.
         *
         * `offline` does NOT. A non-adb service accepts the TCP connection, fails the adb
         * handshake, and adb files it as offline — which is exactly what a stranger looks like.
         * My first version of this walk accepted offline and therefore stopped on the stranger
         * anyway, reporting "device is OFFLINE, toggle Wireless debugging off/on": confident,
         * actionable, and wrong.
         *
         * `unauthorized` is kept because it is a REAL endpoint — adb reached adbd and the phone
         * is showing the "Allow wireless debugging?" dialog, a two-second fix. */
        if (seen.ready.length || seen.unauthorized.length) {
          if (ep !== target) console.log(`  [discover] ${target} was not adb; using ${ep}`);
          target = ep;
          connected = true;
          break;
        }
        if (seen.offline.length && !weak) weak = ep;
        /* Drop it so a stale entry cannot masquerade as the device on the next pass. */
        adb(['disconnect', ep], { timeout: 10000 });
      }
      if (!connected && ports.length) {
        /* Nothing identified as adb. Keep the offline one as the reported target so the blocked
         * message can still name an address, but say plainly that it never answered adb — rather
         * than sending someone to toggle a setting that may already be correct. */
        if (weak) {
          target = weak;
          adb(['connect', weak], { timeout: 15000 });
          notAdbNote = `${ports.length} open port(s) on ${host} were tried and NONE completed an `
            + `adb handshake — ${weak} accepts TCP but is not adbd, so the "offline" state above `
            + 'is a stranger answering, not the phone refusing. Do not toggle anything on that '
            + 'basis.';
          console.log(`  [discover] ${notAdbNote}`);
        } else {
          console.log(`  [discover] none of ${ports.length} open port(s) on ${host} answered adb`);
        }
      }
    }
    classified = classifyDevices(adb(['devices', '-l']).stdout);
    if (classified.ready.length) { serial = classified.ready[0]; break; }

    /* Say something whenever the state CHANGES, and at least every 60s, so a long wait is
     * never mistaken for a hang. Silence is the failure mode this whole pass is about. */
    const label = stateLabel(classified, { connectError });
    const now = Date.now();
    if (label !== lastLabel || now - lastBeat > 60000) {
      if (label !== lastLabel && /^none/.test(label)) tailnet = tailnetProbe(target || PHONE_HOST);
      const secs = Math.round((now - t0) / 1000);
      console.log(`  [${secs}s] ${describeBlocked({ classified, connectTarget: CONNECT, connectError, tailnet, waitedS: secs })}`);
      lastLabel = label; lastBeat = now;
    }
    await sleep(5000);
  }
  if (!serial) {
    if (!tailnet.checked) tailnet = tailnetProbe(target || PHONE_HOST);
    const blockedWhy = describeBlocked({ classified, connectTarget: target || PHONE_HOST,
      connectError, tailnet, waitedS: Math.round((Date.now() - t0) / 1000) });
    /* A generic "it is offline, toggle it" is wrong when we know the endpoint never spoke adb.
     * Correcting it here rather than in describeBlocked keeps that helper a pure function of the
     * adb state, which its own suite tests. */
    stage('device authorised', 'blocked',
      notAdbNote ? `${blockedWhy}\n           NOTE: ${notAdbNote}` : blockedWhy);
    finish(1);
  }
  stage('device authorised', 'verified', serial);
}

const sh = (cmd) => adb(['-s', serial, 'shell', cmd]).stdout.trim();
let lastShotError = null;
const shot = (name) => {
  if (DRY) return false;
  const r = spawnSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 1000) {
    // Was a bare `return false`, so a failed screenshot reported only the filename and the run
    // learned nothing about why — a permission prompt and a dead device looked identical.
    lastShotError = (r.stderr && r.stderr.toString().trim().slice(0, 120))
      || `screencap returned ${r.status} and ${r.stdout ? r.stdout.length : 0} bytes`;
    return false;
  }
  lastShotError = null;
  writeFileSync(join(OUT, name), r.stdout);
  return true;
};

/* ---- 2. install ---------------------------------------------------------------------------
 * -r REPLACES in place and keeps app data. That matters: the IdentityStore keypair lives in
 * app-private SharedPreferences, so a plain uninstall/reinstall would rotate client_id and
 * invalidate the pinning decision. */
if (!existsSync(APK)) stage('APK present', 'blocked', APK);
else if (DRY) stage('install APK', 'blocked', 'dry run');
else {
  const r = adb(['-s', serial, 'install', '-r', APK], { timeout: 300000 });
  const okInstall = /Success/i.test(r.stdout + r.stderr);
  stage('install APK (-r, keeps IdentityStore)', okInstall ? 'verified' : 'failed',
    okInstall ? APK : (r.stderr || r.stdout).trim().slice(0, 200));
}

/* ---- 2b. the WebView version, from the DEVICE's own report --------------------------------
 *
 * The open question this closes: index.html used `container-type` / `@container` and `:has()`,
 * all of which need Chrome 105+. At the time minSdk claimed 24 (Android 7, WebView Chrome 51). The
 * note in the CSS said an old WebView "ignores @container" and left it at that for weeks.
 *
 * Both were removed rather than gambled on (a media query and a JS-toggled class express the
 * same conditions and need nothing newer than 2012), so correctness no longer depends on the
 * answer. But "we no longer need to know" is not the same as knowing, and the version is a fact
 * this stage can simply read the moment adb is reachable. Recording it means the next person
 * deciding whether some modern CSS is safe has a measurement instead of an assumption.
 *
 * Read from the package manager, not from a UA string: the UA can be overridden by the app, the
 * package version is what is actually installed. Both Google's WebView and a Chrome-provided
 * one are checked, since either can be the WebView implementation. */
if (!DRY && serial) {
  const providers = ['com.google.android.webview', 'com.android.webview',
                     'com.android.chrome', 'com.google.android.trichromelibrary'];
  const found = [];
  for (const pkg of providers) {
    const r = adb(['-s', serial, 'shell', 'dumpsys', 'package', pkg], { timeout: 30000 });
    const v = /versionName=(\S+)/.exec(r.stdout || '');
    if (v) found.push(`${pkg}=${v[1]}`);
  }
  /* The implementation actually in use, when the device will say. */
  const impl = adb(['-s', serial, 'shell', 'cmd', 'webviewupdate', 'query'], { timeout: 30000 });
  const implLine = (impl.stdout || '').split('\n')
    .find((l) => /current webview package/i.test(l)) || '';
  const major = found.map((f) => Number((/=(\d+)/.exec(f) || [])[1])).filter(Boolean).sort((a, b) => b - a)[0];
  if (found.length) {
    stage('WebView version read from the device', 'verified',
      `${found.join(' ')} ${implLine.trim()}`.trim()
      + (major ? ` | major ${major} — container queries and :has() need 105+` : ''));
  } else {
    stage('WebView version read from the device', 'failed',
      'no WebView provider package reported a versionName; tried ' + providers.join(', '));
  }
}

/* ---- 3. launch ---------------------------------------------------------------------------- */
if (!DRY && serial) {
  const logOff = logSize();
  adb(['-s', serial, 'shell', 'am', 'force-stop', PKG]);
  await sleep(1000);
  adb(['-s', serial, 'shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
  await sleep(6000);
  const alive = sh(`pidof ${PKG} || true`);
  stage('app launched', alive ? 'verified' : 'failed', alive ? `pid ${alive}` : 'no process');
  stage('screenshot: boot', shot('01-boot.png') ? 'verified' : 'blocked',
    lastShotError ? `01-boot.png — ${lastShotError}` : '01-boot.png');

  /* ---- 4. handshake ------------------------------------------------------------------------
   * opus PT 111 = Android libwebrtc. werift (the test harness) offers 96, so this is how the
   * run proves it is looking at the real device and not at its own fake phone. */
  const hs = await waitForLog(logOff, /\[sidecar\] handshake confirmed (\S+)/, 60000);
  stage('AEAD handshake', hs ? 'verified' : 'blocked', hs ? `client_id ${hs[1]}` : 'no handshake in 60s');
  const pin = logSince(logOff).match(/\[sidecar\] PAIRING: client (\S+) identity=(\S+?)(?:\s|$)/);
  if (pin) {
    stage('live client identity', 'verified', `${pin[1]} — pin with allowed_clients: "${pin[1]}"`);
    const expected = pin[1] === '42c55608';
    stage('identity matches the archived id (42c55608)', expected ? 'verified' : 'blocked',
      expected ? 'unchanged since August' : `ROTATED: now ${pin[1]} — do NOT pin 42c55608`);
  }
  const pt = await waitForLog(logOff, /\[sidecar\] webrtc answer sent opusPT=(\d+)/, 45000);
  if (pt) {
    const android = pt[1] === '111';
    stage('WebRTC negotiated by Android libwebrtc', android ? 'verified' : 'blocked',
      `opus PT ${pt[1]}${android ? '' : ' (96 = werift harness, not the device)'}`);
  } else {
    stage('WebRTC negotiated', 'blocked', 'no offer/answer in 45s — ICE may not be reachable');
  }

  /* WHICH PATH the media took, which is the claim — not merely that ICE connected.
   *
   * If the Pixel and this Mac are on the same Wi-Fi, the LAN pair wins on priority and a
   * connected state says nothing about reaching this Mac from anywhere else. The two outcomes
   * are indistinguishable from the outside, so a run done on the sofa could "verify" a property
   * that has never once been exercised. The sidecar now logs the nominated pair on the
   * connected transition; this reads it back and names which one happened. */
  /* Either shape ends the wait. Matching only `remote=` meant the UNKNOWN line — which the
   * sidecar logs the instant it cannot read a pair — sat out the full 20s before the run
   * concluded the same thing. Dead time in front of someone holding the phone. */
  const pair = await waitForLog(logOff,
    /\[sidecar\] webrtc ICE pair (?:remote=(\S+)|unknown)/, 20000);
  const path = classifyIcePath(pair && pair[1]);
  if (path.via === 'unknown') {
    stage('ICE path (tailnet vs LAN)', 'blocked',
      'the sidecar logged no nominated pair — werift did not expose one');
  } else {
    stage(path.via === 'tailnet' ? 'ICE over the Tailscale TUN' : 'ICE connected, but over the LAN',
      path.via === 'tailnet' ? 'verified' : 'blocked', path.note);
  }

  stage('screenshot: connected control bar', shot('02-connected.png') ? 'verified' : 'blocked',
    '02-connected.png — check Stop vs the native mic (issue #2)');
  stage('screenshot: widget tiles / theme tokens', shot('03-surface.png') ? 'verified' : 'blocked',
    '03-surface.png — check tiles render on var(--surface)/var(--ink)');

  /* ---- 5/6/7. speak, then mute MID-SENTENCE ------------------------------------------------ */
  const dens = Number((sh('wm density').match(/(\d+)\s*$/) || [])[1] || 0) / 160;
  const size = sh('wm size').match(/(\d+)x(\d+)\s*$/);
  const MIC_SIZE = Number((readFileSync(JAVA, 'utf8').match(/MIC_SIZE_DP\s*=\s*(\d+)/) || [])[1]);
  const MIC_GAP = Number((readFileSync(JAVA, 'utf8').match(/MIC_BOTTOM_GAP_DP\s*=\s*(\d+)/) || [])[1]);

  if (!dens || !size || !MIC_SIZE) {
    stage('mute mid-sentence (issue #1)', 'blocked', 'could not read density/size/mic constants');
  } else {
    const W = Number(size[1]), H = Number(size[2]);
    /* Nav-bar inset in px, best effort. The mic is MIC_SIZE dp tall, so even a wrong inset
     * stays well inside the button: the tap aims at its centre, +-MIC_SIZE/2 dp of slack. */
    const navPx = Number((sh('dumpsys window | grep -m1 -o "navigationBars.*frame=\\[[0-9]*,[0-9]*\\]\\[[0-9]*,[0-9]*\\]" | grep -o "[0-9]*\\]$" | grep -o "[0-9]*"') || 0)) || 0;
    const tapX = Math.round(W / 2);
    const tapY = Math.round(H - (navPx + (MIC_GAP + MIC_SIZE / 2) * dens));
    stage('mic tap point from MainActivity constants', 'built',
      `(${tapX},${tapY}) — ${MIC_SIZE}dp button, gap ${MIC_GAP}dp, density ${dens}, nav ${navPx}px`);

    /* The trigger must make the agent SPEAK to the phone.
     *
     * NOT `hermes send -t agentmob`: it cannot reach the platform out-of-process — "No live
     * adapter for platform 'agentmob' ... must register a standalone_sender_fn" — and it EXITS
     * 0 while failing, so checking the status reported this stage VERIFIED for a command that
     * did nothing. Confirmed by running it: exit 0, zero sidecar pushes.
     *
     * A typed turn over a second AEAD connection is the route that works, and it is the same
     * one the app's text path uses. ORDERING MATTERS: the sidecar sends reply audio to
     * conns[0], the FIRST connection, not whoever asked. The trigger therefore connects AFTER
     * the phone (which attached at stage 3) and disconnects once the turn is in, leaving the
     * handset as the only connection and so the unambiguous target. */
    const off2 = logSize();
    const trig = await typedTurn({ text: TRIGGER });
    const triggerFailed = !trig.ok;
    stage('trigger a spoken reply (typed turn over AEAD)',
      triggerFailed ? 'blocked' : 'verified',
      triggerFailed ? String(trig.error) : 'sent, then disconnected so the phone is conns[0]');
    if (triggerFailed) {
      stage('speaking pill', 'blocked', 'no trigger, so nothing was spoken');
      stage('mute mid-sentence (issue #1)', 'blocked', 'no trigger, so nothing was playing');
    }

    /* Wait until the sidecar is actually pushing audio, then grab the pill and cut it off. */
    const speaking = triggerFailed
      ? false
      : await waitForLog(off2, /\[sidecar\] → phone pcm /, 90000);
    if (!speaking) {
      if (!triggerFailed) {
        stage('speaking pill', 'blocked', 'no reply audio within 90s');
        stage('mute mid-sentence (issue #1)', 'blocked', 'nothing was playing to interrupt');
      }
    } else {
      await sleep(1200);   // let the pill render and a little audio play
      stage('screenshot: speaking pill', shot('04-speaking.png') ? 'verified' : 'blocked',
        '04-speaking.png — pill should clear the native identity badge');

      /* TWO DIFFERENT CONTROLS, and they were being conflated.
       *
       * The native mic button calls plugin.nativeToggleMic() -> AudioManager.setMicrophoneMute.
       * It mutes the MICROPHONE. It does not touch the agent's reply, so it produces NO
       * truncation — the reply keeps playing, correctly. This stage used to tap the mic and
       * then wait for a `cut short` line, which a healthy phone would never produce: it would
       * have reported issue #1 as broken on a device where the mute worked perfectly.
       *
       * Truncation comes from the INTERRUPT the Stop control sends ({"cmd":"interrupt"}), which
       * is a separate button. So each is now checked against what it actually does. */
      const off3 = logSize();
      adb(['-s', serial, 'shell', 'input', 'tap', String(tapX), String(tapY)]);
      stage('tapped the native mic mid-sentence', 'built', `(${tapX},${tapY})`);
      await sleep(1500);
      shot('05-after-mute.png');

      /* What the MIC tap must actually change: the device's mic-mute state. */
      const micMuted = sh('dumpsys audio | grep -i "mic.*mute\|mMicMute" | head -3');
      stage('mute mid-sentence: the device reports the mic muted (issue #1)',
        /true/i.test(micMuted) ? 'verified' : 'blocked',
        micMuted ? micMuted.replace(/\s+/g, ' ').slice(0, 140)
                 : 'dumpsys audio reported no mic-mute state');
      stage('mute mid-sentence: the reply KEPT playing (muting the mic must not stop it)',
        'built', 'compare 04-speaking.png and 05-after-mute.png — the pill should still be lit');

      /* The interrupt is the control that truncates. Tap Stop, which the web layer renders at
       * the right of #ctrlbar: its centre sits one third of the bar's width in from the right
       * edge, on the same centreline as the mic (ctrlbar-geometry pins that to within 1dp). */
      const stopX = Math.round(W - (66 * dens));
      const off4 = logSize();
      adb(['-s', serial, 'shell', 'input', 'tap', String(stopX), String(tapY)]);
      stage('tapped Stop mid-sentence', 'built', `(${stopX},${tapY})`);
      const cut = await waitForLog(off4, /\[sidecar\] → phone pcm .*\[cut short after (\d+)\/(\d+) frames: ([^\]]+)\]/, 30000);
      if (cut) {
        stage('Stop actually stopped the audio', 'verified',
          `cut at ${cut[1]}/${cut[2]} frames — ${cut[3]}`);
      } else {
        stage('Stop actually stopped the audio', 'blocked',
          'no truncation logged within 30s — the reply may have finished first; '
          + 'retry with a longer --say');
      }
      shot('06-after-stop.png');
    }
  }
}

finish(report.some((r) => r.status === 'failed') ? 1 : 0);
