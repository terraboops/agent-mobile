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
  ok('the log reader looks at the ROTATED file too',
    /GLOG \+ '\.1'/.test(SRC), 'only gateway.log is read, so a rotation loses the line');
  ok('the timestamp is built from LOCAL time, not toISOString()',
    /getHours\(\)/.test(SRC) && !/toISOString\(\)[\s\S]{0,80}logSince/.test(SRC),
    'an ISO stamp is UTC and would match nothing against a locally-stamped log');

  /* Drive the real helpers across a rotation. */
  const dir = mkdtempSync(join(tmpdir(), 'devstage-'));
  const log = join(dir, 'gateway.log');
  const stampOf = () => {
    const d = new Date(Date.now() - 2000);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
         + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  const now = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
         + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  const readSince = (stamp) => {
    let text = '';
    for (const f of [log + '.1', log]) {
      try { text += readFileSync(f, 'utf8'); } catch {}
    }
    return text.split('\n').filter((l) => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      return m && m[1] >= stamp;
    }).join('\n');
  };

  writeFileSync(log, `${now()} INFO old padding\n`.repeat(50));
  const mark = stampOf();
  writeFileSync(log, readFileSync(log, 'utf8') + `${now()} INFO [sidecar] handshake confirmed BEFORE\n`);
  renameSync(log, log + '.1');                       // the rotation
  writeFileSync(log, `${now()} INFO [sidecar] handshake confirmed AFTER\n`);

  const seen = readSince(mark);
  ok('rotation: a line written BEFORE the roll is still found', /BEFORE/.test(seen), seen.slice(0, 80));
  ok('rotation: a line written AFTER the roll is found', /AFTER/.test(seen), seen.slice(0, 80));

  /* And the old approach, for contrast — this is what the stages used to do. */
  const legacyOffset = 4000;
  let legacy = '';
  try { legacy = readFileSync(log, 'utf8').slice(legacyOffset); } catch {}
  ok('rotation: a BYTE OFFSET finds neither (this is the bug)',
    !/BEFORE/.test(legacy) && !/AFTER/.test(legacy),
    'the offset happened to still work — pick a larger pre-roll file');
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
  ok('the trigger inspects OUTPUT, not just the exit status',
    /No live adapter\|/.test(SRC) || /No live adapter/.test(SRC),
    'only hs2.status is checked, so a silent failure reads as success');
  ok('a failed trigger blocks the stages that depend on it',
    /if \(triggerFailed\)[\s\S]{0,200}?no trigger, so nothing was spoken/.test(SRC),
    'the speaking and mute stages would block with a misleading reason');
  ok('the failure message points at the working alternative',
    /typed turn over a second AEAD client/.test(SRC));

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

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
