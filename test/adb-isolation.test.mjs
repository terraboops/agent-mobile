/**
 * adb-isolation.test — a stranger on the default adb server must not become "the phone".
 *
 * WHAT WENT WRONG. A 2-hour armed device-verify shared the default adb server on :5037 with
 * everything else on this Mac. Loopback experiments elsewhere in the same session ran
 * `adb connect` against that server, and every one of those endpoints entered the armed run's
 * device list. It reported, repeatedly and with confidence:
 *
 *     device 127.0.0.1:49152 is OFFLINE — adb can see it but it is not responding.
 *     Toggle Wireless debugging off/on on the phone, then re-run.
 *
 * A dozen strangers, described to the operator as their phone misbehaving. The run recovered and
 * its final verdict was right, but for minutes it was emitting wrong, actionable advice about
 * hardware it had never touched.
 *
 * "Be careful not to do that again" is not a fix. The adb device list is SHARED STATE and
 * anything on the machine can write to it, including a future test, a build script, or Android
 * Studio. device-verify now runs against its own server (`adb -P <port>`), so a listener
 * registered on the default one cannot enter its list at all.
 *
 * WHAT THIS SUITE PROVES, and what it does not. Both directions are exercised end to end through
 * device-verify itself:
 *   NEGATIVE — an endpoint connected on the DEFAULT server is absent from the isolated run's
 *              device list, and the isolated run does not describe it as the phone.
 *   POSITIVE — the isolated run still performs real discovery and still reports an endpoint it
 *              finds, so isolation has not simply blinded it.
 *
 * It does NOT prove an isolated run can complete an adb handshake with a real adbd. That needs a
 * genuine adbd, and there is none here: no handset (Wireless debugging is off) and no emulator or
 * AVD installed on this machine. Stated rather than papered over — the positive case below is
 * "discovery still works", not "a device still attaches".
 *
 * Run: npm run adb-isolation
 */
import { createServer } from 'node:net';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const ADB = ['/opt/homebrew/bin/adb',
             '/opt/homebrew/share/android-commandlinetools/platform-tools/adb', 'adb']
  .find((p) => p === 'adb' || existsSync(p));
const ISOLATED_PORT = 5041;          // this suite's own, distinct from device-verify's default
const run = (args, opts = {}) => spawnSync(ADB, args,
  { encoding: 'utf8', timeout: opts.timeout || 60000 });

if (!ADB) { console.log('skip: adb not found'); process.exit(0); }

/* Everything this suite starts, it stops — including on the failure paths. */
const cleanup = [];
const finish = (code) => {
  for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length || code) process.exit(1);
  console.log('ALL PASS');
  process.exit(0);
};
process.on('uncaughtException', (e) => { console.error(e); finish(1); });

console.log('adb server isolation — a stranger must not become "the phone"\n');

/* ---- a stub, registered on the DEFAULT adb server ------------------------------------------- */
const srv = createServer(() => {});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const stub = `127.0.0.1:${srv.address().port}`;
cleanup.push(() => srv.close());
console.log(`  stub listening on ${stub}`);

/* Did the DEFAULT server already exist?
 *
 * This suite needs one in order to register a stranger on it, but whether it may KILL one
 * afterwards depends on who started it. Leaving a server behind breaks the standing rule that no
 * run leaves adb running; killing a server this suite did not start would take down whatever else
 * on the machine is using it — the very reaching-across this isolation exists to prevent. So:
 * remember which case it was.
 *
 * Caught by the full-suite run, which reports stray listeners and found this suite's own leftover
 * on :5037. A suite about adb hygiene leaking an adb server is not a detail. */
const defaultWasRunning = (spawnSync('lsof', ['-nP', '-iTCP:5037', '-sTCP:LISTEN'],
  { encoding: 'utf8' }).stdout || '').includes('LISTEN');
run(['start-server']);
cleanup.push(() => {
  try { execFileSync(ADB, ['disconnect', stub], { stdio: 'ignore' }); } catch {}
  if (!defaultWasRunning) {
    try { execFileSync(ADB, ['kill-server'], { stdio: 'ignore' }); } catch {}
  }
});
run(['connect', stub]);
const defaultList = run(['devices', '-l']).stdout || '';
ok('the stub IS present on the default adb server', defaultList.includes(stub),
  `default server list:\n       ${defaultList.trim().replace(/\n/g, '\n       ')}\n`
  + '       if adb refused to register it, the isolation claim below would be vacuous');

/* ---- the same moment, seen from an ISOLATED server ------------------------------------------ */
run(['-P', String(ISOLATED_PORT), 'start-server']);
cleanup.push(() => { try {
  execFileSync(ADB, ['-P', String(ISOLATED_PORT), 'kill-server'], { stdio: 'ignore' });
} catch {} });
const isolatedList = run(['-P', String(ISOLATED_PORT), 'devices', '-l']).stdout || '';
ok('the stub is ABSENT from the isolated server', !isolatedList.includes(stub),
  `isolated server list:\n       ${isolatedList.trim().replace(/\n/g, '\n       ')}`);
