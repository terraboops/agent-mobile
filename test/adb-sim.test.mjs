/**
 * adb-sim.test — run the device paths no device has ever exercised, against a scripted adb.
 *
 * The USB install path and the "Allow wireless debugging?" branch were written and never
 * executed: no cable had been plugged in and the prompt had never been on screen. That is a
 * guard with nothing behind it, and the first time it ran would have been during the minutes
 * someone was holding the phone. test/fixtures/fake-adb.mjs replays the TEXT adb prints and
 * logs every call, so the real scripts run end to end here.
 *
 * Running them found three defects the first time, which is the argument for the suite:
 *   - a simulated run wrote device-verify.json as a real report, and acceptanceCoverage then
 *     reported three acceptance items MOVED — fabricated device evidence from a test harness;
 *   - an unauthorized phone was disconnected (tearing down the connection whose prompt the user
 *     has to tap) and blacklisted, so tapping Allow was never noticed, and the run ended by
 *     saying Wireless debugging was OFF about a phone that had it on;
 *   - the handoff's last line named a file it had not written.
 *
 * WHAT THIS CANNOT SHOW: that a real phone prints this text, accepts this install, or shows
 * this prompt. Those remain the device's to answer.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reportKind } from './lib/run-facts.mjs';
import { acceptanceCoverage } from './lib/device-acceptance.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(REPO, 'test/fixtures/fake-adb.mjs');
const OUT = join(REPO, 'test/audit/out/device');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

/* The real report must survive this suite untouched — the first simulated run overwrote it. */
const REAL = join(OUT, 'device-verify.json');
const realBefore = existsSync(REAL) ? readFileSync(REAL, 'utf8') : null;
const REAL_H = join(OUT, 'device-handoff.json');
const realHBefore = existsSync(REAL_H) ? readFileSync(REAL_H, 'utf8') : null;

const scenario = (sc) => {
  const d = mkdtempSync(join(tmpdir(), 'fake-adb-'));
  writeFileSync(join(d, 'sc.json'), JSON.stringify(sc));
  return { dir: d, path: join(d, 'sc.json'),
           calls: () => (existsSync(join(d, 'sc.json.calls'))
             ? readFileSync(join(d, 'sc.json.calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
             : []) };
};
const env = (sc) => ({ ...process.env, AGENTMOB_ADB: FAKE, FAKE_ADB_SCENARIO: sc.path,
                       AGENTMOB_HANDOFF_TICK_S: '1',
                       AGENTMOB_APK: 'android/app/build/outputs/apk/release/app-release.apk' });
const verify = (sc, args) => spawnSync(process.execPath, [join(REPO, 'test/device-verify.mjs'), ...args],
  { cwd: REPO, env: env(sc), encoding: 'utf8', timeout: 180000 });
const handoff = (sc, args) => spawnSync(process.execPath, [join(REPO, 'test/device-handoff.mjs'), ...args],
  { cwd: REPO, env: env(sc), encoding: 'utf8', timeout: 180000 });

console.log('\nadb-sim — the device paths, against a scripted adb\n');

/* ---- 1. USB: discovery by serial, install by serial ---------------------------------------- */
{
  const sc = scenario({ usb: '33250DLH2000CB', model: 'Pixel 7', install: 'Success' });
  const r = verify(sc, ['--only', 'install', '--wait', '20']);
  const calls = sc.calls();
  ok('usb: the cable serial is taken as the device', /device authorised — 33250DLH2000CB/.test(r.stdout),
    r.stdout.split('\n').filter((l) => /authorised/.test(l)).join(' '));
  ok('usb: install is addressed to THAT serial with -r',
    calls.some((c) => c.serial === '33250DLH2000CB' && c.args[0] === 'install' && c.args[1] === '-r'),
    JSON.stringify(calls.filter((c) => c.args[0] === 'install')));
  ok('usb: no network connect was attempted', !calls.some((c) => c.args[0] === 'connect'),
    'the cable needs no `adb connect`; one here means the USB path fell through to the network one');
  ok('usb: the install stage verifies on Success',
    /\[VERIFIED\] install APK \(-r, keeps IdentityStore\)/.test(r.stdout));
  rmSync(sc.dir, { recursive: true, force: true });
}
{
  const sc = scenario({ usb: '33250DLH2000CB', model: 'Pixel 7',
    install: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.agentmobile.agent signatures do not match newer version; ignoring!]' });
  const r = verify(sc, ['--only', 'install', '--wait', '20']);
  ok('usb: a signer mismatch over the cable gets the named verdict',
    /SIGNER MISMATCH/.test(r.stdout) && /DO NOT UNINSTALL/.test(r.stdout));
  ok('usb: and raises the DO NOT UNINSTALL stage', /\[FAILED  \] DO NOT UNINSTALL to recover/.test(r.stdout));
  ok('usb: and exits non-zero', r.status !== 0, `exit ${r.status}`);
  rmSync(sc.dir, { recursive: true, force: true });
}

/* ---- 1b. LAUNCH — the verdict branches, through the real script -----------------------------
 * The am-start refusal and the logcat crash attribution were unit-tested as parsers. The
 * branches in device-verify that USE them had never executed. */
const launch = (extra) => {
  const sc = scenario({ usb: '33250DLH2000CB', ...extra });
  const r = verify(sc, ['--only', 'launch', '--wait', '15']);
  const line = r.stdout.split('\n').find((l) => /\] app launched/.test(l)) || '';
  rmSync(sc.dir, { recursive: true, force: true });
  return line;
};
{
  const healthy = launch({ pid: '4242', logcat: '' });
  ok('launch: a live process with a clean log verifies', /VERIFIED\] app launched — pid 4242/.test(healthy), healthy);
  const loop = launch({ pid: '4242', logcat: '09-29 E AndroidRuntime: FATAL EXCEPTION: main\n'
    + '09-29 E AndroidRuntime: Process: com.agentmobile.agent, PID: 4242\n'
    + '09-29 E AndroidRuntime: java.lang.NullPointerException: ko keypair\n' });
  ok('launch: a crash loop FAILS even though a pid exists', /FAILED  \] app launched — fatal/.test(loop), loop);
  ok('launch: and names the exception', /NullPointerException/.test(loop), loop);
  const other = launch({ pid: '4242', logcat: '09-29 E AndroidRuntime: FATAL EXCEPTION: main\n'
    + '09-29 E AndroidRuntime: Process: com.someone.else, PID: 9\n'
    + '09-29 E AndroidRuntime: java.lang.IllegalStateException: x\n' });
  ok('launch: ANOTHER app crashing does not fail ours', /VERIFIED\] app launched/.test(other), other);
  const refused = launch({ amStart: 'not-exported', logcat: '' });
  ok('launch: a not-exported refusal is named, not "no process"',
    /am start refused: the launch component is not exported/.test(refused), refused);
}

