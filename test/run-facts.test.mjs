/**
 * run-facts.test — the three ways a device pass wastes ten minutes or misleads afterwards.
 *
 * None of this is evidence about the phone. All of it is about the run being worth doing, and
 * each failure points the same wrong way: it looks like a device fault, and the phone gets
 * blamed for the harness.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { triggerAdequacy, invitesLongReply, validatePng, validateReport, reportKind,
         NEEDED_SPEECH_S, STATUSES, DEVICE_GATE } from './lib/run-facts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nrun-facts — the trigger, the screenshot, and the report\n');

/* ---- 1. the trigger phrase ------------------------------------------------------------------ */
const dv = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');
const shipped = (dv.match(/flag\('--say',\s*'([\s\S]*?)'\)\)/) || [])[1]
  || (dv.match(/flag\('--say',\s*'([^']*)'/) || [])[1];
ok('the shipped trigger phrase was found in device-verify', !!shipped && shipped.length > 20,
  `got ${JSON.stringify(String(shipped).slice(0, 60))} — if this stops matching, the check below `
  + 'silently stops checking the real default');
const trig = triggerAdequacy(String(shipped).replace(/'\s*\+\s*'/g, ''));
ok('the shipped trigger speaks long enough for the taps to land', trig.adequate,
  `${trig.why}`);
ok('the shipped trigger forces a LONG reply, not a one-word answer',
  invitesLongReply(String(shipped).replace(/'\s*\+\s*'/g, '')),
  'the agent could answer "ok" and the mute phase would have nothing playing to interrupt');

/* both directions */
ok('a short phrase is rejected', !triggerAdequacy('Hi.').adequate,
  JSON.stringify(triggerAdequacy('Hi.')));
ok('and the rejection explains what would happen',
  /blocked/.test(triggerAdequacy('Hi.').why) && /mic is tapped/.test(triggerAdequacy('Hi.').why),
  triggerAdequacy('Hi.').why);
ok('an empty trigger is rejected, not treated as zero-length-but-fine',
  !triggerAdequacy('').adequate && !triggerAdequacy(null).adequate
  && /empty/.test(triggerAdequacy('').why));
ok('a phrase exactly at the threshold is accepted',
  triggerAdequacy('x'.repeat(NEEDED_SPEECH_S * 15)).adequate,
  'an off-by-one here rejects a phrase that would have worked');
ok('a phrase one character under is rejected',
  !triggerAdequacy('x'.repeat(NEEDED_SPEECH_S * 15 - 1)).adequate);
ok('a long but ONE-WORD-ANSWERABLE phrase is not mistaken for a good one',
  !invitesLongReply('What is the capital city of the country that borders Spain to the west?'),
  'length is not the only thing that matters — the reply has to be long, not the prompt');
ok('a counting phrase is recognised however it is worded',
  invitesLongReply('Please count from one to twenty slowly')
  && invitesLongReply('Repeat after me: alpha bravo charlie'));

/* ---- 2. the screenshot ---------------------------------------------------------------------- */
const png = (w, h, pixels) => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([len, body, Buffer.alloc(4)]);   // CRC not checked by the validator
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                                // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const W = 1080, H = 2400;
const blank = png(W, H, Buffer.alloc(W * H * 3));                       // all black
const busy = png(W, H, Buffer.from(Array.from({ length: W * H * 3 },
  () => Math.floor(Math.random() * 256))));                             // noise ~ a real screen

ok('a real-looking capture validates', validatePng(busy).ok, JSON.stringify(validatePng(busy)));
ok('and reports the dimensions it read',
  validatePng(busy).width === W && validatePng(busy).height === H);
ok('a BLANK frame is rejected', !validatePng(blank).ok,
  'a well-formed PNG of a black screen is exactly what a sleeping phone returns, and it was '
  + 'being written and reported as verified');
ok('the blank rejection says why', /blank frame|screen was off/.test(validatePng(blank).reason || ''),
  validatePng(blank).reason);
ok('something that is not a PNG is rejected',
  !validatePng(Buffer.from('error: device offline\n'.repeat(20))).ok
  && /signature/.test(validatePng(Buffer.from('error: device offline\n'.repeat(20))).reason));
ok('an empty buffer is rejected', !validatePng(Buffer.alloc(0)).ok && !validatePng(null).ok);
ok('a TRUNCATED capture is rejected',
  !validatePng(busy.subarray(0, Math.floor(busy.length / 2))).ok,
  'exec-out over a flaky link cuts the stream mid-chunk and the header still looks fine');
ok('the truncation rejection names IEND',
  /IEND|truncated/.test(validatePng(busy.subarray(0, Math.floor(busy.length / 2))).reason || ''),
  validatePng(busy.subarray(0, Math.floor(busy.length / 2))).reason);
ok('a thumbnail-sized image is rejected as not a screencap',
  !validatePng(png(64, 64, Buffer.alloc(64 * 64 * 3))).ok
  && /smaller than a phone screen/.test(validatePng(png(64, 64, Buffer.alloc(64 * 64 * 3))).reason));
ok('device-verify actually validates what screencap returned',
  /validatePng\(r\.stdout\)/.test(dv),
  'shot() writes whatever came back and returns true');
ok('and still WRITES a bad frame rather than discarding the evidence',
  /writeFileSync\(join\(OUT, name\), r\.stdout\);\s*\n\s*if \(!png\.ok\)/.test(dv),
  'a black screenshot is worth keeping — it is the evidence that it was black');

/* ---- 3. the report --------------------------------------------------------------------------- */
const good = { generated: new Date().toISOString(), dryRun: false,
               report: [{ name: 'a', status: 'verified', detail: 'x' },
                        { name: 'b', status: 'skipped', detail: '' }] };
ok('a well-formed report validates', validateReport(good).ok, JSON.stringify(validateReport(good)));
ok('every status device-verify emits is accepted',
  STATUSES.every((st) => validateReport({ ...good,
    report: [{ name: 'a', status: st }] }).ok),
  'a status the run emits but the validator rejects would fail every real report');
ok('a missing timestamp is caught',
  !validateReport({ ...good, generated: undefined }).ok);
ok('an unparseable timestamp is caught',
  !validateReport({ ...good, generated: 'whenever' }).ok,
  'a report with no time on it cannot be told from last week\'s');
ok('a missing dryRun flag is caught',
  !validateReport({ ...good, dryRun: undefined }).ok,
  'a dry run and a device run must never be indistinguishable in the file');
ok('an unknown status is caught',
  !validateReport({ ...good, report: [{ name: 'a', status: 'probably' }] }).ok);
ok('a nameless entry is caught',
  !validateReport({ ...good, report: [{ name: '', status: 'verified' }] }).ok);
ok('a REPEATED stage name is caught',
  !validateReport({ ...good, report: [{ name: 'a', status: 'verified' },
                                      { name: 'a', status: 'failed' }] }).ok,
  'two rows with one name means the later verdict silently replaces the earlier when anyone '
  + 'reads the file by name');
ok('a non-object report is caught', !validateReport(null).ok && !validateReport('x').ok);
ok('a report whose entries are not objects is caught',
  !validateReport({ ...good, report: ['a', 'b'] }).ok);

/* and the distinction that matters most in the file.
 *
 * NOT-REACHED is the common case and the one this got wrong. A real cold run — the first ever
 * driven end to end rather than with --dry — produced four host-side preflight stages verified,
 * the device gate blocked, and NO skipped rows. The first version defined "full" as "no skipped
 * rows", so the file classified itself `full: 5 stage(s) attempted` for a run that never
 * touched the phone. That is the file someone quotes tomorrow. */
const reached = (rows) => ({ generated: new Date().toISOString(), dryRun: false, report: rows });
const COLD = reached([{ name: 'APK present', status: 'verified' },
                      { name: DEVICE_GATE, status: 'blocked',
                        detail: 'no device after 111s: Wireless debugging is OFF' }]);
ok('a run that never reached the phone does NOT read as full',
  reportKind(COLD).kind === 'not-reached', JSON.stringify(reportKind(COLD)));
ok('and it says the stages present were host-side preflight',
  /preflight/.test(reportKind(COLD).note), reportKind(COLD).note);
ok('a report with NO device gate at all is not-reached, not full',
  reportKind(reached([{ name: 'APK present', status: 'verified' }])).kind === 'not-reached',
  'a run that never even attempted the gate has no evidence the phone exists');
ok('a FAILED gate is not-reached either',
  reportKind(reached([{ name: DEVICE_GATE, status: 'failed' }])).kind === 'not-reached');
ok('the real cold report on disk classifies as not-reached',
  (() => { try {
    const disk = JSON.parse(readFileSync(join(REPO, 'test/audit/out/device/device-verify.json'), 'utf8'));
    return disk.dryRun || reportKind(disk).kind !== 'full'
        || disk.report.some((r) => r.name === DEVICE_GATE && r.status === 'verified');
  } catch { return true; } })(),
  'a report on disk claims a full pass without a verified device gate');

ok('a full pass reads as full',
  reportKind(reached([{ name: DEVICE_GATE, status: 'verified' },
                      { name: 'app launched', status: 'verified' }])).kind === 'full');
ok('a pass that REACHED the phone but skipped phases reads as partial',
  reportKind(reached([{ name: DEVICE_GATE, status: 'verified' },
                      { name: 'app launched', status: 'skipped' }])).kind === 'partial',
  'reaching the device is necessary for partial to be the right word — without it the run is '
  + 'not a smaller version of a pass, it is not a pass');
ok('the partial note names what was never attempted',
  /app launched/.test(reportKind(reached([{ name: DEVICE_GATE, status: 'verified' },
    { name: 'app launched', status: 'skipped' }])).note));
ok('the DEVICE_GATE name matches what device-verify actually emits',
  new RegExp(`stage\\('${DEVICE_GATE}'`).test(dv),
  `device-verify no longer emits a stage called "${DEVICE_GATE}", so every not-reached verdict `
  + 'silently becomes "full" again');
ok('a dry run reads as a dry run whatever it contains',
  reportKind({ ...good, dryRun: true, report: [{ name: 'a', status: 'verified' }] }).kind
  === 'dry-run',
  'a dry run with verified stages must not read as a device pass');
ok('an empty report is not a pass', reportKind({ dryRun: false, report: [] }).kind === 'empty');
ok('device-verify validates its own report as it writes it',
  /validateReport\(doc\)/.test(dv) && /REPORT IS MALFORMED/.test(dv));
ok('device-verify says when the file is not a device verification',
  /NOT A DEVICE VERIFICATION/.test(dv),
  'the file outlives the terminal, so the caveat has to be in it');

/* ---- the real report on disk, if one exists ------------------------------------------------- */
{
  let disk = null;
  try { disk = JSON.parse(readFileSync(join(REPO, 'test/audit/out/device/device-verify.json'), 'utf8')); }
  catch { /* no run yet */ }
  if (disk) {
    const v = validateReport(disk);
    ok('the report last written to disk is well-formed', v.ok, v.problems.join('; '));
    ok('and its kind is stated rather than assumed',
      ['full', 'partial', 'not-reached', 'dry-run', 'empty'].includes(reportKind(disk).kind),
      JSON.stringify(reportKind(disk)));
  } else {
    ok('no report on disk yet, nothing to validate', true);
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
