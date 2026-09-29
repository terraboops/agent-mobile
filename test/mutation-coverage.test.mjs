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
import { UTILITIES } from './lib/suite-list.mjs';
import { codeOnly, langOf } from './lib/code-only.mjs';
import { existsSync } from 'node:fs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts || {};

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

/* The canonical list lives in ./lib/suite-list.mjs, shared with the suite runner. It used to be
 * duplicated there, with a comment claiming the two were kept in sync by an assertion that was
 * never written — so a new utility could be added to one and not the other. A shared module makes
 * that impossible instead of detectable. */

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

/* ---- 5b. every entry must name the CLAIM it takes down -------------------------------------
 * Check 6 below asks whether a mutation changes executable code. That is a weaker bar than it
 * reads: a mutation can change real code, fail the suite, and still guard nothing — because it
 * broke a PRECONDITION rather than the claim.
 *
 * Measured, not hypothetical: mute-midreply's entry sat on SILENCE_MS, which stops an utterance
 * ever closing. The suite failed at "the sidecar transcribed the utterance" and never reached
 * the mute behaviour it existed to protect. The table read CAUGHT for months of runs while the
 * mute claim was untested.
 *
 * `breaks` names a substring of the assertion the mutation must take down. The harness then
 * reports WRONG-CLAIM when the suite fails on something else — caught, but not the thing
 * claimed. Demonstrated: pointing mute-webrtc's `breaks` at an assertion its mutation does not
 * touch produced "expected to break ... but the failures were ...".
 *
 * Required, not optional: an entry without it is one nobody has had to think about. */
{
  const noBreaks = MUTANTS.filter((m) => typeof m.breaks !== 'string' || !m.breaks.trim());
  ok('every mutation entry names the assertion it must break', noBreaks.length === 0,
    `${noBreaks.length} entr(ies) with no breaks field: `
    + `${noBreaks.map((m) => m.suite).join(', ')}\n`
    + '       Run the mutation, see which assertion fails, and record a substring of it. If the '
    + 'failure is a PRECONDITION rather than the claim, the entry points at the wrong code.');
  /* A `breaks` value nobody could match is as bad as none. */
  const tooVague = MUTANTS.filter((m) => typeof m.breaks === 'string' && m.breaks.trim().length < 8);
  ok('no `breaks` value is too short to identify one assertion', tooVague.length === 0,
    tooVague.map((m) => `${m.suite}: "${m.breaks}"`).join(', '));

  /* A `breaks` value carrying NUMBERS must be a literal in the suite's source.
   *
   * WHERE THIS CAME FROM. `breaks` is written by running the mutation and copying a line of the
   * failure output. Do that on an assertion whose message is a template literal and the numbers
   * of that one run come along: "downlink stopped after the interrupt (61 -> 177 -> 271)",
   * "the answer echoes the offered payload type (111)", "the answer contains a tailnet candidate
   * (100.125.53.51)" — that last one is this machine's Tailscale address, so it could only ever
   * have matched on this host. Five entries were carrying a number in this shape.
   *
   * It does not produce a false pass: a stale number surfaces as WRONG-CLAIM, loudly. It does
   * produce a table that stops being able to tell a mis-pointed entry from a re-run, which is
   * the one job `breaks` has. Two of the five were already failing this way.
   *
   * Prose with no digits is exempt — plenty of assertion names are composed (`${rel}: installed
   * matches vendored`) and are perfectly stable. It is the NUMBERS that come from a run. */
  const scriptSrc = (suite) => {
    let out = '';
    for (const tok of String(scripts[suite] || '').split(/\s+/)) {
      if (!/\.(mjs|py|js)$/.test(tok)) continue;
      try { out += readFileSync(join(REPO, tok), 'utf8'); } catch { /* not a repo path */ }
    }
    return out;
  };
  const numeric = MUTANTS.filter((m) => typeof m.breaks === 'string' && /\d/.test(m.breaks)
                                     && !scriptSrc(m.suite).includes(m.breaks));
  ok('no `breaks` value carries a number copied out of one run', numeric.length === 0,
    numeric.map((m) => `${m.suite}: "${m.breaks}"`).join('\n       ')
    + '\n       Numbers in an assertion message are interpolated per run. Trim the claim back '
    + 'to the part that is written literally in the suite source.');
}

