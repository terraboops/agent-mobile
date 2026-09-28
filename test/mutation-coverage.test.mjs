/**
 * mutation-coverage.test — a new suite must not arrive un-mutated.
 *
 * The mutation table is a hand-maintained list, and nothing checked it. Two entries had already
 * gone stale and four targeted the wrong feature before anyone noticed, and adding a suite
 * without an entry silently reduced coverage — the table stayed green while covering less. That
 * is exactly how coverage rots: not by failing, but by quietly measuring less than you think.
 *
 * So every npm script must be classified, and the classification is forced:
 *
 *   a SUITE     -> must have a mutation-table entry
 *   a UTILITY   -> must be listed below, by name, with a reason
 *
 * A new script is in neither list, so it fails until someone decides which it is. That is the
 * point: the gate is the decision, not the convention.
 *
 * Run: npm run mutation-coverage
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './lib/mutants.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts || {};

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

/**
 * Scripts that are NOT test suites. Each needs a reason, because "it is not a suite" is a
 * judgement and an unexplained one is indistinguishable from an oversight.
 */
const UTILITIES = {
  gateway: 'runs the dev gateway; not a test',
  'device-watch': 'a long-running watcher that waits for a phone to connect',
  'device-verify': 'the on-device run; blocked on hardware and asserts nothing without it',
  'ctrlbar-shot': 'renders screenshots for a human to look at; makes no assertions',
  'ice-candidates': 'a reachability report; exits 0 by design whatever it finds',
  'vendor-refresh': 'copies the installed plugin into vendor/; one-way, no assertions',
  mutation: 'the mutation harness itself',
  'mutation-coverage': 'this gate itself; mutating it would only test the test',
};

const covered = new Set(MUTANTS.map((m) => m.suite));
const all = Object.keys(scripts);

ok('the mutation table loaded', MUTANTS.length > 0, `${MUTANTS.length} entries`);

/* ---- 1. every script is classified ------------------------------------------------------- */
const unclassified = all.filter((s) => !covered.has(s) && !(s in UTILITIES));
ok('every npm script is either mutation-covered or a declared utility',
  unclassified.length === 0,
  unclassified.length
    ? `un-mutated suite(s): ${unclassified.join(', ')}\n`
      + `       add a mutation-table entry in test/lib/mutants.mjs, or declare it a utility `
      + `with a reason in UTILITIES here. A suite with no entry is a suite nobody has proved `
      + `tests anything.`
    : '');

/* ---- 2. the table has no entries for scripts that no longer exist ------------------------ */
const orphaned = [...covered].filter((s) => !(s in scripts));
ok('the table has no entries for scripts that no longer exist', orphaned.length === 0,
  `orphaned: ${orphaned.join(', ')}`);

/* ---- 3. a script cannot be both ----------------------------------------------------------- */
const both = all.filter((s) => covered.has(s) && s in UTILITIES);
ok('nothing is declared a utility AND mutation-covered', both.length === 0,
  `${both.join(', ')} — a utility with a mutation entry means one of the two is wrong`);

/* ---- 4. utility declarations stay honest -------------------------------------------------- */
const staleUtils = Object.keys(UTILITIES).filter((s) => !(s in scripts));
ok('every declared utility still exists as a script', staleUtils.length === 0,
  `stale: ${staleUtils.join(', ')}`);
for (const [name, reason] of Object.entries(UTILITIES)) {
  if (!(name in scripts)) continue;
  ok(`utility '${name}' has a reason`, typeof reason === 'string' && reason.length > 15, reason);
}

/* ---- 5. table entries are well-formed ----------------------------------------------------- */
const malformed = MUTANTS.filter((m) => !m.suite || !m.file || !m.from || m.to === undefined || !m.why);
ok('every table entry names a suite, file, mutation and reason', malformed.length === 0,
  malformed.map((m) => m.suite || '(unnamed)').join(', '));

const dupes = [...covered].filter((s) => MUTANTS.filter((m) => m.suite === s).length > 1);
ok('no suite is listed twice', dupes.length === 0, dupes.join(', '));

/* ---- 6. the numbers, stated ---------------------------------------------------------------- */
const suites = all.filter((s) => !(s in UTILITIES));
ok('the covered count matches the suite count', covered.size === suites.length,
  `${covered.size} covered vs ${suites.length} suites`);

console.log(`\n  ${all.length} scripts = ${suites.length} suites (all mutation-covered) `
  + `+ ${Object.keys(UTILITIES).filter((u) => u in scripts).length} declared utilities`);
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
