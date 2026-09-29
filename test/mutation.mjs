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
import { reloadSidecar } from './lib/gateway-scope.mjs';
import { setupScopedHome, startScoped, stopScoped, liveGatewayPid, SCOPED_WS_URL, logTail }
  from './lib/scoped-gateway.mjs';

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

/* An entry is ONE conceptual mutation, but it may need SEVERAL edits.
 *
 * Defence in depth breaks a single-edit harness. surface-live's egress guarantee is enforced by
 * TWO independent CSPs — the page's (inherited by the srcdoc frame) and the sandbox preamble's —
 * and the most restrictive wins, so loosening either alone changes nothing. Measured: preamble
 * only -> 0 canary hits; page only -> 0; BOTH -> 2. A harness that can only edit one file per
 * entry therefore reports MISSED on a property that is perfectly falsifiable, and the obvious
 * (wrong) reaction is to delete the entry and call the claim unguardable.
 *
 * `edits: [{file, from, to}, ...]` says "make all of these, then run the suite". The legacy
 * {file, from, to} shape is normalised into a single-edit list so nothing else has to change. */
const editsOf = (m) => (Array.isArray(m.edits) && m.edits.length ? m.edits
                                                                 : [{ file: m.file, from: m.from, to: m.to }]);
const touched = [...new Set(chosen.flatMap((m) => editsOf(m).map((e) => e.file)))];

/* REFUSE TO START if a previous run left backups behind.
 *
 * Restore lives in a finally, and a finally does not run when the HOST dies. The 16:36 reboot
 * killed a full-table run mid-flight and left 20 .mutation-backup files plus one genuinely
 * mutated file — the scoped sidecar still carrying SPEECH_RMS = -1. The live plugin happened to
 * be clean, but only because of where the run had got to; a reboot a few entries earlier would
 * have left Terra's production adapter mutated with nothing anywhere saying so.
 *
 * Backups on disk mean exactly one thing: a run did not finish. Starting a new one would copy the
 * CURRENT (possibly mutated) file over the good backup and destroy the only record of what the
 * file should be. So stop, and say what to do. */
{
  const orphaned = touched.filter((f) => existsSync(`${f}.mutation-backup`));
  if (orphaned.length) {
    console.error('\nREFUSING TO RUN: a previous mutation run did not finish.\n');
    console.error(`${orphaned.length} file(s) still have a .mutation-backup beside them:`);
    for (const f of orphaned) {
      const same = readFileSync(f, 'utf8') === readFileSync(`${f}.mutation-backup`, 'utf8');
      console.error(`  ${same ? 'clean  ' : 'MUTATED'}  ${f.replace(process.env.HOME || '~', '~')}`);
    }
    console.error('\nA new run would overwrite those backups with the current (possibly mutated)'
      + '\ncontents and destroy the only record of the originals.\n');
    console.error('Check each one, restore anything marked MUTATED from its backup, then delete');
    console.error('the .mutation-backup files:');
    console.error('  for b in $(find . ~/.hermes/plugins/agentmob ~/.hermes/profiles -name "*.mutation-backup"); do');
    console.error('    f="${b%.mutation-backup}"; cmp -s "$b" "$f" || cp "$b" "$f"; rm "$b"; done');
    process.exit(3);
  }
}
/* ONE RUN AT A TIME, and a way to find it.
 *
 * Each suite runs under spawnSync, and Node cannot run a signal handler while blocked in one:
 * a SIGTERM to this process is queued until the current suite finishes — ten minutes for the
 * slow ones — with a file mutated the whole time. A run was "killed", kept going, and every
 * suite run beside it read mutated code; one of them produced a failure that took twenty
 * minutes to trace back here. So the run announces itself in a lock file, with the process
 * GROUP to signal (which takes the child suite down too, so the handler gets to run), and a
 * second run refuses to start while the first is alive. */
