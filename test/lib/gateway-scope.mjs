/**
 * gateway-scope — nothing in this test suite may restart the production gateway.
 *
 * WHY THIS FILE EXISTS. `test/mutation.mjs` used to call
 *
 *     launchctl kickstart -k gui/<uid>/ai.hermes.gateway
 *
 * on every mutation marked `restart: true`, so that a mutated adapter or sidecar would be the
 * code actually running. That label is the LIVE gateway — Terra's Telegram, her phone bridge,
 * and every cron job on this machine. One night's mutation runs bounced it about fourteen times.
 * The observed cost, in her words: in-flight cron work killed mid-write and recorded as a
 * failure, the phone bridge dropped mid-conversation, and the lifecycle ledger recording an
 * unclean exit with no exit path run. The mutation table is worth having. That is not.
 *
 * The harness had `catch {}` around the kickstart, with the comment "not running under launchd
 * here" — so the one place that could have surfaced the problem swallowed it. Every refusal here
 * THROWS instead, and mutation.mjs lets it propagate into the run's output.
 *
 * Two replacement mechanisms, because the two mutated files have different lifetimes:
 *
 *   sidecar/index.mjs  is a CHILD PROCESS the adapter spawns and already respawns on death
 *                      (_run_sidecar loops on returncode). Killing that one process reloads the
 *                      mutated source, and the gateway is never signalled. reloadSidecar() below.
 *
 *   adapter.py         is imported INTO the gateway process. Reloading it means restarting that
 *                      process, and there is no version of that which is safe to do to the live
 *                      one. Those mutations need a scoped gateway — its own HERMES_HOME, its own
 *                      ports, started and stopped by the test — and until that exists they are
 *                      reported as a NAMED PRECONDITION rather than run. See needsScopedGateway.
 */
import { spawnSync, execFileSync } from 'node:child_process';

/** The production launchd label. Never ours to restart, under any flag. */
export const LIVE_LABEL = 'ai.hermes.gateway';

/** Opt-in for kickstarting ANY label. Absent = refuse. */
export const KICKSTART_OPT_IN = 'AGENTMOB_ALLOW_GATEWAY_KICKSTART';

/**
 * The guard. Throws unless BOTH hold:
 *   - the label is not the live gateway (no env var unlocks this — part 1 is "never the label")
 *   - the caller has explicitly opted in to kickstarting anything at all
 *
 * @param {string} label  launchd label the caller wants to kickstart
 */
export function assertKickstartAllowed(label, env = process.env) {
  if (!label || typeof label !== 'string') {
    throw new Error('gateway-scope: refusing a kickstart with no label');
  }
  /* Matched as a substring, not equality: `gui/501/ai.hermes.gateway` is the form actually
   * passed to launchctl, and an equality check on the bare label would have let it through. */
  if (label.includes(LIVE_LABEL)) {
    throw new Error(
      `gateway-scope: REFUSED — "${label}" is the live gateway (${LIVE_LABEL}).\n`
      + '  Restarting it kills in-flight cron work mid-write, drops the phone bridge '
      + 'mid-conversation,\n'
      + '  and records an unclean exit with no exit path run. No environment variable unlocks '
      + 'this.\n'
      + '  Restart-resilience testing needs its own instance: a throwaway HERMES_HOME, its own '
      + 'port,\n'
      + '  started and stopped by the test. See test/lib/gateway-scope.mjs.');
  }
  if (env[KICKSTART_OPT_IN] !== '1') {
    throw new Error(
      `gateway-scope: REFUSED — kickstarting "${label}" requires ${KICKSTART_OPT_IN}=1.\n`
      + '  The default path must not be able to restart a gateway even by accident.');
  }
  return true;
}

/** Is the sidecar listening? The only liveness signal that matters to the e2e suites. */
export function sidecarListening(port = 8123) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout || '').includes('LISTEN');
}

/** PIDs of the agentmob sidecar, found by its command line rather than a pidfile. */
export function sidecarPids() {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n')
    .filter((l) => /agentmob\/sidecar\/index\.mjs/.test(l) && !/\bgrep\b/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Reload a mutated sidecar WITHOUT touching the gateway.
 *
 * SIGTERM the sidecar child; the adapter's own supervisor notices returncode is set and respawns
 * it from source. This exercises the respawn path rather than bypassing it, and the gateway
 * process, its cron jobs and its other platform connections are never signalled.
 *
 * Scope of the disruption, stated plainly: the agentmob AEAD channel drops for the few seconds
 * the respawn takes, so a phone connected at that moment reconnects. That is the component under
 * test. Nothing else on the machine is affected.
 *
 * @returns {{ok: boolean, note: string}}
 */
export function reloadSidecar({ port = 8123, timeoutMs = 90000 } = {}) {
  const before = sidecarPids();
  if (!before.length) {
    /* Nothing running is not an error: the adapter spawns one when the gateway has it loaded.
     * Wait for a listener rather than declaring failure. */
    return waitForSidecar({ port, timeoutMs, note: 'no sidecar was running; waited for one' });
  }
  for (const pid of before) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + timeoutMs;
  /* Wait for the OLD pid to go AND a listener to come back. Checking only the listener would
   * pass instantly on the dying process's socket, which is exactly the false-green that stale
   * bytecode and stale processes produced before. */
  while (Date.now() < deadline) {
    const now = sidecarPids();
    const replaced = now.length > 0 && now.every((p) => !before.includes(p));
    if (replaced && sidecarListening(port)) {
      spawnSync('sleep', ['3']);  // let the WS server finish binding before a client connects
      return { ok: true, note: `sidecar ${before.join(',')} -> ${now.join(',')}` };
    }
    spawnSync('sleep', ['1']);
  }
  return { ok: false, note: `sidecar did not come back within ${timeoutMs}ms (was ${before.join(',')})` };
}

function waitForSidecar({ port, timeoutMs, note }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sidecarPids().length && sidecarListening(port)) return { ok: true, note };
    spawnSync('sleep', ['1']);
  }
  return { ok: false, note: `${note}: none appeared within ${timeoutMs}ms` };
}
