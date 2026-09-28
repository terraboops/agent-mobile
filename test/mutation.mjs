/**
 * mutation — does each new suite actually test its feature, or only its own scaffolding?
 *
 * Twelve suites were added in one day, each reviewed by the same person who wrote it. The
 * outbound-queue episode showed what that can produce: four green commits over a feature that
 * did not work, because every test told the code what it wanted to hear.
 *
 * The check is blunt and therefore hard to fool — DELETE THE FEATURE and confirm the suite
 * notices. A suite that still passes with its feature removed is asserting on scaffolding.
 *
 * SAFETY. These mutations edit the LIVE plugin (adapter.py, the sidecar). Every target is
 * backed up before the edit, restored in a finally, restored again on SIGINT/SIGTERM/uncaught,
 * and verified by hash at the end. If the hash check fails the run says so loudly rather than
 * leaving a mutated plugin behind.
 *
 * Run: npm run mutation            (all)
 *      npm run mutation -- stt     (one, by substring)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MUTANTS, REPO } from './lib/mutants.mjs';
import { reloadSidecar, needsScopedGateway, scopedGatewayPrecondition } from './lib/gateway-scope.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/* Reloading mutated code WITHOUT restarting the live gateway.
 *
 * What used to be here ran `launchctl kickstart -k gui/<uid>/ai.hermes.gateway` — the LIVE
 * gateway serving Telegram, the phone bridge and every cron job on this machine — and wrapped it
 * in `catch {}` so the one signal that could have flagged it was swallowed. It bounced production
 * about fourteen times in a night: cron work killed mid-write and logged as failure, the phone
 * bridge dropped mid-conversation, an unclean exit recorded with no exit path run.
 *
 * Replaced by reloadSidecar(), which signals only the sidecar CHILD process and lets the
 * adapter's own supervisor respawn it. Adapter mutations cannot be reloaded that way and are
 * reported as a named precondition instead of silently skipped. The guard in gateway-scope.mjs
 * makes the old behaviour impossible even if someone reaches for launchctl again. */

export 
const only = process.argv[2];
const chosen = only ? MUTANTS.filter((m) => m.suite.includes(only)) : MUTANTS;

const touched = [...new Set(chosen.map((m) => m.file))];
const backups = new Map();
for (const f of touched) {
  if (!existsSync(f)) continue;
  const b = `${f}.mutation-backup`;
  copyFileSync(f, b);
  backups.set(f, { backup: b, hash: sha(f) });
}
let restored = false;
const restoreAll = () => {
  if (restored) return;
  restored = true;
  for (const [f, { backup }] of backups) { try { copyFileSync(backup, f); } catch {} }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(70); });