const LOCK = join(REPO, 'test', '.mutation-running');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (existsSync(LOCK)) {
  let held = null;
  try { held = JSON.parse(readFileSync(LOCK, 'utf8')); } catch { /* unreadable: treat as stale */ }
  if (held && alive(held.pid)) {
    console.error(`\nANOTHER MUTATION RUN IS LIVE: pid ${held.pid}, started ${held.started}, `
      + `filter "${held.filter || '(all)'}". Its files may be mutated right now.`);
    console.error(`Stop it with:  touch test/.mutation-stop   (after the current suite), or`);
    console.error(`               kill -TERM -${held.pgid}   (cuts the current suite short; the `
      + 'batch then stops and restores)\n');
    process.exit(4);
  }
  rmSync(LOCK, { force: true });   // stale: its process is gone
}
let pgid = process.pid;
try { pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim()) || process.pid; } catch {}
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, pgid, started: new Date().toISOString(),
                                     filter: only || null }));
process.on('exit', () => { try { rmSync(LOCK, { force: true }); } catch {} });
console.log(`mutation run pid ${process.pid} — to stop it: touch test/.mutation-stop  `
  + `(takes effect after the current suite), or kill -TERM -${pgid} to cut the suite short`);

const backups = new Map();
for (const f of touched) {
  if (!existsSync(f)) continue;
  const b = `${f}.mutation-backup`;
  copyFileSync(f, b);
  backups.set(f, { backup: b, hash: sha(f) });
}
let restored = false;
let livePidMoved = false;
const restoreAll = () => {
  if (restored) return;
  restored = true;
  for (const [f, { backup }] of backups) { try { copyFileSync(backup, f); } catch {} }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(70); });

const results = [];
let scopedUp = null;
/* STOPPING, for real this time.
 *
 * The first fix wrote a lock naming the process GROUP to signal, on the theory that killing the
 * child suite would let spawnSync return and the SIGTERM handler run. It does not: this loop is
 * synchronous, and a Node signal handler only runs when the event loop gets a turn — which a
 * `for` of spawnSync calls never gives it. The group kill took the running suite down, spawnSync
 * returned, and the loop started the NEXT entry; watched at 12:56 with a fresh suite 47 seconds
 * old under a "stopped" harness. Worse, a killed suite exits non-zero, so every entry cut short
 * that way would have been recorded as CAUGHT.
 *
 * So the loop checks for itself, between entries and after each suite:
 *   - a STOP FILE, `test/.mutation-stop`, which is how to ask it to stop;
 *   - a suite that died by SIGNAL, which is not a verdict and ends the batch. */
