/**
 * android-lint.test — Java that calls an API above minSdk must fail here, not on the phone.
 *
 * THE GAP. compileSdk is 36 and minSdk is far below it, so javac accepts any modern API without
 * a murmur — the version floor is enforced by Android Lint's NewApi check and by nothing else.
 * Nothing ran lint. The www/ side had a baseline gate; the Java side had none at all, and the
 * only signal would have been a crash on a device.
 *
 * WHAT IT FOUND, the first time it ran: 24 NewApi errors. Not stylistic — the deepest were
 * Arrays.compareUnsigned and ByteArrayOutputStream.writeBytes (both API 33) inside KoCrypto,
 * the AEAD handshake path. Below API 33 that does not degrade, it throws, so the app could not
 * complete a single connection. java.util.Base64 (API 26) and Service#startForeground with a
 * type (API 29) were in the same bucket. minSdk said 24 and had been wrong by nine levels.
 *
 * Fixed by raising minSdk to the floor the code actually requires (see variables.gradle, which
 * also enumerates exactly what would have to change to lower it again). This gate is what keeps
 * that number honest.
 *
 * WHY IT PARSES XML rather than reading gradle's exit status: lint reports many issue classes and
 * this gate deliberately adopts ONE as fatal. Letting gradle abort would conflate NewApi with
 * everything else and make the decision about what matters invisible. Other errors are printed,
 * counted, and left to a human — stated here rather than silently dropped.
 *
 * Run: npm run android-lint
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gradle, ANDROID, resolveJdk } from './lib/android-build.mjs';
import { parseLintIssues, countIssueTags, looksLikeReport, locationsFor }
  from './lib/lint-report.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const REPORT = join(ANDROID, 'app', 'build', 'reports', 'agentmob-lint.xml');

/* Delete the report FIRST. A stale file from a previous run reads exactly like a clean one, and
 * this suite nearly shipped on that mistake: an earlier lint run failed on a JDK error, the grep
 * that counted NewApi lines saw no output, and "0 violations" was a count of nothing at all. */
try { rmSync(REPORT, { force: true }); } catch {}

const jdk = resolveJdk();
console.log(`gradle JDK: ${jdk ? `${jdk.major} (${jdk.home})` : 'NONE FOUND'}`);
const r = gradle([':app:lintDebug', '-q']);
ok('a JDK gradle can use was found', !!jdk, r.reason || '');
if (!jdk) { console.log(`\n${pass} passed, ${fails.length} failed`); process.exit(1); }

/* The build must have SUCCEEDED, or every conclusion below is drawn from nothing. */
ok('gradle lint ran to completion', r.ok,
  `gradle exited ${r.status}\n       ${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n       ')}`);
ok('lint wrote its report', existsSync(REPORT),
  `${REPORT} is missing — without it a "no violations" result means the run failed, not that the `
  + 'code is clean');
if (!r.ok || !existsSync(REPORT)) { console.log(`\n${pass} passed, ${fails.length} failed`); process.exit(1); }

const xml = readFileSync(REPORT, 'utf8');
/* Parsing lives in test/lib/lint-report.mjs, with fixtures of its own — see the note there for
 * why it could not stay inline. What is checked here is that the parser still agrees with the
 * REAL report Gradle just produced: a regex that stops matching yields an empty list, and an
 * empty list is a legitimate outcome for a clean build, so the two have to be told apart by
 * comparing the parse against an independent count of the tags. */
const issues = parseLintIssues(xml);
const issueTags = countIssueTags(xml);
ok('the report is a lint report', looksLikeReport(xml), 'the XML did not look like a report');
ok('every <issue> in the report parsed into a record with an id',
  issues.length === issueTags && issues.every((i) => !!i.id),
  `${issueTags} <issue> tag(s) in the XML, ${issues.length} parsed, `
  + `${issues.filter((i) => !i.id).length} with no id — the parser has gone blind`);

/* POSITIVE CONTROL, so "0 issues" can never be mistaken for "parser broken". A fixture with
 * known contents goes through the same function the real report does. */
const FIXTURE = '<issues format="6">'
  + '<issue id="NewApi" severity="Error" message="Call requires API level 33">'
  + '<location file="/x/com/agentmobile/agent/KoCrypto.java" line="41"/></issue>'
  + '<issue id="MissingPermission" severity="Warning" message="needs RECORD_AUDIO">'
  + '<location file="/x/com/agentmobile/agent/MainActivity.java" line="7"/></issue></issues>';
