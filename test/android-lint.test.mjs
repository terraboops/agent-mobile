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
/* Each <issue id="..." severity="..."> may carry several <location> children. Count issues. */
const issues = [...xml.matchAll(/<issue\s+([^>]*?)>/gs)].map((m) => {
  const a = m[1];
  const g = (k) => (new RegExp(`${k}="([^"]*)"`).exec(a) || [])[1];
  return { id: g('id'), severity: g('severity'), message: g('message') };
});
ok('the report parsed into issues', issues.length >= 0 && xml.includes('<issues'),
  'the XML did not look like a lint report');

/* Locations, so a violation can be pointed at. */
const locsFor = (id) => [...xml.matchAll(new RegExp(`<issue\\s+id="${id}"[\\s\\S]*?</issue>`, 'g'))]
  .flatMap((blk) => [...blk[0].matchAll(/file="([^"]*)"\s*(?:line="(\d+)")?/g)]
    .map((l) => `${l[1].replace(/.*\/com\/agentmobile\/agent\//, '')}${l[2] ? ':' + l[2] : ''}`));

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

/* ---- reported, not enforced ----------------------------------------------------------------
 * Adopting every lint error at once would mean either fixing or suppressing unrelated findings
 * in the same change, and a suppression added to make a gate green is how a gate stops meaning
 * anything. These are printed every run so they cannot be forgotten, and left for a decision. */
if (otherErrors.length) {
  console.log('\n  lint errors NOT gated here (reported so they are not forgotten):');
  for (const i of otherErrors) {
    console.log(`    [${i.id}] ${(i.message || '').slice(0, 110)}`);
    console.log(`      at ${[...new Set(locsFor(i.id))].slice(0, 3).join(', ')}`);
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
