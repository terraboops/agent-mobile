/**
 * dead-predicates — find guards that cannot fire, mechanically.
 *
 * WHY. Three have been shipped in this repo and all three were found the same way: a mutation
 * aimed at them came back MISSED, and only then did anyone read the line.
 *
 *   device-watch   `.replace(/\s*—.*$/, '')` after a `(\S+)` capture. The capture stops at the
 *                  space, so there was never anything to strip.
 *   adb-discover   a connect-over-pairing tie-break in a sort the pairing record never reaches,
 *                  because the filter above already dropped it.
 *   handoff        `!/^169\.254\./.test(a)` beside `isPrivateAddr(a)`, which admits only
 *                  10/8, 172.16/12 and 192.168/16 — so link-local could not get that far.
 *
 * All three READ like the guarantee. None of them were it.
 *
 * WHAT THIS DOES. For every conjunct in every guard in the libraries the suites exercise, it
 * removes that conjunct and runs the owning suite. If the suite still passes, no assertion
 * depends on that conjunct. That is not proof the code is dead — it may be live and untested —
 * but those are the same finding here: a predicate nothing can distinguish from its absence.
 *
 * It is a UTILITY, not a suite: it reports, it does not assert. Run it when adding a guard.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];

/* lib -> the suite that exercises it, from the mutation table's own mapping. */
const OWNERS = {
  'test/lib/adb-state.mjs': 'adb-state',
  'test/lib/adb-discover.mjs': 'adb-discover',
  'test/lib/ice-path.mjs': 'ice-path',
  'test/lib/lint-report.mjs': 'android-lint',
  'test/lib/device-probe.mjs': 'device-probe',
  'test/lib/font-stack.mjs': 'font-stack',
  'test/lib/manifest-facts.mjs': 'apk-installable',
  'test/lib/java-facts.mjs': 'java-mic',
  'test/lib/stage-select.mjs': 'stage-select',
  'test/lib/run-facts.mjs': 'run-facts',
  'test/lib/handoff.mjs': 'handoff',
  'test/lib/webview-baseline.mjs': 'webview-baseline',
  'test/lib/apk-facts.mjs': 'apk-installable',
  'test/lib/vendor-files.mjs': 'plugin-drift-soundness',
};

/**
 * Conjuncts worth testing: `X && Y` in a condition or return.
 * Each candidate is "drop this side, keep the other".
 */
function candidates(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//')) return;
    if (!/\s&&\s/.test(t)) return;
    /* Only whole-line guards, so the rewrite stays syntactically safe. */
    const m = /^(\s*)(?:if\s*\()?(.+?)(?:\)\s*\{?)?\s*;?$/.exec(line);
    if (!m) return;
    /* Split on top-level && only — parentheses and template braces must not be cut through. */
    const expr = m[2];
    const parts = [];
    let depth = 0, cur = '';
    for (let k = 0; k < expr.length; k++) {
      const c = expr[k];
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (depth === 0 && expr.startsWith('&&', k)) { parts.push(cur); cur = ''; k++; continue; }
      cur += c;
    }
    parts.push(cur);
    if (parts.length < 2) return;
    parts.forEach((p, idx) => {
      const kept = parts.filter((_, j) => j !== idx).join('&&');
      if (!kept.trim()) return;
      out.push({ line: i + 1, original: line, dropped: p.trim(),
                 mutated: line.replace(expr, kept) });
    });
  });
  return out;
}

const run = (suite) => spawnSync('npm', ['run', '-s', suite],
  { cwd: REPO, encoding: 'utf8', timeout: 20 * 60 * 1000 });

let checked = 0; const dead = [];
for (const [rel, suite] of Object.entries(OWNERS)) {
  if (only && !rel.includes(only) && suite !== only) continue;
  const abs = join(REPO, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  const cands = candidates(src);
  if (!cands.length) continue;
  console.log(`\n${rel}  (${suite})  ${cands.length} conjunct(s)`);
  const backup = `${abs}.deadpred-backup`;
  copyFileSync(abs, backup);
  try {
    for (const c of cands) {
      const mutated = src.split('\n');
      mutated[c.line - 1] = c.mutated;
      writeFileSync(abs, mutated.join('\n'));
      const r = run(suite);
      checked++;
      const survived = r.status === 0;
      console.log(`  ${survived ? 'DEAD?' : 'live '}  :${c.line}  drop \`${c.dropped.slice(0, 64)}\``);
      if (survived) dead.push({ rel, suite, line: c.line, dropped: c.dropped.trim() });
    }
  } finally {
    copyFileSync(backup, abs);
    rmSync(backup, { force: true });
  }
}

console.log(`\n${checked} conjunct(s) checked, ${dead.length} with no assertion behind them`);
for (const d of dead) console.log(`  ${d.rel}:${d.line}  (${d.suite})  ${d.dropped.slice(0, 90)}`);
if (!dead.length) console.log('  every guard conjunct is load-bearing for some assertion.');