const fx = parseLintIssues(FIXTURE);
ok('control: a known report parses into exactly its two issues', fx.length === 2, JSON.stringify(fx));
ok('control: ids, severities and messages all come through',
  fx[0].id === 'NewApi' && fx[0].severity === 'Error' && /API level 33/.test(fx[0].message || ''),
  JSON.stringify(fx[0]));
ok('control: locations are found and trimmed to the package',
  locationsFor(FIXTURE, 'NewApi').join() === 'KoCrypto.java:41',
  locationsFor(FIXTURE, 'NewApi').join());
ok('control: an EMPTY report parses to nothing and still reads as a report',
  parseLintIssues('<issues format="6"></issues>').length === 0
  && looksLikeReport('<issues format="6"></issues>'),
  'a clean build must be distinguishable from a broken parser');
ok('control: a file that is not a report is not treated as one',
  !looksLikeReport('<html><body>build failed</body></html>'));

const locsFor = (id) => locationsFor(xml, id);

const newApi = issues.filter((i) => i.id === 'NewApi');
const inlined = issues.filter((i) => i.id === 'InlinedApi');
const otherErrors = issues.filter((i) => i.severity === 'Error' && i.id !== 'NewApi');
const warnings = issues.filter((i) => i.severity === 'Warning');

console.log(`  lint: ${issues.length} issue(s) — NewApi ${newApi.length}, `
  + `other errors ${otherErrors.length}, warnings ${warnings.length}`);

/* ---- THE GATE ------------------------------------------------------------------------------ */
ok('no Java code calls an API above minSdk (NewApi)', newApi.length === 0,
  `${newApi.length} violation(s):\n       `
  + newApi.slice(0, 8).map((i) => `${i.message}`).join('\n       ')
  + `\n       at: ${[...new Set(locsFor('NewApi'))].slice(0, 8).join(', ')}`
  + '\n       Either guard the call with a Build.VERSION check, use a compat API, or raise '
  + 'minSdkVersion in android/variables.gradle to the level the code actually needs. Leaving it '
  + 'is a promise that the app installs on devices where it throws.');

/* InlinedApi is the quieter cousin: a constant from a newer API inlined at compile time. It does
 * not crash, so it is not fatal here, but it is a signal that the floor is being tested. */
ok('no newer-API constants are being inlined (InlinedApi)', inlined.length === 0,
  `${inlined.length}: ${[...new Set(locsFor('InlinedApi'))].join(', ')}`);

/* ---- every lint ERROR is fatal now ---------------------------------------------------------
 * This began as "NewApi is fatal, the rest is printed", because adopting every issue class at
 * once would have meant fixing or suppressing unrelated findings in the same change, and a
 * suppression added to make a gate green is how a gate stops meaning anything.
 *
 * There was exactly one other error: MissingPermission on the AudioRecord construction. It is
 * resolved — see AgentChannelPlugin.startAudioActual, where @RequiresPermission DECLARES the
 * contract so lint propagates it and verifies the callers, rather than a @SuppressLint that
 * asserts nothing and is never re-examined. With the count at zero, the reason for deferring is
 * gone, and a zero baseline is the cheap moment to gate: nothing has to be suppressed to get
 * there, so the gate starts honest.
 *
 * MissingPermission especially belongs here rather than in a printed list. It guards the
 * MICROPHONE, and code that opens the mic without checking is the failure this surface can least
 * afford — the badge would say one thing while the hardware did another.
 *
 * Warnings stay unenforced: adopting 36 of them today would be exactly what the first paragraph
 * warns against. They are printed by class so the number cannot grow unnoticed. */
ok('lint reports no errors of any class', otherErrors.length === 0,
  `${otherErrors.length} error(s):\n       `
  + otherErrors.map((i) => `[${i.id}] ${(i.message || '').slice(0, 120)}`
      + `\n       at ${[...new Set(locsFor(i.id))].slice(0, 3).join(', ')}`).join('\n       ')
  + '\n       Fix it, or exclude that issue id here with a stated reason. Do not reach for '
  + '@SuppressLint just to get this green.');

if (warnings.length) {
  const byId = warnings.reduce((m, i) => (m[i.id] = (m[i.id] || 0) + 1, m), {});
  console.log('  warnings (not gated): ' + Object.entries(byId)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
