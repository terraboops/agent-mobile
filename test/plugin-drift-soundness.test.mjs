/**
 * plugin-drift-soundness.test — sameness is not soundness.
 *
 * plugin-drift hashes the installed plugin against vendor/. That proves the two trees AGREE.
 * It says nothing about whether either one runs. A vendored file that is corrupt matches its
 * own hash perfectly, so a restore from it would reinstate something broken and every hash
 * check would pass the whole way through — the check that guards everything else being only
 * half a check.
 *
 * The scenario here is deliberately the hard one: installed and vendored are BYTE-IDENTICAL and
 * the manifest hash is correct. Nothing about sameness is wrong. Only parsing catches it.
 *
 * Builds a throwaway plugin + vendor pair and runs the real drift checker against it via
 * AGENTMOB_PLUGIN_DIR / AGENTMOB_VENDOR_DIR. The real installation is never touched.
 *
 * Run: npm run plugin-drift-soundness
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { syntaxCheck, FILES, isForbidden } from './lib/vendor-files.mjs';

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIFT = join(REPO, 'test/plugin-drift.test.mjs');
const REAL_VENDOR = join(REPO, 'vendor/hermes-plugin');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ---- 1. the syntax checker itself, per file type ------------------------------------------ */
const tmp = mkdtempSync(join(tmpdir(), 'drift-sound-'));
{
  const good = join(tmp, 'good.mjs'); writeFileSync(good, 'export const x = 1;\n');
  const bad = join(tmp, 'bad.mjs'); writeFileSync(bad, 'export const = ;;; {\n');
  ok('js: valid module passes', (await syntaxCheck(good)).ok);
  const r = await syntaxCheck(bad);
  ok('js: broken module fails', !r.ok);
  ok('js: the error is reported, not just a boolean', !!r.error && r.error.length > 5, String(r.error));
}
{
  const good = join(tmp, 'good.py'); writeFileSync(good, 'def f():\n    return 1\n');
  const bad = join(tmp, 'bad.py'); writeFileSync(bad, 'def f(:\n  return\n');
  ok('py: valid module passes', (await syntaxCheck(good)).ok);
  const r = await syntaxCheck(bad);
  ok('py: broken module fails', !r.ok);
  ok('py: the error is reported', !!r.error, String(r.error));
}
{
  const good = join(tmp, 'good.json'); writeFileSync(good, '{"a":1}');
  const bad = join(tmp, 'bad.json'); writeFileSync(bad, '{"a":');
  ok('json: valid passes', (await syntaxCheck(good)).ok);
  ok('json: broken fails', !(await syntaxCheck(bad)).ok);
}
{
  /* Truncation is the realistic corruption — a half-written restore, not random bytes. */
  const src = readFileSync(join(REAL_VENDOR, 'sidecar/wire.mjs'), 'utf8');
  const midBody = join(tmp, 'trunc-body.mjs');
  writeFileSync(midBody, src.slice(0, Math.floor(src.length * 0.7)));
  ok('js: a file truncated mid-function is caught', !(await syntaxCheck(midBody)).ok,
    'a half-written function parsed cleanly');

  /* AND THE LIMIT OF THIS CHECK, recorded rather than hidden. wire.mjs opens with a long
   * comment block, so truncating inside it yields a file that is perfectly valid JavaScript
   * and contains nothing. Syntax checking catches MALFORMED files, not semantically empty
   * ones — a restore truncated at a statement boundary would still pass every check here. */
  const midComment = join(tmp, 'trunc-comment.mjs');
  writeFileSync(midComment, src.slice(0, 900));
  ok('js: KNOWN LIMIT — truncation inside a comment still parses (documented, not fixed)',
    (await syntaxCheck(midComment)).ok,
    'this now fails, so the limit has changed and the comment above is stale');
}

/* ---- 2. end to end: corrupt, hash-identical, and it must FAIL ------------------------------ */
function buildPair(corrupt) {
  const root = mkdtempSync(join(tmpdir(), 'drift-pair-'));
  const plug = join(root, 'plugin');
  const vend = join(root, 'vendor');
  cpSync(REAL_VENDOR, vend, { recursive: true });
  cpSync(REAL_VENDOR, plug, { recursive: true });

  if (corrupt) {
    /* Truncate the SAME file in both trees, so they stay byte-identical. */
    const rel = 'sidecar/index.mjs';
    const half = readFileSync(join(vend, rel), 'utf8').slice(0, 5000);
    writeFileSync(join(vend, rel), half);
    writeFileSync(join(plug, rel), half);
  }
  /* Regenerate the manifest from the (possibly corrupt) vendored bytes, so every hash is
   * correct. This is the point: nothing about sameness is wrong. */
  const files = {};
  for (const rel of FILES) {
    if (isForbidden(rel)) continue;
    const p = join(vend, rel);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    files[rel] = { sha256: sha(buf), bytes: buf.length };
  }
  writeFileSync(join(vend, 'MANIFEST.json'),
    JSON.stringify({ generated: new Date().toISOString(), source: plug, files }, null, 2) + '\n');
  return { plug, vend };
}

async function runDrift({ plug, vend }) {
  try {
    const { stdout } = await run(process.execPath, [DRIFT],
      { env: { ...process.env, AGENTMOB_PLUGIN_DIR: plug, AGENTMOB_VENDOR_DIR: vend },
        maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.code ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

{
  const healthy = await runDrift(buildPair(false));
  ok('control: an intact pair passes', healthy.code === 0,
    healthy.stdout.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | '));
  ok('control: it ran the soundness checks at all',
    /the vendored copy parses/.test(healthy.stdout));
}
{
  const broken = await runDrift(buildPair(true));
  ok('CORRUPT-BUT-IDENTICAL: the drift check FAILS', broken.code !== 0,
    'a corrupt vendored file passed — the check still only proves sameness');
  ok('corrupt: the failure is the SOUNDNESS one, not a hash mismatch',
    /the vendored copy parses/.test(broken.stdout)
    && /FAIL .*the vendored copy parses/.test(broken.stdout),
    broken.stdout.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | '));
  ok('corrupt: the hash checks still PASS (proving sameness was never the problem)',
    /ok .*installed matches vendored/.test(broken.stdout)
    && !/FAIL .*installed matches vendored/.test(broken.stdout),
    'a hash check failed too, so this does not isolate soundness');
  ok('corrupt: it names the file', /sidecar\/index\.mjs: the vendored copy parses/.test(broken.stdout));
  ok('corrupt: it explains the consequence',
    /restoring from it would install a broken/.test(broken.stdout),
    broken.stdout.split('\n').filter((l) => /restoring/.test(l))[0] || '');
  const line = broken.stdout.split('\n').find((l) => /SYNTAX ERROR/.test(l));
  if (line) console.log(`  observed: ${line.trim().slice(0, 110)}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
