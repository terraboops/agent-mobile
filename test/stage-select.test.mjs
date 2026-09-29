/**
 * stage-select.test — running part of the device pass, and refusing to guess.
 *
 * The pass is about ten minutes with the phone in hand, and the install is the slowest part of
 * it. A failure in the mute phase should not cost another install to look at again.
 *
 * The assertion that matters most here is the REFUSAL. A selector that ignores a misspelled
 * phase and runs everything hands the operator the ten minutes they were trying to avoid, and a
 * report that looks exactly like the one they asked for.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePhaseSelector, runsPhase, describeSelection, PHASES, PHASE_NAMES }
  from './lib/stage-select.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nstage-select — part of the pass, or all of it\n');

/* ---- the default is unchanged ------------------------------------------------------------- */
const all = parsePhaseSelector({});
ok('no flags runs every phase', all.kind === 'all' && all.run.size === PHASE_NAMES.length,
  describeSelection(all));
ok('no flags reports as "all phases", not as a partial pass',
  describeSelection(all) === 'all phases', describeSelection(all));
for (const n of PHASE_NAMES) ok(`default includes ${n}`, runsPhase(all, n));

/* ---- --from starts at a phase and keeps going --------------------------------------------- */
const fromMute = parsePhaseSelector({ from: 'mute' });
ok('--from mute runs mute', runsPhase(fromMute, 'mute'));
ok('--from mute runs what comes AFTER it', runsPhase(fromMute, 'stop'));
ok('--from mute skips the install', !runsPhase(fromMute, 'install'),
  'skipping the install is the whole point — it is the slowest phase');
ok('--from mute skips everything before it',
  !runsPhase(fromMute, 'launch') && !runsPhase(fromMute, 'handshake')
  && !runsPhase(fromMute, 'surface') && !runsPhase(fromMute, 'speak'));
ok('--from still runs discovery, which every later phase needs',
  runsPhase(fromMute, 'discover'),
  'without a serial there is nothing to resume onto, so this would fail confusingly');
ok('--from the FIRST phase is the same set as no flags',
  parsePhaseSelector({ from: PHASE_NAMES[0] }).run.size === PHASE_NAMES.length);
ok('--from the LAST phase runs only it and discovery',
  (() => { const s = parsePhaseSelector({ from: PHASE_NAMES.at(-1) });
           return s.run.size === 2 && runsPhase(s, 'discover'); })());

/* ---- --only is a set ----------------------------------------------------------------------- */
const onlyMute = parsePhaseSelector({ only: 'mute' });
ok('--only mute runs mute', runsPhase(onlyMute, 'mute'));
ok('--only mute does NOT run what comes after', !runsPhase(onlyMute, 'stop'),
  'that is the difference from --from, and it is why both exist');
ok('--only takes a list', (() => { const s = parsePhaseSelector({ only: 'launch,mute' });
  return runsPhase(s, 'launch') && runsPhase(s, 'mute') && !runsPhase(s, 'stop'); })());
ok('--only tolerates spaces in the list',
  runsPhase(parsePhaseSelector({ only: 'launch, mute' }), 'mute'));
ok('--only still runs discovery', runsPhase(onlyMute, 'discover'));

/* ---- THE REFUSAL --------------------------------------------------------------------------- */
const bad = parsePhaseSelector({ from: 'mut' });
ok('an unknown phase is an ERROR, not ignored', !!bad.error && bad.kind === 'error',
  JSON.stringify(bad));
ok('the error names the phase that was not understood', /"mut"/.test(bad.error), bad.error);
ok('the error suggests the near miss', /did you mean "mute"/.test(bad.error), bad.error);
ok('the error lists the phases that DO exist',
  PHASE_NAMES.every((n) => bad.error.includes(n)), bad.error);
/* BOTH selectors, because they refuse by different routes. `--from mut` is also caught by the
 * one-name rule further down, so checking it alone would leave the --only path untested — a
 * mutation that made unknown names fall through to "all phases" was still stopped for --from
 * and sailed through for --only. */
ok('an unknown phase runs NOTHING rather than everything',
  bad.run.size === 0 && parsePhaseSelector({ only: 'zzzzzz' }).run.size === 0
  && parsePhaseSelector({ only: 'mute,nope' }).run.size === 0,
  'falling back to a full pass would give the operator the ten minutes they were avoiding, and '
  + 'a report indistinguishable from the one they wanted');
ok('a wild name with no near miss still refuses',
  (() => { const s = parsePhaseSelector({ only: 'zzzzzz' });
           return !!s.error && !/did you mean/.test(s.error); })(),
  JSON.stringify(parsePhaseSelector({ only: 'zzzzzz' })));