/* ---- 2. a simulated run must never read as device evidence ---------------------------------- */
{
  const sim = JSON.parse(readFileSync(join(OUT, 'device-verify.sim.json'), 'utf8'));
  ok('quarantine: a simulated report is marked simulated', sim.simulated === true);
  ok('quarantine: and classifies as simulated, not partial or full',
    reportKind(sim).kind === 'simulated', JSON.stringify(reportKind(sim)));
  ok('quarantine: acceptanceCoverage moves NOTHING from it',
    acceptanceCoverage(sim).moved.length === 0 && !acceptanceCoverage(sim).usable,
    `moved: ${acceptanceCoverage(sim).moved.join(', ')} — the first simulated run claimed three`);
  ok('quarantine: the real device-verify.json was not touched',
    (existsSync(REAL) ? readFileSync(REAL, 'utf8') : null) === realBefore,
    'a scripted adb overwrote the device evidence');
}

/* ---- 3. the Allow prompt: found once, tapped later ------------------------------------------ */
{
  const sc = scenario({ mdns: '192.168.10.53:37129', mdnsOnce: true, unauthorizedFor: 3, model: 'Pixel 7' });
  const r = handoff(sc, ['--hours', '0.004', '--tiers', 'usb,mdns', '--pass-only', 'install', '--no-ws']);
  const calls = sc.calls();
  ok('allow: the prompt is reported as a WAIT, not a rejection',
    /WAITING: .* "Allow wireless debugging\?"/.test(r.stdout) && !/REJECTED/.test(r.stdout),
    r.stdout.split('\n').filter((l) => /WAITING|REJECTED/.test(l)).join(' | '));
  ok('allow: the connection is NOT torn down while the prompt is up',
    !calls.some((c) => c.args[0] === 'disconnect'),
    'disconnecting an unauthorized phone removes the connection its prompt belongs to');
  ok('allow: tapping Allow is noticed even though discovery never offers it again',
    /CONFIRMED: model Pixel 7/.test(r.stdout) && /Allow was tapped after/.test(r.stdout),
    'the endpoint was advertised once; only holding it as a wait lets a later tap register');
  ok('allow: and the passes then run', /=== full sweep/.test(r.stdout));
  ok('allow: re-checks are not reported as fresh discoveries',
    (r.stdout.match(/CANDIDATE 192\.168\.10\.53/g) || []).length === 1,
    'mDNS advertised once; the log said it had been seen on every tick');
  rmSync(sc.dir, { recursive: true, force: true });
}