ok('the isolated server has no devices at all', !/\n\S+\s+(device|offline|unauthorized)/.test(isolatedList),
  isolatedList.trim());

/* ---- NEGATIVE, end to end: point device-verify at an EMPTY host ------------------------------
 * 127.0.0.2 is loopback but nothing on this Mac binds it (it is not even bindable here without an
 * alias), and a sweep of it comes back empty in ~20s. That makes the negative unambiguous: the
 * ONLY way a device could appear in this run's list is if it leaked in from the default server.
 *
 * Pointing it at 127.0.0.1 instead would have muddied exactly this — the run legitimately finds
 * a dozen local services there and reports them, which is a different (already-fixed) concern and
 * would have made this assertion about the wrong thing. */
console.log('\n  [negative] device-verify on the isolated server, scanning an EMPTY host…');
const neg = spawnSync('npm',
  ['run', '-s', 'device-verify', '--', '--host', '127.0.0.2', '--wait', '25',
   '--scan-every', '0', '--adb-port', String(ISOLATED_PORT)],
  { encoding: 'utf8', timeout: 900000 });
const negOut = `${neg.stdout || ''}${neg.stderr || ''}`;

ok('the isolated run never mentioned the stub', !negOut.includes(stub),
  negOut.split('\n').filter((l) => l.includes(stub)).join('\n       '));
/* The precise regression: a loopback endpoint named as a device that is OFFLINE, which is what
 * produced "toggle Wireless debugging" advice about somebody else's socket. */
ok('the isolated run reported NO device of any state', !/is OFFLINE after|device authorised — device/.test(negOut),
  negOut.split('\n').filter((l) => /OFFLINE|device /.test(l)).slice(0, 3).join('\n       '));
ok('the isolated run swept the host it was given', /\[discover\] scanned 127\.0\.0\.2/.test(negOut),
  'no sweep happened, so the clean result above proves nothing');
ok('it reported the empty host as empty', /nothing open on 127\.0\.0\.2/.test(negOut),
  negOut.split('\n').filter((l) => /discover/.test(l)).join('\n       '));

/* ---- POSITIVE: isolation has not blinded discovery ------------------------------------------
 * Same isolated server, pointed at loopback where real listeners exist. It must still sweep, still
 * find an endpoint, and — because none of those listeners is adbd — still say so rather than
 * advising a toggle. The wait is long enough for the full walk to finish; a short one cuts the
 * walk off mid-way and the run reports OFFLINE without the explanation, which is how the first
 * draft of this suite ended up asserting the wrong thing. */
console.log('  [positive] same isolated server, scanning a host that DOES have listeners…');
const pos = spawnSync('npm',
  ['run', '-s', 'device-verify', '--', '--host', '127.0.0.1', '--wait', '260',
   '--scan-every', '0', '--adb-port', String(ISOLATED_PORT)],
  { encoding: 'utf8', timeout: 900000 });
const posOut = `${pos.stdout || ''}${pos.stderr || ''}`;

ok('the isolated run still performed a real sweep', /\[discover\] scanned 127\.0\.0\.1/.test(posOut),
  'isolation blinded discovery');
ok('the isolated run still DISCOVERED an endpoint',
  /endpoint discovered — 127\.0\.0\.1:\d+ \(via scan\)/.test(posOut),
  posOut.split('\n').filter((l) => /discover|endpoint/.test(l)).join('\n       '));
ok('the positive run ALSO never mentioned the stub', !posOut.includes(stub),
  'the stub leaked into a run that was busy finding other things — the harder case');
/* The INVARIANT, not a wall-clock assumption.
 *
 * This first read "the explanation must be present", which passed alone and failed inside the
 * full suite: on a busy machine the 13-port walk does not finish inside the wait, so the
 * explanation never prints. The claim was silently coupled to how fast the host happened to be,
 * which is how a suite earns a reputation for being flaky and then gets ignored.
 *
 * What must ALWAYS hold is narrower and stronger: the run may or may not get far enough to
 * report an OFFLINE endpoint, but if it does, it must never leave that report unexplained —
 * "toggle Wireless debugging" about a socket that was never adbd is the wrong instruction. */
const reportedOffline = /is OFFLINE after/.test(posOut);
ok(reportedOffline
     ? 'an OFFLINE report carries the handshake explanation'
     : 'no OFFLINE was reported (the walk did not get that far) — nothing to explain',
  !reportedOffline || /NONE completed an adb handshake/.test(posOut),
  'the run reported a device as OFFLINE and advised toggling Wireless debugging without saying '
  + 'that nothing it tried was actually adbd');

/* ---- the default server is left exactly as we found it -------------------------------------- */
const afterList = run(['devices', '-l']).stdout || '';
ok('the isolated run did not disturb the default server',
  afterList.includes(stub),
  'the stub vanished from the default server — an isolated run must not reach across and '
  + 'disconnect endpoints it does not own');

finish(0);
