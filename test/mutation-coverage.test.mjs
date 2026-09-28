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
import { codeOnly, langOf } from './lib/code-only.mjs';
import { existsSync } from 'node:fs';

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
  'device-arm': 'device-verify with a long unattended wait; same code, no assertions of its own',
  'ctrlbar-shot': 'renders screenshots for a human to look at; makes no assertions',
  'ice-candidates': 'a reachability report; exits 0 by design whatever it finds',
  'vendor-refresh': 'copies the installed plugin into vendor/; one-way, no assertions',
  mutation: 'the mutation harness itself',
  suite: 'the suite runner; it executes the others and asserts nothing of its own',
  'mutation-coverage': 'this gate itself; mutating it would only test the test',
};

/* An entry may carry several edits (defence in depth needs them — see mutants.mjs). Normalise
 * once so every check below reads one shape. */
const editsOf = (m) => (Array.isArray(m.edits) && m.edits.length ? m.edits
                                                                 : [{ file: m.file, from: m.from, to: m.to }]);
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
const malformed = MUTANTS.filter((m) => !m.suite || !m.why
  || editsOf(m).some((e) => !e.file || !e.from || e.to === undefined));
ok('every table entry names a suite, file, mutation and reason', malformed.length === 0,
  malformed.map((m) => m.suite || '(unnamed)').join(', '));

/* A suite MAY have several entries, and forbidding that was a real ceiling on what this table
 * means.
 *
 * The rule used to be "no suite is listed twice". With one entry per suite, a full green run
 * proves each suite is not ENTIRELY scaffolding — and nothing more. Measured: 564 assertions sit
 * behind a single entry each; adb-discover has 56 behind one, surface-live 42. Those other 41
 * assertions could all be vacuous and the table would still read 51/51.
 *
 * What must stay unique is the MUTATION, not the suite: two entries that make the same edit are
 * one entry with extra steps, and would inflate the count without testing anything new. */
const seen = new Map();
const sameEdit = [];
for (const m of MUTANTS) {
  const key = editsOf(m).map((e) => `${e.file}::${e.from}::${e.to}`).sort().join('||');
  if (seen.has(key)) sameEdit.push(`${seen.get(key)} & ${m.suite}`); else seen.set(key, m.suite);
}
ok('no two entries make the identical edit', sameEdit.length === 0, sameEdit.join(', '));

/* Within ONE suite, two entries must target different code, or the second proves nothing the
 * first did not. */
const perSuite = {};
for (const m of MUTANTS) (perSuite[m.suite] = perSuite[m.suite] || []).push(m);
const samePlace = Object.entries(perSuite)
  .filter(([, ms]) => ms.length > 1
    && new Set(ms.map((m) => editsOf(m).map((e) => `${e.file}::${e.from}`).sort().join('||'))).size !== ms.length)
  .map(([s]) => s);
ok('a suite with several entries mutates a different place each time', samePlace.length === 0,
  samePlace.join(', '));

/* ---- 6. every mutation must change EXECUTABLE CODE -----------------------------------------
 * An entry that edits a comment still applies cleanly, still changes the file, and still counts
 * as covered — while testing nothing. One of mine literally appended `// ` to a declaration and
 * changed no behaviour, and it sat in the table looking like coverage. Comparing the code-only
 * projection of before and after is what separates a real edit from a cosmetic one. */
{
  const cosmetic = [];
  const inapplicable = [];
  for (const m of MUTANTS) {
    const edits = editsOf(m);
    if (edits.some((e) => !existsSync(e.file))) continue;
    if (edits.some((e) => !readFileSync(e.file, 'utf8').includes(e.from))) {
      inapplicable.push(m.suite); continue;
    }
    /* An entry is cosmetic only if EVERY one of its edits is. One real edit makes the mutation
     * real, even if a sibling edit only touches a comment. */
    const allCosmetic = edits.every((e) => {
      const before = readFileSync(e.file, 'utf8');
      const after = before.replace(e.from, e.to);
      const lang = langOf(e.file);
      return codeOnly(before, lang) === codeOnly(after, lang);
    });
    if (allCosmetic) cosmetic.push(m.suite);
  }
  ok('every mutation alters executable code, not a comment or whitespace',
    cosmetic.length === 0,
    cosmetic.length
      ? `cosmetic mutation(s): ${cosmetic.join(', ')}\n`
        + `       these apply cleanly and count as covered while changing no behaviour — the `
        + `suite would pass and be recorded as MISSED, sending you to audit a test that is fine.`
      : '');
  ok('every mutation still matches its target (no stale entries)',
    inapplicable.length === 0,
    `stale: ${inapplicable.join(', ')} — the code moved and the entry did not`);
}