/* ---- 4. the Allow prompt, never answered ---------------------------------------------------- */
{
  const sc = scenario({ mdns: '192.168.10.53:37129', mdnsOnce: true, unauthorizedFor: 999, model: 'Pixel 7' });
  const r = handoff(sc, ['--hours', '0.003', '--tiers', 'usb,mdns', '--pass-only', 'install', '--no-ws']);
  ok('unanswered: the verdict says the phone was FOUND and is waiting on Allow',
    /the phone was FOUND at 192\.168\.10\.53:37129 and is showing "Allow wireless debugging\?"/.test(r.stdout),
    r.stdout.split('\n').filter((l) => /FOUND|found nothing|still off/.test(l)).join(' | '));
  ok('unanswered: it does NOT say wireless debugging is off',
    !/Wireless debugging is still off/.test(r.stdout),
    'the one setting that is already right, named as the problem');
  ok('unanswered: nothing was run', !/=== full sweep/.test(r.stdout));
  ok('unanswered: and it exits non-zero, not as a pass', r.status !== 0, `exit ${r.status}`);
  ok('unanswered: the handoff names the file it actually wrote',
    /handoff log -> .*device-handoff\.sim\.json/.test(r.stdout));
  rmSync(sc.dir, { recursive: true, force: true });
}

/* ---- 4b. the HANDOFF over USB, which had no scenario at all -------------------------------
 * The USB cases above go through device-verify. The handoff's own usb tier — the one that
 * would fire first if a cable were plugged in during the arm — had never run anywhere. */
{
  const sc = scenario({ usb: '33250DLH2000CB', model: 'Pixel 7', install: 'Success' });
  const r = handoff(sc, ['--hours', '0.003', '--tiers', 'usb,mdns', '--pass-only', 'install', '--no-ws']);
  const calls = sc.calls();
  ok('handoff usb: the cable is found without any network step',
    /CANDIDATE 33250DLH2000CB .* over USB/.test(r.stdout) && !calls.some((c) => c.args[0] === 'connect'),
    r.stdout.split('\n').filter((l) => /CANDIDATE|CONFIRM|REJECT/.test(l)).join(' | '));
  ok('handoff usb: the serial is confirmed by model before anything runs',
    /CONFIRMED: model Pixel 7/.test(r.stdout));
  ok('handoff usb: and the install pass addresses that serial',
    calls.some((c) => c.serial === '33250DLH2000CB' && c.args[0] === 'install'),
    JSON.stringify(calls.filter((c) => c.args[0] === 'install')));
  rmSync(sc.dir, { recursive: true, force: true });
}

/* ---- 5. the wrong phone ---------------------------------------------------------------------- */
{
  const sc = scenario({ mdns: '192.168.10.77:40111', unauthorizedFor: 0, model: 'SM-G991B' });
  const r = handoff(sc, ['--hours', '0.002', '--tiers', 'usb,mdns', '--pass-only', 'install', '--no-ws']);
  const calls = sc.calls();
  ok('wrong phone: another Android is refused by model', /REFUSED|REJECTED: .*not a Pixel/.test(r.stdout),
    r.stdout.split('\n').filter((l) => /REJECT|REFUS|CONFIRM/.test(l)).join(' | '));
  ok('wrong phone: nothing is installed on it',
    !calls.some((c) => c.args[0] === 'install'),
    'this is somebody else\'s handset');
  ok('wrong phone: it is disconnected again', calls.some((c) => c.args[0] === 'disconnect'));
  rmSync(sc.dir, { recursive: true, force: true });
}

ok('the real device-handoff.json was not touched by any of this',
  (existsSync(REAL_H) ? readFileSync(REAL_H, 'utf8') : null) === realHBefore);

console.log('\n  These replay adb\'s TEXT. That a real phone prints it, accepts the install, and');
console.log('  shows the prompt is still the phone\'s to answer.');
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