const STOP = join(REPO, 'test', '.mutation-stop');
rmSync(STOP, { force: true });
let stoppedBy = null;
try {
  for (const m of chosen) {
    if (existsSync(STOP)) { stoppedBy = 'stop file'; break; }
    const edits = editsOf(m);
    if (edits.some((e) => !existsSync(e.file))) {
      results.push({ ...m, verdict: 'skip', note: 'file missing' }); continue;
    }
    /* adapter.py is imported INTO the gateway process, so reloading it means restarting that
     * process. The live one is not ours to restart — so these run against a SCOPED instance with
     * its own HERMES_HOME, ports and plugin copy (test/lib/scoped-gateway.mjs). The file mutated
     * is that copy: the production adapter is never touched at all. */
    if (m.scope === 'gateway' && !scopedUp) {
      const livePidBefore = liveGatewayPid();
      setupScopedHome({ log: (msg) => console.log(`  [scoped] ${msg}`) });
      const started = startScoped({ log: (msg) => console.log(`  [scoped] ${msg}`) });
      if (!started.ok) {
        results.push({ ...m, verdict: 'BLOCKED', note: `scoped gateway did not start: ${started.note}` });
        console.log(`  BLOCKED ${m.suite.padEnd(24)} scoped gateway did not start`);
        console.log((started.tail || logTail(started.logPath) || '').split('\n').slice(-12).join('\n'));
        continue;
      }
      scopedUp = { livePidBefore };
      console.log(`  [scoped] up; live gateway pid ${livePidBefore} (must be unchanged at the end)`);
    }

    const originals = edits.map((e) => ({ ...e, src: readFileSync(e.file, 'utf8') }));
    const stale = originals.filter((o) => !o.src.includes(o.from));
    if (stale.length) {
      results.push({ ...m, verdict: 'STALE',
        note: `the mutation target no longer exists in ${stale.map((o) => o.file.split('/').pop()).join(', ')}` });
      continue;
    }
    /* Apply edits GROUPED BY FILE, accumulating.
     *
     * Writing each edit from its own snapshot of the original meant two edits to the SAME file
     * clobbered each other — only the last survived, and the entry reported MISSED on a mutation
     * that works perfectly when applied by hand. surface-live's multi-edit passed only because
     * its two edits happen to be in different files, so the bug stayed invisible.
     *
     * Found on frames, whose defence-in-depth claim needs two edits in proto.js. */
    {
      const byFile = new Map();
      for (const o of originals) {
        if (!byFile.has(o.file)) byFile.set(o.file, o.src);
        byFile.set(o.file, byFile.get(o.file).replace(o.from, o.to));
      }
      for (const [file, content] of byFile) writeFileSync(file, content);
    }
    const restoreEdits = () => { for (const o of originals) { try { writeFileSync(o.file, o.src); } catch {} } };
    /* Purge the bytecode cache. Python will happily load a __pycache__ .pyc compiled from the
     * UNMUTATED source, so the mutation silently does nothing and the suite is recorded as
     * MISSED — which is what happened to tts-failfast: it was CAUGHT when run alone and MISSED
     * in sequence, because an earlier iteration had left a cached adapter behind. A mutation
     * harness that cannot guarantee the mutation took effect is worse than none, since its
     * false MISSES send you auditing tests that are fine. */
    for (const e of edits) {
      try { rmSync(join(dirname(e.file), '__pycache__'), { recursive: true, force: true }); } catch {}
    }
    /* The sidecar and adapter are RUNNING processes. Editing their source changes nothing until
     * the gateway reloads them, so an e2e mutation without this restart would test the
     * unmutated code and record a false MISS — the live-process equivalent of stale bytecode. */
    if (m.scope === 'gateway') {
      /* Restart the SCOPED gateway so it imports the mutated adapter. Our own child process,
       * stopped and started by us — no launchd, no label, nothing production-adjacent. */
      stopScoped({});
      const again = startScoped({});
      if (!again.ok) {
        restoreEdits();
        results.push({ ...m, verdict: 'BLOCKED', note: `scoped restart failed: ${again.note}` });
        console.log(`  BLOCKED ${m.suite.padEnd(24)} scoped restart failed: ${again.note}`);
        continue;
      }
    } else if (m.restart) {
      const rl = reloadSidecar();
      if (!rl.ok) {
        /* A reload that did not happen means the suite would run against UNMUTATED code and be
         * recorded as MISSED — a false negative that sends you auditing a test that is fine.
         * Say so instead. */
        restoreEdits();
        results.push({ ...m, verdict: 'BLOCKED', note: `sidecar reload failed: ${rl.note}` });
        console.log(`  BLOCKED ${m.suite.padEnd(24)} sidecar reload failed: ${rl.note}`);
        continue;
      }
    }
    const r = spawnSync('npm', ['run', '-s', m.suite],
      { cwd: REPO, encoding: 'utf8', timeout: 900000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AGENTMOB_UNDER_MUTATION: '1',
               ...(m.scope === 'gateway' ? { AGENTMOB_WS_URL: SCOPED_WS_URL } : {}) } });
    restoreEdits();
    if (m.scope === 'gateway') { stopScoped({}); startScoped({}); }
    else if (m.restart) reloadSidecar();
    /* A suite killed by a signal did not fail an assertion — it was stopped. Recording that as
     * CAUGHT would put a verdict in the table that nothing measured. */
    if (r.signal || r.status === null) {
      stoppedBy = `suite for "${m.why}" was killed by ${r.signal || 'a signal'}`;
      results.push({ ...m, verdict: 'STOPPED', note: stoppedBy });
      console.log(`  STOPPED ${m.suite.padEnd(24)} ${stoppedBy} — not a verdict`);
      break;
    }
    const failed = r.status !== 0;
    const n = (r.stdout || '').match(/(\d+) (?:passed|failed)/g) || [];
    /* WHICH assertions broke, not just that something did.
     *
     * "the suite failed" is a weaker fact than it looks. A mutation can break a PRECONDITION —
     * my own mute-midreply entry sat on SILENCE_MS, so it stopped the utterance ever closing and
     * the suite failed at "the sidecar transcribed the utterance", never reaching the mute claim
     * it was supposed to guard. The table read CAUGHT and the mute behaviour was untested.
     *
     * So an entry may declare `breaks`: a substring of the assertion it must take down. If the
     * suite fails on something else, that is WRONG-CLAIM — caught, but not the thing claimed. */
    const failedLines = (r.stdout || '').split('\n')
      .filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim().replace(/^FAIL\s*/, ''));
    let verdict = failed ? 'CAUGHT' : 'MISSED';
    let claimNote = '';
    if (failed && m.breaks) {
      const hit = failedLines.some((l) => l.includes(m.breaks));
      if (!hit) {
        verdict = 'WRONG-CLAIM';
        claimNote = `expected to break "${m.breaks}" but the failures were: `
          + (failedLines.slice(0, 3).map((l) => l.slice(0, 70)).join(' | ') || '(none named)');
      }
    }
    results.push({ ...m, verdict, note: [n.join(' '), claimNote].filter(Boolean).join(' — '),
                   failedLines });
    console.log(`  ${verdict.padEnd(11)} ${m.suite.padEnd(24)} (${m.why})`);
    if (claimNote) console.log(`              ${claimNote}`);
    /* Print WHICH assertion fell. Without this the operator sees "CAUGHT" and has to take on
     * faith that it broke something that matters — and it is also the raw material for filling
     * in an entry's `breaks` field from observation rather than from a guess. */
    else if (failed && failedLines.length) {
      console.log(`              broke: ${failedLines[0].slice(0, 90)}`);
    }
  }
} finally {
  restoreAll();
  if (scopedUp) {
    stopScoped({ log: (msg) => console.log(`  [scoped] ${msg}`) });
    /* The whole point of the scoped instance: prove production never moved. */
    const after = liveGatewayPid();
    const same = after === scopedUp.livePidBefore;
    console.log(`  [scoped] live gateway pid ${scopedUp.livePidBefore} -> ${after} `
      + `${same ? '(UNCHANGED)' : '!! CHANGED — the production gateway restarted'}`);
    if (!same) livePidMoved = true;
  }
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
const wrongClaim = results.filter((r) => r.verdict === 'WRONG-CLAIM');
const missed = results.filter((r) => r.verdict === 'MISSED');
const stale = results.filter((r) => r.verdict === 'STALE');
const caught = results.filter((r) => r.verdict === 'CAUGHT');
if (stoppedBy) {
  console.log(`\nSTOPPED EARLY (${stoppedBy}) after ${results.length} of ${chosen.length} entries. `
    + 'The counts below are a PARTIAL table and must not be quoted as a full run.');
}
console.log(`\n${caught.length} caught, ${missed.length} MISSED, ${stale.length} stale, `
  + `${blocked.length} blocked, ${wrongClaim.length} wrong-claim, of ${results.length}`);
for (const r of wrongClaim) console.log(`  WRONG-CLAIM: ${r.suite} — ${r.note}`);
for (const r of blocked) console.log(`  BLOCKED: ${r.suite} — ${r.note}`);
for (const r of missed) console.log(`  MISSED: ${r.suite} — passed with "${r.why}" deleted; it is asserting on scaffolding`);
for (const r of stale) console.log(`  STALE : ${r.suite} — ${r.note}`);
/* BLOCKED fails the run: it means the harness could not guarantee the mutation took effect, and a
 * mutation that may not have applied produces a MISSED that sends you auditing a test that is
 * fine. There is deliberately no softer "not run" verdict any more — the scoped instance removed
 * the case that needed one, and a verdict nothing can emit is scaffolding. */
process.exit(stoppedBy ? 5 : !clean || livePidMoved || missed.length || stale.length || blocked.length
  || wrongClaim.length ? 1 : 0);