const results = [];
try {
  for (const m of chosen) {
    if (!existsSync(m.file)) { results.push({ ...m, verdict: 'skip', note: 'file missing' }); continue; }
    /* adapter.py is imported INTO the gateway process; reloading it means restarting that
     * process, and the live one is not ours to restart. Named, not hidden. */
    if (m.restart && needsScopedGateway(m.file)) {
      results.push({ ...m, verdict: 'PRECONDITION', note: scopedGatewayPrecondition(m.suite, m.file) });
      console.log(`  NOT RUN ${m.suite.padEnd(24)} (needs a scoped gateway — see below)`);
      continue;
    }
    const original = readFileSync(m.file, 'utf8');
    if (!original.includes(m.from)) {
      results.push({ ...m, verdict: 'STALE', note: 'the mutation target no longer exists' });
      continue;
    }
    writeFileSync(m.file, original.replace(m.from, m.to));
    /* Purge the bytecode cache. Python will happily load a __pycache__ .pyc compiled from the
     * UNMUTATED source, so the mutation silently does nothing and the suite is recorded as
     * MISSED — which is what happened to tts-failfast: it was CAUGHT when run alone and MISSED
     * in sequence, because an earlier iteration had left a cached adapter behind. A mutation
     * harness that cannot guarantee the mutation took effect is worse than none, since its
     * false MISSES send you auditing tests that are fine. */
    try { rmSync(join(dirname(m.file), '__pycache__'), { recursive: true, force: true }); } catch {}
    /* The sidecar and adapter are RUNNING processes. Editing their source changes nothing until
     * the gateway reloads them, so an e2e mutation without this restart would test the
     * unmutated code and record a false MISS — the live-process equivalent of stale bytecode. */
    if (m.restart) {
      const rl = reloadSidecar();
      if (!rl.ok) {
        /* A reload that did not happen means the suite would run against UNMUTATED code and be
         * recorded as MISSED — a false negative that sends you auditing a test that is fine.
         * Say so instead. */
        writeFileSync(m.file, original);
        results.push({ ...m, verdict: 'BLOCKED', note: `sidecar reload failed: ${rl.note}` });
        console.log(`  BLOCKED ${m.suite.padEnd(24)} sidecar reload failed: ${rl.note}`);
        continue;
      }
    }
    const r = spawnSync('npm', ['run', '-s', m.suite],
      { cwd: REPO, encoding: 'utf8', timeout: 900000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    writeFileSync(m.file, original);
    if (m.restart) reloadSidecar();
    const failed = r.status !== 0;
    const n = (r.stdout || '').match(/(\d+) (?:passed|failed)/g) || [];
    results.push({ ...m, verdict: failed ? 'CAUGHT' : 'MISSED', note: n.join(' ') });
    console.log(`  ${failed ? 'CAUGHT ' : 'MISSED '} ${m.suite.padEnd(24)} (${m.why})`);
  }
} finally {
  restoreAll();
}

/* Prove every file is exactly as we found it, then remove the backups.
 *
 * They used to be left behind: ten .mutation-backup files sitting in the tree and in the live
 * plugin directory, which git then reported as untracked. A harness that tidies up only when
 * you remember to is one more thing to remember. They are deleted ONLY after the hash check
 * passes — if a restore failed they are the recovery path and must survive. */
let clean = true;
for (const [f, { hash }] of backups) {
  const now = sha(f);
  if (now !== hash) { clean = false; console.log(`  !! ${f} NOT RESTORED (${hash.slice(0, 8)} -> ${now.slice(0, 8)})`); }
}
console.log(`\nrestore verified: ${clean ? 'every mutated file is byte-identical to before' : 'FAILED — see above'}`);
if (clean) {
  for (const [, { backup }] of backups) { try { rmSync(backup, { force: true }); } catch {} }
} else {
  console.log('backups KEPT for recovery: ' + [...backups.values()].map((b) => b.backup).join(', '));
}

const blocked = results.filter((r) => r.verdict === 'BLOCKED');
const precondition = results.filter((r) => r.verdict === 'PRECONDITION');
const missed = results.filter((r) => r.verdict === 'MISSED');
const stale = results.filter((r) => r.verdict === 'STALE');
const caught = results.filter((r) => r.verdict === 'CAUGHT');
console.log(`\n${caught.length} caught, ${missed.length} MISSED, ${stale.length} stale, `
  + `${blocked.length} blocked, ${precondition.length} not run, of ${results.length}`);
for (const r of precondition) console.log(`  NOT RUN: ${r.note}`);
for (const r of blocked) console.log(`  BLOCKED: ${r.suite} — ${r.note}`);
for (const r of missed) console.log(`  MISSED: ${r.suite} — passed with "${r.why}" deleted; it is asserting on scaffolding`);
for (const r of stale) console.log(`  STALE : ${r.suite} — ${r.note}`);
/* A PRECONDITION is missing coverage, not a pass. It does not fail the run — the mutation was
 * never attempted, so there is no verdict to fail on — but it is printed every time so it cannot
 * quietly become the status quo. BLOCKED does fail: it means the harness could not guarantee the
 * mutation took effect. */
process.exit(!clean || missed.length || stale.length || blocked.length ? 1 : 0);
