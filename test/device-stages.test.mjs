/**
 * device-stages.test — the stages that have never run must not contain measurement errors.
 *
 * device-verify's later stages (install, launch, screenshot, handshake capture, mic tap) have
 * never executed a line against hardware. A dark phone hides bugs in them, and a green suite
 * says nothing about them, so they were read line by line. This pins the defects that review
 * found, so they cannot come back before the first real run gets a chance to be about the
 * PHONE rather than about the harness.
 *
 * Every assertion here fails against the pre-review code.
 *
 * Run: npm run device-stages
 */
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'device-verify.mjs'), 'utf8');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ---- DEFECT 1: byte offsets into a log that rotates at 5MB --------------------------------
 * Every log-based stage (handshake, identity, opus PT, speaking, truncation) reads the gateway
 * log from a mark taken earlier. gateway.log rotates at 5MB. A byte offset then points into a
 * file that no longer exists, slice() yields '', and all of them report "blocked" on a
 * perfectly working phone. The identical bug made e2e-interrupt report a healthy sidecar as
 * broken. Verified here by rotating a real file under the real helper. */
{
  ok('log marks are timestamps, not byte offsets',
    !/const logSize = \(\) => \{ try \{ return readFileSync\(GLOG\)\.length/.test(SRC),
    'logSize() still returns a byte length');
  /* These live in the shared helper now, so assert against ITS source, not device-verify's. */
  const LIBSRC = readFileSync(join(HERE, 'lib/gateway-log.mjs'), 'utf8');
  ok('the log reader looks at the ROTATED file too',
    /file \+ '\.1'/.test(LIBSRC), 'only gateway.log is read, so a rotation loses the line');
  /* Behavioural, not a grep: the file MENTIONS toISOString in the comment explaining why it is
   * wrong, and an assertion that forbids the word also forbids documenting the trap. Compare
   * the stamp against locally-formatted time instead — that is the property that matters. */
  {
    const { logStamp: ls } = await import('./lib/gateway-log.mjs');
    const t = Date.now();
    const d = new Date(t - 2000);
    const p2 = (n) => String(n).padStart(2, '0');
    const localHour = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const utcHour = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    ok('the timestamp is LOCAL time, matching how the log stamps its lines',
      ls(t).includes(localHour), `${ls(t)} does not contain ${localHour}`);
    if (localHour !== utcHour) {
      ok('and it is NOT UTC (which would sit hours away and match nothing)',
        !ls(t).includes(utcHour), `${ls(t)} looks like UTC`);
    }
  }

  /* Drive the REAL helpers across a rotation — imported, not reimplemented.
   * This block used to define its own logSince/stamp, so it was testing a copy: a mutation run
   * deleting the real fix left it green. Importing is the difference between checking the code
   * and checking your recollection of it. */
  const { logStamp, logSince } = await import('./lib/gateway-log.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'devstage-'));
  const log = join(dir, 'gateway.log');
  const now = () => logStamp(Date.now() + 2000);      // "now", undoing the helper's slack

  writeFileSync(log, `${now()} INFO old padding\n`.repeat(50));
  const mark = logStamp();
  writeFileSync(log, readFileSync(log, 'utf8') + `${now()} INFO [sidecar] handshake confirmed BEFORE\n`);
  renameSync(log, log + '.1');                       // the rotation
  writeFileSync(log, `${now()} INFO [sidecar] handshake confirmed AFTER\n`);

  const seen = logSince(mark, log);
  ok('rotation: a line written BEFORE the roll is still found', /BEFORE/.test(seen), seen.slice(0, 80));
  ok('rotation: a line written AFTER the roll is found', /AFTER/.test(seen), seen.slice(0, 80));

  const legacy = readFileSync(log, 'utf8').slice(4000);
  ok('rotation: a BYTE OFFSET finds neither (this is the bug)',
    !/BEFORE/.test(legacy) && !/AFTER/.test(legacy));

  ok('device-verify uses the shared helper rather than its own copy',
    /from '\.\/lib\/gateway-log\.mjs'/.test(SRC),
    'the stages still carry a private reimplementation');
}

/* ---- DEFECT 2: the mic tap and the truncation check were different controls ---------------
 * The native mic button calls AudioManager.setMicrophoneMute — it mutes the MICROPHONE and does
 * not touch the agent's reply, so it produces NO truncation. The stage tapped the mic and then
 * waited for a `cut short` line, which a healthy phone never emits: it would have reported
 * issue #1 as broken on a device where mute worked perfectly. Truncation comes from the
 * INTERRUPT that Stop sends. */
{
  const micThenCut = /tapped the native mic mid-sentence[\s\S]{0,400}?cut short after/.test(SRC);
  ok('the mic tap is no longer followed straight by a truncation check', !micThenCut,
    'tapping the mic and waiting for a cut-short measures the wrong control');
  ok('the mic tap asserts the MIC state instead',
    /dumpsys audio[\s\S]{0,300}?the device reports the mic muted/.test(SRC),
    'nothing checks that the microphone actually muted');
  ok('it states that the reply must KEEP playing when only the mic is muted',
    /reply KEPT playing/.test(SRC));
  ok('a separate Stop tap is what the truncation check follows',
    /tapped Stop mid-sentence[\s\S]{0,400}?cut short after/.test(SRC),
    'the truncation assertion is not attached to the interrupt control');
  ok('the Stop stage is named for what it proves',
    /Stop actually stopped the audio/.test(SRC));
}

/* ---- DEFECT 5: a trigger that fails while exiting 0 ---------------------------------------
 * `hermes send -t agentmob` cannot reach the platform out-of-process — it prints "No live
 * adapter for platform 'agentmob'" and EXITS 0. Checking only the status reported the stage as
 * VERIFIED for a command that did nothing; the later stages then blocked with "no reply audio"
 * and the run looked like the phone had failed. Confirmed by running it: exit 0, zero pushes. */
{
  /* These two originally asserted the INTERMEDIATE fix — inspecting `hermes send`'s output
   * instead of only its exit status. That path is gone entirely now, replaced by the AEAD
   * typed turn, so checking for its artifacts would fail forever against strictly better code.
   * Assert the property that actually matters: the dead path is not used, and a trigger
   * failure is reported from the trigger's own result. */
  ok('the dead `hermes send` path is gone, not merely guarded',
    !/\['send', '-t', 'agentmob'/.test(SRC) && !/hs2\.status/.test(SRC),
    'the shell-out survives somewhere in the file');
  ok('the trigger reports failure from its own result, not an exit code',
    /const triggerFailed = !trig\.ok/.test(SRC),
    'nothing distinguishes a trigger that silently did nothing');
  ok('a failed trigger blocks the stages that depend on it',
    /if \(triggerFailed\)[\s\S]{0,200}?no trigger, so nothing was spoken/.test(SRC),
    'the speaking and mute stages would block with a misleading reason');
  ok('the reason why hermes send cannot be used is recorded where the stage lives',
    /standalone_sender_fn/.test(SRC),
    'the next person will try it again and hit exit 0 with no explanation');

  /* The exact shape of the real failure, as observed. */
  const realFailure = "hermes send: No live adapter for platform 'agentmob'. Is the gateway "
    + 'running with this platform connected?';
  const detector = (status, out) =>
    status !== 0 || /No live adapter|must register a standalone_sender_fn|error/i.test(out);
  ok('the detector catches the REAL observed failure at exit 0',
    detector(0, realFailure) === true, 'exit 0 + that message still reads as success');
  ok('the detector does not cry wolf on a clean send',
    detector(0, 'sent to agentmob') === false);
}

/* ---- reviewed and NOT defects, recorded with the reasoning -------------------------------- */
{
  /* navPx: the extraction is a fragile shell pipeline whose regex varies by Android version.
   * It degrades to 0 rather than throwing, and 0 is SAFE: on a 2.625-density Pixel a missed
   * 24dp nav bar shifts the tap 63px = 24dp, while the mic is 72dp tall so the tap has 36dp of
   * slack from its centre. 24 < 36, so a wrong inset still lands inside the button. */
  ok('navPx failure degrades to 0 rather than throwing', /\|\| 0\)\) \|\| 0;/.test(SRC));
  ok('the tap aims at the mic CENTRE, which is what gives it the slack',
    /MIC_GAP \+ MIC_SIZE \/ 2/.test(SRC));

  /* finish(): 'blocked' does not fail the run, only 'failed' does. Deliberate — a blocked stage
   * means the environment stopped us, not that the code is wrong. */
  ok("exit status counts 'failed', not 'blocked'",
    /report\.some\(\(r\) => r\.status === 'failed'\)/.test(SRC));
}

/* ---- STAGE 1, which I had not read because I had RUN it many times --------------------- */
{
  ok('the tailscale binary is resolved, not hard-coded',
    /AGENTMOB_TAILSCALE/.test(SRC) && /opt\/homebrew\/bin\/tailscale/.test(SRC),
    'a single absolute path means ENOENT elsewhere, swallowed by the try, and the '
    + '"off the network" vs "port shut" distinction silently disappears');
  ok('a missing tailscale binary is announced, not swallowed',
    /no tailscale binary found/.test(SRC),
    'the probe would degrade to a correct-but-useless message with nothing saying why');
  ok('a failed screenshot records WHY',
    /lastShotError = \(r\.stderr/.test(SRC),
    'a bare return false made a permission prompt and a dead device look identical '
    + '(checking the ASSIGNMENT, not just that the name appears — a declaration alone proves '
    + 'nothing)');
}

/* ---- local checks must not sit behind the device gate --------------------------------------
 * APK presence and freshness need no handset, but they lived AFTER the wait loop — which
 * finish()es at "no device" — so they never ran at all. A stale bundle was therefore only
 * discoverable once a phone was connected, i.e. during the one scarce resource this harness
 * spends its life waiting for. Every blocked run reported "0 verified" while three local facts
 * were sitting there unchecked.
 *
 * Pinned by POSITION, because the fix is an ordering one and ordering is what regresses. */
{
  const dv = readFileSync(join(HERE, 'device-verify.mjs'), 'utf8');
  const preflight = dv.indexOf('localApkPreflight()');
  const gate = dv.indexOf('---- 1. reach a device');
  ok('device-verify runs a local preflight', preflight > 0,
    'nothing calls localApkPreflight; a blocked run establishes nothing');
  ok('the local preflight runs BEFORE the device gate', preflight > 0 && preflight < gate,
    `preflight at ${preflight}, device gate at ${gate} — behind the gate it never executes, `
    + 'because a run with no device finishes first');

  /* The wait must actually bound the run. `--wait 5` printed "waiting up to 5s" and then sat for
   * 144s completing a port sweep, because the while() condition is only checked BETWEEN
   * iterations. scanPorts honours an AbortSignal; nothing was passing one. */
  ok('the port sweep is bounded by the run deadline', /signal:\s*deadlineSignal\(\)/.test(dv),
    'scanPorts is called without a signal, so one discovery pass can outlast --wait entirely — '
    + 'a bounded wait that is not bounded makes a healthy run look hung');
  ok('the mDNS lookup is bounded too', /Math\.min\(20000, remaining\(\)\)/.test(dv),
    'a 20s mdns timeout can outlast a short --wait on its own');
}

/* ---- the acceptance list must account for every stage --------------------------------------
 * The danger with a device leg that has never run is not a failing stage. It is a stage quietly
 * ceasing to be counted as unproven — someone reads 900+ green assertions, assumes the phone is
 * covered, and ships. None of those assertions has touched a handset.
 *
 * test/lib/device-acceptance.mjs is the written record of what the device still has to prove.
 * These checks keep it honest: every stage device-verify can report must be accounted for there,
 * and every entry must say what the host DID prove, so "unproven on device" is never mistaken
 * for "nothing is known". */
{
  const { DEVICE_ACCEPTANCE, coveredStages, BLOCKER } = await import('./lib/device-acceptance.mjs');
  const dv = readFileSync(join(HERE, 'device-verify.mjs'), 'utf8');
  /* Stage names as device-verify actually emits them.
   *
   * TWO sources, which this check originally got wrong. Most stages are string literals at the
   * stage() call site, but the local preflight loops over entries from apk-facts.mjs —
   * `for (const p of localApkPreflight()) stage(p.name, ...)` — so those names never appear in
   * device-verify at all. Scanning only the call sites reported them as stages the list had
   * invented, when in fact they are stages the extraction could not see. A gate that models
   * "what exists" has to cover every place the names come from. */
  const emitted = [...dv.matchAll(/stage\(\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'"));
  const factsSrc = readFileSync(join(HERE, 'lib', 'apk-facts.mjs'), 'utf8');
  const fromFacts = [...factsSrc.matchAll(/name:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'"));
  const unique = [...new Set([...emitted, ...fromFacts])];
  ok('device-verify emits stages to check', unique.length > 10, `${unique.length} stage names`);

  const covered = coveredStages();
  const unaccounted = unique.filter((n) => !covered.has(n));
  ok('every device-verify stage is accounted for in the acceptance list',
    unaccounted.length === 0,
    `not listed: ${unaccounted.join(' | ')}\n`
    + '       add it to the matching entry in test/lib/device-acceptance.mjs, or add an entry. '
    + 'A stage nobody has classified is a stage somebody will assume is covered.');

  /* And the reverse: a listed stage that no longer exists means the list has gone stale. */
  const ghosts = [...covered].filter((n) => !unique.includes(n));
  ok('the acceptance list names no stage that device-verify has dropped', ghosts.length === 0,
    `stale entries: ${ghosts.join(' | ')}`);

  for (const a of DEVICE_ACCEPTANCE) {
    ok(`acceptance '${a.id}' states why the host cannot settle it`,
      typeof a.whyDeviceOnly === 'string' && a.whyDeviceOnly.length > 60, a.whyDeviceOnly);
    ok(`acceptance '${a.id}' names what WAS proved on the host`,
      typeof a.hostProof === 'string' && a.hostProof.length > 0,
      'say NONE explicitly rather than leaving it blank — blank reads as an oversight');
  }
  /* The mic toggle is issue #1 and the one most likely to be assumed done, so it is pinned by
   * name rather than left to the generic checks. */
  const mic = DEVICE_ACCEPTANCE.find((a) => a.id === 'native-mic-toggle');
  ok('the native mic toggle (issue #1) is listed first and still unproven',
    !!mic && DEVICE_ACCEPTANCE[0].id === 'native-mic-toggle' && mic.issue === 1);
  ok('the blocker is stated once, in one place', BLOCKER.includes('Wireless debugging'));
  console.log(`  acceptance: ${DEVICE_ACCEPTANCE.length} items still unproven without the handset, `
    + `covering ${covered.size} device-verify stages`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