/* ---- 6b. the scanner the cosmetic check depends on ------------------------------------------
 * Check 6 asks whether a mutation changes EXECUTABLE code, and it answers by comparing codeOnly()
 * projections. So codeOnly is load-bearing for this gate, and it was quietly broken.
 *
 * `/[&<>"']/` — an ordinary HTML-escaping regex — appears in www/renderer.js and
 * www/surface-host.js. The scanner had no notion of regex literals, so it read the apostrophe
 * inside that character class as the start of a string and desynced for the rest of the file:
 * comments after it survived into the "code" projection. surface-host.js IS a mutation target,
 * which means this gate was reading a corrupted view of it and would have accepted a
 * comment-only mutation there as real coverage — the exact failure it exists to prevent.
 *
 * These cases pin the regex-vs-division distinction, because getting it wrong in either
 * direction breaks the gate: treat a regex as division and quotes inside it desync the scanner;
 * treat division as a regex and real code gets swallowed. */
{
  const cases = [
    ['a regex containing a quote does not open a string',
      "const re = /['\"]/g; // marker\nconst after = 1;", /marker/],
    ['division is not mistaken for a regex',
      'const a = 10 / 2; // marker\nconst b = a / 2;', /marker/],
    ['a slash inside a character class does not end the regex',
      'const r = /a[/]b/; // marker\nconst z = 1;', /marker/],
    ['a regex may follow `return`',
      "return /x'y/.test(s); // marker\nconst q = 1;", /marker/],
    ['a regex may follow `typeof`',
      "typeof /a'b/; // marker\nlet u = 1;", /marker/],
    ['division may follow a string literal',
      "const s = 'a'; const d = s.length / 2; // marker\nconst w = 1;", /marker/],
    ['division may follow a closing bracket',
      'const x = arr[0] / 2; // marker\nlet y = 1;', /marker/],
    ['division may follow a closing paren',
      'const f = (a) / 2; // marker\nlet g = 1;', /marker/],
  ];
  for (const [name, src, leak] of cases) {
    ok(`codeOnly: ${name}`, !leak.test(codeOnly(src, 'js')),
      `the comment survived the strip: ${JSON.stringify(codeOnly(src, 'js').slice(0, 80))}`);
  }
  /* And the real files that exposed it — a projection that still contains a comment marker
   * means the scanner desynced somewhere in a file this gate actually reads. */
  for (const f of ['www/renderer.js', 'www/surface-host.js']) {
    const full = join(REPO, f);
    if (!existsSync(full)) continue;
    const proj = codeOnly(readFileSync(full, 'utf8'), 'js');
    ok(`codeOnly leaves no // comment in ${f}`, !/(^|[^:])\/\/\s/.test(proj),
      'a surviving comment means the scanner desynced; this file contains /[&<>"\']/');
  }
}

/* ---- 7. the numbers, stated ---------------------------------------------------------------- */
const suites = all.filter((s) => !(s in UTILITIES));
ok('the covered count matches the suite count', covered.size === suites.length,
  `${covered.size} covered vs ${suites.length} suites`);

console.log(`\n  ${all.length} scripts = ${suites.length} suites (all mutation-covered) `
  + `+ ${Object.keys(UTILITIES).filter((u) => u in scripts).length} declared utilities`);
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
