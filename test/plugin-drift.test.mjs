/**
 * plugin-drift.test — the installed Hermes plugin must match what this repo has vendored.
 *
 * `~/.hermes/plugins/agentmob` is gitignored, so every fix made there lives on exactly one Mac.
 * A restore of that directory from a backup silently reverts all of it — the sidecar reaper, the
 * parent-death watchdog, both port guards, the ICE deadline, the downlink truncation logging,
 * the respawn escalation — and nothing anywhere would say so. The revert would present as the
 * old bugs quietly coming back, which is the hardest kind of regression to attribute.
 *
 * This does not install anything and never writes to the plugin directory. It hashes the
 * installed files against vendor/hermes-plugin and fails with a NAMED diff: which file, how it
 * differs, and the first differing lines. `npm run vendor-refresh` is the sanctioned way to
 * record an intentional change.
 *
 * AGENTMOB_PLUGIN_DIR points it at another tree — used by the red test below to check a
 * deliberately modified COPY without ever touching the real installation.
 *
 * Run: npm run plugin-drift
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PLUGIN_DIR, VENDOR_DIR, FILES, isForbidden, syntaxCheck } from './lib/vendor-files.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail.split('\n').join('\n       ') : ''}`); }
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

if (!existsSync(PLUGIN_DIR)) { console.log(`skip: no plugin at ${PLUGIN_DIR}`); process.exit(0); }
const MANIFEST = join(VENDOR_DIR, 'MANIFEST.json');
if (!existsSync(MANIFEST)) {
  console.log(`no vendored snapshot at ${MANIFEST} — run: npm run vendor-refresh`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

console.log(`installed: ${PLUGIN_DIR}`);
console.log(`vendored : ${VENDOR_DIR}  (snapshot ${manifest.generated})\n`);

/** First few differing lines, so the failure names what changed rather than just that it did. */
function namedDiff(vendored, installed, max = 6) {
  const a = vendored.split('\n'), b = installed.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`  -${i + 1}: ${a[i].trim().slice(0, 100)}`);
      if (b[i] !== undefined) out.push(`  +${i + 1}: ${b[i].trim().slice(0, 100)}`);
    }
  }
  const delta = b.length - a.length;
  if (delta) out.push(`  (installed has ${delta > 0 ? '+' : ''}${delta} line(s))`);
  return out.join('\n') || '  (binary or whitespace-only difference)';
}

/* The secret guard comes first: a vendored identity file would be a leaked private key, which
 * matters more than any drift this check could report. */
for (const rel of Object.keys(manifest.files)) {
  ok(`manifest excludes secrets and state (${rel})`, !isForbidden(rel), `${rel} must never be vendored`);
}
ok('the sidecar identity keypair is NOT vendored',
  !existsSync(join(VENDOR_DIR, 'sidecar/.identity.json')),
  'vendor/hermes-plugin/sidecar/.identity.json exists — that file holds the private key');

ok('the manifest covers every file we claim to track',
  FILES.filter((f) => !isForbidden(f)).every((f) => manifest.files[f] || !existsSync(join(PLUGIN_DIR, f))),
  'run npm run vendor-refresh');

/* ---- the drift check itself -------------------------------------------------------------- */
for (const [rel, rec] of Object.entries(manifest.files)) {
  const installedPath = join(PLUGIN_DIR, rel);
  const vendoredPath = join(VENDOR_DIR, rel);

  if (!existsSync(installedPath)) {
    ok(`${rel}: present in the installation`, false,
      `MISSING from ${PLUGIN_DIR}.\n`
      + `The plugin may have been restored from a backup or partially removed.\n`
      + `Restore it from ${vendoredPath}, then re-run.`);
    continue;
  }
  if (!existsSync(vendoredPath)) {
    ok(`${rel}: vendored copy exists`, false, `missing ${vendoredPath} — run npm run vendor-refresh`);
    continue;
  }

  const installed = readFileSync(installedPath);
  const vendored = readFileSync(vendoredPath);
  const hi = sha(installed), hv = sha(vendored);

  ok(`${rel}: vendored copy matches its manifest hash`, hv === rec.sha256,
    hv === rec.sha256 ? '' : `vendor/ was edited by hand — ${hv.slice(0, 12)} vs ${rec.sha256.slice(0, 12)}`);

  ok(`${rel}: installed matches vendored`, hi === hv,
    hi === hv ? '' :
      `DRIFT: installed ${hi.slice(0, 12)} != vendored ${hv.slice(0, 12)} `
      + `(${installed.length}B vs ${vendored.length}B)\n`
      + namedDiff(vendored.toString('utf8'), installed.toString('utf8')) + '\n'
      + `If the INSTALLED copy is correct:  npm run vendor-refresh\n`
      + `If it was reverted (restore from backup), reapply from ${vendoredPath}.`);
}

/* ---- soundness: the vendored copies must actually PARSE -----------------------------------
 * Hashes prove sameness. A vendored file that is corrupt matches its own hash perfectly, so a
 * restore from it would reinstate something broken and every check above would still pass.
 * This is the difference between "the two trees agree" and "either tree works". */
for (const rel of Object.keys(manifest.files)) {
  const vendored = join(VENDOR_DIR, rel);
  if (!existsSync(vendored)) continue;
  const r = await syntaxCheck(vendored);
  ok(`${rel}: the vendored copy parses`, r.ok,
    r.ok ? '' : `SYNTAX ERROR in the vendored copy — restoring from it would install a broken `
      + `plugin, and the hashes would match the whole way.\n  ${r.error}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nThe Hermes plugin is gitignored, so drift here means host-only fixes have been');
  console.log('lost or changed without the repo knowing. Resolve it in one direction or the other.');
  process.exit(1);
}
console.log('ALL PASS');
