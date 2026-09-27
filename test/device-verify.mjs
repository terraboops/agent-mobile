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
 *   npm run device-verify                          # wait for any authorised device
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

/* Read the gateway log from a byte offset, so each stage only sees what it caused. */
const logSize = () => { try { return readFileSync(GLOG).length; } catch { return 0; } };
const logSince = (off) => { try { return readFileSync(GLOG, 'utf8').slice(off); } catch { return ''; } };
const waitForLog = async (off, re, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = logSince(off).match(re);
    if (m) return m;
    await sleep(1000);
  }
  return null;
};

const finish = (code) => {
  /* Non-negotiable: never leave an adb server running. */
  if (!DRY && ADB) { try { execFileSync(ADB, ['kill-server'], { stdio: 'ignore' }); } catch {} }
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
const TS_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** Is the phone even on the tailnet? Separates "not on the network" from "port is shut". */
function tailnetProbe(target) {
  const host = String(target || '').split(':')[0];
  if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return { checked: false };
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
  while (Date.now() < deadline) {
    if (CONNECT) {
      const r = adb(['connect', String(CONNECT)], { timeout: 15000 });
      connectError = connectErrorOf(r.stdout, r.stderr);
    }
    classified = classifyDevices(adb(['devices', '-l']).stdout);
    if (classified.ready.length) { serial = classified.ready[0]; break; }

    /* Say something whenever the state CHANGES, and at least every 60s, so a long wait is
     * never mistaken for a hang. Silence is the failure mode this whole pass is about. */
    const label = stateLabel(classified, { connectError });
    const now = Date.now();
    if (label !== lastLabel || now - lastBeat > 60000) {
      if (label !== lastLabel && CONNECT && /^none/.test(label)) tailnet = tailnetProbe(CONNECT);
      const secs = Math.round((now - t0) / 1000);
      console.log(`  [${secs}s] ${describeBlocked({ classified, connectTarget: CONNECT, connectError, tailnet, waitedS: secs })}`);
      lastLabel = label; lastBeat = now;
    }
    await sleep(5000);
  }
  if (!serial) {
    if (CONNECT && !tailnet.checked) tailnet = tailnetProbe(CONNECT);
    stage('device authorised', 'blocked',
      describeBlocked({ classified, connectTarget: CONNECT, connectError, tailnet,
                        waitedS: Math.round((Date.now() - t0) / 1000) }));
    finish(1);
  }
  stage('device authorised', 'verified', serial);
}

const sh = (cmd) => adb(['-s', serial, 'shell', cmd]).stdout.trim();
const shot = (name) => {
  if (DRY) return false;
  const r = spawnSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 1000) return false;
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
  stage('screenshot: boot', shot('01-boot.png') ? 'verified' : 'blocked', '01-boot.png');

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

    const off2 = logSize();
    const hs2 = spawnSync(join(homedir(), '.hermes/hermes-agent/venv/bin/hermes'),
      ['send', '-t', 'agentmob', TRIGGER], { encoding: 'utf8', timeout: 60000 });
    stage('trigger a spoken reply', hs2.status === 0 ? 'verified' : 'blocked',
      hs2.status === 0 ? 'hermes send -t agentmob' : (hs2.stderr || '').trim().slice(0, 160));

    /* Wait until the sidecar is actually pushing audio, then grab the pill and cut it off. */
    const speaking = await waitForLog(off2, /\[sidecar\] → phone pcm /, 90000);
    if (!speaking) {
      stage('speaking pill', 'blocked', 'no reply audio within 90s');
      stage('mute mid-sentence (issue #1)', 'blocked', 'nothing was playing to interrupt');
    } else {
      await sleep(1200);   // let the pill render and a little audio play
      stage('screenshot: speaking pill', shot('04-speaking.png') ? 'verified' : 'blocked',
        '04-speaking.png — pill should clear the native identity badge');

      const off3 = logSize();
      adb(['-s', serial, 'shell', 'input', 'tap', String(tapX), String(tapY)]);
      stage('tapped the native mic mid-sentence', 'built', `(${tapX},${tapY})`);
      shot('05-after-mute.png');

      /* The proof: a truncated playback records how far it got. A screenshot of a pressed
       * button would not show whether the audio actually stopped. */
      const cut = await waitForLog(off3, /\[sidecar\] → phone pcm .*\[cut short after (\d+)\/(\d+) frames: ([^\]]+)\]/, 30000);
      if (cut) {
        stage('mute mid-sentence actually stopped the audio (issue #1)', 'verified',
          `cut at ${cut[1]}/${cut[2]} frames — ${cut[3]}`);
      } else {
        stage('mute mid-sentence (issue #1)', 'blocked',
          'no truncation logged within 30s — the reply may have finished first; '
          + 'retry with a longer --say');
      }
    }
  }
}

finish(report.some((r) => r.status === 'failed') ? 1 : 0);
