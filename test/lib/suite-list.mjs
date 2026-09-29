/**
 * suite-list — the one place that says which npm scripts are NOT test suites.
 *
 * This list existed TWICE: as UTILITIES in mutation-coverage (which demands a mutation entry for
 * anything not on it) and as SKIP in run-suite (which would otherwise try to execute a watcher
 * and hang). I wrote a comment in run-suite claiming the two were "kept in sync by asserting
 * below, so they cannot drift apart silently" — and never wrote that assertion. The comment
 * asserted a guarantee that did not exist, which is precisely the defect this whole sweep has
 * been about, sitting in my own code.
 *
 * A shared module beats an assertion: drift is now impossible by construction rather than
 * detected after the fact. Add a utility here and both the gate and the runner see it.
 *
 * Each entry carries a REASON, because "it is not a suite" is a judgement and an unexplained one
 * is indistinguishable from an oversight.
 */
export const UTILITIES = {
  gateway: 'runs the dev gateway; not a test',
  'device-watch': 'a long-running watcher that waits for a phone to connect',
  'device-verify': 'the on-device run; blocked on hardware and asserts nothing without it',
  'device-arm': 'device-verify with a long unattended wait; same code, no assertions of its own',
  'device-handoff': 'the arming loop that waits for the phone and then spawns device-verify. '
    + 'It asserts nothing itself — its DECISIONS (the probe schedule, which passes to run, and '
    + 'a verdict that cannot read as a pass when nothing appeared) live in lib/handoff.mjs and '
    + 'are covered by the handoff suite',
  'dead-predicates': 'a detector, not a suite: it removes each guard conjunct in the libs and '
    + 'reports which ones no assertion can tell from their absence. It asserts nothing '
    + 'itself — mutating it would only test the test',
  'ctrlbar-shot': 'renders screenshots for a human to look at; makes no assertions',
  'ice-candidates': 'a reachability report; exits 0 by design whatever it finds',
  'vendor-refresh': 'copies the installed plugin into vendor/; one-way, no assertions',
  mutation: 'the mutation harness itself',
  suite: 'the suite runner; it executes the others and asserts nothing of its own',
  'mutation-coverage': 'this gate itself; mutating it would only test the test',
};

/** Names only, for callers that just need to skip them. */
export const UTILITY_NAMES = new Set(Object.keys(UTILITIES));

/**
 * Refuse to run a suite while a mutation run is live.
 *
 * A suite run beside the harness reads whatever file the harness has mutated at that moment and
 * reports it as the code's behaviour. That happened: a "connected to ONCE" failure took twenty
 * minutes to trace, and it was the harness's entry #5 applied to the file, not a regression.
 */
export async function refuseDuringMutation(repo) {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const lock = join(repo, 'test', '.mutation-running');
  if (!existsSync(lock)) return;
  let held = null;
  try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch { return; }
  try { process.kill(held.pid, 0); } catch { return; }       // stale lock: its process is gone
  if (String(process.env.AGENTMOB_UNDER_MUTATION || '') === '1') return;   // the harness itself
  console.error(`\nA MUTATION RUN IS LIVE (pid ${held.pid}) — files may be mutated right now, so `
    + `this suite's verdicts would describe the mutant, not the code.\n`
    + `Wait for it, or stop it: kill -TERM -${held.pgid}\n`);
  process.exit(4);
}
