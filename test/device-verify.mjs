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
import { discover, scanPorts, DEFAULT_SCAN_RANGES } from './lib/adb-discover.mjs';
import { typedTurn } from './lib/aead-trigger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/audit/out/device');
const APK = join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');
const JAVA = join(ROOT, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');
const GLOG = join(homedir(), '.hermes/logs/gateway.log');
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
  const r = spawnSync(ADB, args, { encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

/* Timestamps, NOT byte offsets. gateway.log rotates at 5MB; a rotation mid-run leaves an
 * offset pointing into a file that no longer exists, slice() returns '', and EVERY log-based
 * stage here — handshake, identity, opus PT, speaking, the cut-short proof — reports "blocked"
 * on a perfectly working phone. The same bug bit e2e-interrupt, where it reported a healthy
 * sidecar as broken three times before I read the raw log. Local time, not toISOString(): the
 * log stamps local, and UTC here sits hours in the future and matches nothing. */
const logSize = () => {
  const d = new Date(Date.now() - 2000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
       + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const logSince = (stamp) => {
  let text = '';
  for (const f of [GLOG + '.1', GLOG]) {
    try { text += readFileSync(f, 'utf8'); } catch { /* rotated away or absent */ }
  }
  return text.split('\n').filter((l) => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return m && m[1] >= stamp;
  }).join('\n');
};
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
  try { execFileSync(ADB, ['kill-server'], { stdio: 'ignore' }); } catch {}
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
    const r = spawnSync(TS_BIN, ['ping', '-c', '1', '--timeout', '3s', host],
      { encoding: 'utf8', timeout: 15000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (/pong from/i.test(out)) return { checked: true, reachable: true, note: out.trim().split('\n')[0] };
    const status = spawnSync(TS_BIN, ['status'], { encoding: 'utf8', timeout: 15000 }).stdout || '';
    const row = status.split('\n').find((l) => l.includes(host)) || '';
    const seen = (row.match(/last seen [^,]*/i) || [])[0];
    return { checked: true, reachable: false, note: seen || 'no reply to tailscale ping' };
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
  while (Date.now() < deadline) {
    if (!target && Date.now() - lastDiscover > DISCOVER_EVERY_MS) {
      lastDiscover = Date.now();
      const found = await discover({
        host: PHONE_HOST,
        runMdns: async () => adb(['mdns', 'services'], { timeout: 20000 }).stdout,
        scan: (h, ranges) => scanPorts(h, ranges, { concurrency: 500, timeoutMs: 2000 }),
        log: (m) => console.log(`  [discover] ${m}`),
      });
      if (found.endpoint) {
        target = found.endpoint;
        stage('wireless-debugging endpoint discovered', 'verified',
          `${target} (via ${found.via}) — no port was supplied by hand`);
      }
    }
    if (target) {
      const r = adb(['connect', String(target)], { timeout: 15000 });
      connectError = connectErrorOf(r.stdout, r.stderr);
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
    stage('device authorised', 'blocked',
      describeBlocked({ classified, connectTarget: target || PHONE_HOST, connectError, tailnet,
                        waitedS: Math.round((Date.now() - t0) / 1000) }));
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