ok('one bad name in a list refuses the whole list',
  !!parsePhaseSelector({ only: 'mute,nope' }).error,
  'running the half it understood would be a partial pass nobody asked for');
ok('a flag with no value is refused, not treated as all',
  !!parsePhaseSelector({ only: true }).error && !!parsePhaseSelector({ from: true }).error,
  '`--only` with nothing after it is a typo, and the ten-minute default is the wrong recovery');
ok('--only and --from together are refused',
  /cannot be combined/.test(parsePhaseSelector({ only: 'mute', from: 'mute' }).error || ''));
ok('--from with a list is refused',
  /ONE phase name/.test(parsePhaseSelector({ from: 'mute,stop' }).error || ''),
  'a starting point is not a set');

/* ---- a partial pass must SAY so ------------------------------------------------------------ */
ok('a partial selection describes itself as partial',
  /PARTIAL/.test(describeSelection(fromMute)), describeSelection(fromMute));
ok('and names what it skipped',
  /SKIPPED/.test(describeSelection(fromMute)) && /install/.test(describeSelection(fromMute)),
  describeSelection(fromMute));

/* ---- the phases must match the run that uses them ------------------------------------------
 * A phase list that drifts from device-verify's guards silently stops selecting anything. */
const dv = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');
const guarded = [...dv.matchAll(/phase\('([a-z/]+)'\)/g)].map((m) => m[1]);
ok('device-verify guards blocks with phase()', guarded.length >= 4, JSON.stringify(guarded));
ok('every phase device-verify guards on is a declared phase',
  guarded.every((g) => PHASE_NAMES.includes(g)),
  `unknown in guards: ${guarded.filter((g) => !PHASE_NAMES.includes(g)).join(', ')}`);
/* A phase marked `precondition` is guarded by the disjunction that implies it, not by a
 * `phase('x')` of its own — see the note on `speak`. Every OTHER skippable phase must have a
 * literal guard, or the flag silently does nothing. */
const mustGuard = PHASES.filter((p) => !p.always && !p.precondition);
ok('every independently skippable phase is actually guarded',
  mustGuard.every((p) => guarded.includes(p.name)),
  `declared but never guarded: ${mustGuard.filter((p) => !guarded.includes(p.name))
    .map((p) => p.name).join(', ')} — a phase nobody checks is a flag that does nothing`);
ok('a precondition phase is still SELECTABLE on its own',
  (() => { const s = parsePhaseSelector({ only: 'speak' });
           return runsPhase(s, 'speak') && !runsPhase(s, 'mute') && !runsPhase(s, 'stop'); })(),
  '--only speak should drive the turn without the taps');
ok('selecting mute implies the turn that makes it observable',
  (() => { const dv2 = dv; return /SPEAKING_PHASES\.some\(/.test(dv2); })(),
  'mute selected without the speak phase would tap a mic with nothing playing');
ok('every declared phase says what it covers',
  PHASES.every((p) => typeof p.what === 'string' && p.what.length > 10));

/* ---- END TO END: the real script, refusing and resuming ------------------------------------ */
const run = (args) => spawnSync(process.execPath,
  [join(REPO, 'test/device-verify.mjs'), '--dry', ...args],
  { encoding: 'utf8', timeout: 120000 });

const refused = run(['--from', 'mut']);
ok('e2e: an unknown phase exits non-zero', refused.status === 2,
  `exit ${refused.status} — a misspelling that still runs is the failure this guards`);
ok('e2e: the refusal is printed where it will be seen',
  /unknown phase "mut"/.test(refused.stderr + refused.stdout), refused.stderr);
ok('e2e: nothing was attempted after the refusal',
  !/VERIFIED|BLOCKED/.test(refused.stdout),
  'the run started anyway: ' + refused.stdout.slice(0, 200));

const resumed = run(['--from', 'mute']);
ok('e2e: a resumed run starts at the named phase',
  resumed.status === 0 && /SKIPPED.*install APK/.test(resumed.stdout),
  resumed.stdout.slice(-300));
ok('e2e: the skipped phase is REPORTED, not omitted',
  /\[SKIPPED \]/.test(resumed.stdout),
  'a report missing its install line and one whose install passed must not look the same');
ok('e2e: the run says it was partial', /PARTIAL PASS/.test(resumed.stdout),
  resumed.stdout.slice(-300));

const full = run([]);
ok('e2e: a full pass still says nothing about partiality',
  full.status === 0 && !/PARTIAL PASS/.test(full.stdout) && !/\[SKIPPED \]/.test(full.stdout),
  'the default behaviour changed');
ok('e2e: a full pass reports the same stages it always did',
  /APK present/.test(full.stdout) && /device authorised/.test(full.stdout),
  full.stdout.slice(0, 300));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