/* ---- 5b-bis. no assertion may be true by arithmetic -----------------------------------------
 *
 * The literal-true gate above catches `ok(true, ...)`. It does not catch the same thing written
 * as a comparison that cannot come out false, and this repo has produced three of those:
 *
 *   android-lint   `issues.length >= 0 && xml.includes(...)`   — a length is never negative, so
 *                  half the assertion was decoration and the parser could return nothing.
 *   adapter-fields `REQUIRED <= REAL` and `REQUIRED == (REAL - OMIT)` — both true by
 *                  construction, since REQUIRED is assigned `REAL - OMIT` one line above.
 *                  (Set algebra, so not matchable here; named so the gap is on the record.)
 *
 * What IS mechanically checkable is the count-never-negative family. A `.length >= 0`,
 * `len(x) >= 0`, `.size >= 0` or `> -1` is always true and there is no honest use of one in an
 * assertion: if the intent is "this parsed", say what it parsed into.
 *
 * The other half of the sweep that produced this — `len(a) < len(b)` standing in for a precise
 * budget — is NOT gated, deliberately. The shape is legitimate ("fewer errors than events" is
 * sometimes exactly the claim); what made two of them wrong was that the real claim was "once,
 * then periodically", which no regex can tell from the outside. Both instances are fixed and
 * carry a comment saying why; a gate here would be noise standing in for judgement. */
{
  const { readdirSync } = await import('node:fs');
  /* Every suite source, .mjs AND .py — the two instances were one of each. */
  const srcFiles = [];
  for (const d of ['test', 'test/audit']) {
    for (const f of readdirSync(join(REPO, d))) {
      if (/\.(test\.mjs|test\.py|mjs)$/.test(f) && !/^(lib|audit)$/.test(f)) srcFiles.push(join(d, f));
    }
  }
  for (const f of readdirSync(REPO)) if (/^test-.*\.mjs$/.test(f)) srcFiles.push(f);

  const alwaysTrue = [];
  for (const rel of srcFiles) {
    let src;
    try { src = readFileSync(join(REPO, rel), 'utf8'); } catch { continue; }
    src.split('\n').forEach((line, i) => {
      if (!/\bok\(|\bcheck\(/.test(line)) return;
      if (/(?:\.length|\.size|\blen\([^)]*\))\s*>=\s*0\b/.test(line)
          || /(?:\.length|\.size|\blen\([^)]*\))\s*>\s*-1\b/.test(line)) {
        alwaysTrue.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  ok('no assertion compares a count against zero from below', alwaysTrue.length === 0,
    alwaysTrue.join('\n       ')
    + '\n       A count is never negative, so this half of the condition can never fail. Assert '
    + 'what the count should BE, or drop it.');
}

/* ---- 5c. a mutation must not edit its own suite's test file ---------------------------------
 * Mutating the assertion instead of the code is a category error that cannot be caught by the
 * suite it belongs to: flip `ok(..., cond)` to `ok(..., true)` and the suite passes by
 * definition, so the harness reports MISSED and the entry looks like a weak test rather than a
 * malformed entry. I made exactly that mistake on android-lint.
 *
 * Mutating a LIBRARY the suite exercises is fine and common here — gateway-scope tests
 * test/lib/gateway-scope.mjs. What is never fine is editing the file that holds the assertions
 * doing the judging. */
{
  const selfEdits = [];
  for (const m of MUTANTS) {
    for (const e of editsOf(m)) {
      /* By PATH, not basename. test/lib/adb-state.mjs is the library the adb-state suite
       * exercises — mutating it is the point. test/adb-state.test.mjs is the suite itself. */
      const rel = e.file.replace(REPO + '/', '');
      if (rel === `test/${m.suite}.test.mjs` || rel === `test/${m.suite}.mjs`
          || rel === `test/audit/${m.suite}.mjs`) {
        selfEdits.push(`${m.suite} -> ${rel}`);
      }
    }
  }
  ok('no mutation edits the test file of the suite it belongs to', selfEdits.length === 0,
    `${selfEdits.join(', ')} — mutating an assertion cannot fail the suite that owns it; `
    + 'point the entry at the code under test instead');
}

/* ---- 5d. no assertion may be unfalsifiable by construction ----------------------------------
 * `ok(true, 'AEAD control channel up')` reports a fact it never checked. It cannot fail, it pads
 * the count, and it reads in the output exactly like a real check — which is how three of them
 * sat in suites already marked as mutation-covered: two in e2e-webrtc, one in ice-tailnet. If
 * connect() had ever resolved without a channel, the first printed a green tick saying otherwise.
 *
 * A mutation entry cannot catch this: the entry proves the SUITE fails, and these assertions are
 * simply along for the ride. Only reading the source finds them, so it is read here.
 *
 * Scanned with comments stripped — this very paragraph contains the pattern. */
{
  const { readdirSync } = await import('node:fs');
  const files = [];
  for (const d of ['test', 'test/audit']) {
    for (const f of readdirSync(join(REPO, d))) {
      if (/\.(test\.mjs|mjs)$/.test(f) && !/^(lib|audit)$/.test(f)) files.push(join(d, f));
    }
  }
  for (const f of readdirSync(REPO)) if (/^test-.*\.mjs$/.test(f)) files.push(f);

  const offenders = [];
  for (const rel of files) {
    let src;
    try { src = readFileSync(join(REPO, rel), 'utf8'); } catch { continue; }
    const code = codeOnly(src, 'js');
    /* ok(true, ...) and ok(<name>, true) — both orders are in use across these suites. */
    if (/\bok\(\s*true\s*[,)]/.test(code) || /\bok\([^,()]*,\s*true\s*[,)]/.test(code)) {
      offenders.push(rel);
    }
  }
  ok('no suite asserts a literal true', offenders.length === 0,
    `${offenders.join(', ')} — an assertion whose condition is a constant cannot fail; it pads `
    + 'the count and reads like a check. Assert the thing it claims, or delete it and say why.');
}

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
