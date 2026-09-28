/**
 * gateway-scope.test — the suite must not be able to restart the production gateway.
 *
 * The harness used to kickstart `ai.hermes.gateway` on every restart-marked mutation, and it
 * wrapped the call in `catch {}`, so the one place that could have reported it stayed quiet
 * through about fourteen production bounces in a night. Cron work died mid-write, the phone
 * bridge dropped mid-conversation, and the lifecycle ledger recorded unclean exits.
 *
 * A fix that lives only in a comment is one refactor away from being undone. Two kinds of claim
 * here, because a guard and a codebase fail differently:
 *
 *   BEHAVIOUR  assertKickstartAllowed refuses, and refuses by THROWING so the refusal lands in
 *              test output rather than being swallowed.
 *   STATIC     no file under test/ actually executes launchctl, whatever it says in prose.
 *
 * The static half is the one that survives someone re-adding the convenience later.
 *
 * Run: npm run gateway-scope
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKickstartAllowed, LIVE_LABEL, KICKSTART_OPT_IN, needsScopedGateway,
         sidecarPids, scopedGatewayPrecondition } from './lib/gateway-scope.mjs';
import { codeOnly } from './lib/code-only.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
/** Run fn and report what it threw, so "it refused" and "it returned false" cannot be confused. */
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/* ---- 1. the live label is refused, and no flag unlocks it -------------------------------- */
for (const label of [LIVE_LABEL, `gui/501/${LIVE_LABEL}`, `gui/${process.getuid()}/${LIVE_LABEL}`]) {
  const e = threw(() => assertKickstartAllowed(label, { [KICKSTART_OPT_IN]: '1' }));
  ok(`refuses "${label}" even with ${KICKSTART_OPT_IN}=1`, e instanceof Error,
    'the opt-in must not be an escape hatch for the production label');
  ok(`the refusal for "${label}" names the live gateway`,
    !!e && e.message.includes(LIVE_LABEL), e && e.message);
}
/* The cost is in the message on purpose: whoever trips this is mid-task and will not go read a
 * file to find out why it matters. */
{
  const e = threw(() => assertKickstartAllowed(LIVE_LABEL, { [KICKSTART_OPT_IN]: '1' }));
  ok('the refusal explains the cost (cron, phone bridge, unclean exit)',
    !!e && /cron/i.test(e.message) && /phone bridge/i.test(e.message) && /unclean exit/i.test(e.message),
    e && e.message);
}

/* ---- 2. any other label still needs an explicit opt-in ------------------------------------ */
{
  const scoped = 'gui/501/ai.hermes.gateway-test-scratch';
  ok('refuses a scratch label when the opt-in is absent',
    threw(() => assertKickstartAllowed(scoped, {})) instanceof Error,
    'the default path must not be able to kickstart anything');
  ok('refuses a scratch label when the opt-in is set to something other than 1',
    threw(() => assertKickstartAllowed(scoped, { [KICKSTART_OPT_IN]: 'yes' })) instanceof Error);
  /* NOTE this label contains the live label as a prefix, so it is ALSO refused by the substring
   * rule above. That is deliberate over-refusal: a name that close to production is not worth
   * the ambiguity. A genuinely separate name is the one that gets through. */
  const clean = 'gui/501/agentmob.test.gateway';
  ok('allows a clearly-separate label WITH the opt-in',
    threw(() => assertKickstartAllowed(clean, { [KICKSTART_OPT_IN]: '1' })) === null,
    'a scoped instance must still be startable, or the guard just blocks the fix');
  ok('refuses a missing label', threw(() => assertKickstartAllowed('', {})) instanceof Error);
  ok('refuses a non-string label', threw(() => assertKickstartAllowed(null, {})) instanceof Error);
}

/* ---- 3. THE STATIC CLAIM: nothing under test/ executes launchctl -------------------------- */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = join(dir, d.name);
  if (d.isDirectory()) return d.name === 'out' || d.name === 'node_modules' ? [] : walk(p);
  return /\.(mjs|js)$/.test(d.name) ? [p] : [];
});
const sources = walk(HERE);
ok('found the test sources to scan', sources.length > 10, `${sources.length} files`);

/* codeOnly strips comments, so the long explanations above do not read as violations. What is
 * left is a spawn/exec whose argv actually contains launchctl. */
const offenders = [];
for (const f of sources) {
  const code = codeOnly(readFileSync(f, 'utf8'), 'js');
  /* A call, not a mention: execFileSync('launchctl', ...) / spawnSync("launchctl" / exec(`launchctl */
  if (/(execFile|exec|spawn)\w*\s*\(\s*['"`]launchctl/.test(code)
      || /(execFile|exec|spawn)\w*\s*\(\s*['"`][^'"`]*\blaunchctl\b/.test(code)) {
    offenders.push(f.replace(HERE, 'test'));
  }
}
ok('no test file executes launchctl', offenders.length === 0,
  `${offenders.join(', ')} — restart-resilience needs a scoped instance, never the live label`);

/* And specifically the file that used to do it. */
{
  const mut = codeOnly(readFileSync(join(HERE, 'mutation.mjs'), 'utf8'), 'js');
  ok('the mutation harness no longer contains a kickstart call', !/kickstart/.test(mut),
    'test/mutation.mjs still has kickstart in executable code');
  const raw = readFileSync(join(HERE, 'mutation.mjs'), 'utf8');
  ok('the mutation harness reloads the sidecar instead', raw.includes('reloadSidecar('),
    'nothing reloads mutated sidecar source, so restart-marked mutations would test stale code');
  ok('the mutation harness refuses adapter mutations rather than restarting the gateway',
    raw.includes('needsScopedGateway('),
    'adapter.py is imported into the gateway process; those mutations must be named, not run');
}

/* ---- 4. the replacement mechanisms are wired to the right files ---------------------------- */
ok('adapter.py is classified as needing a scoped gateway',
  needsScopedGateway('/Users/x/.hermes/plugins/agentmob/adapter.py'));
ok('the sidecar is NOT classified as needing a scoped gateway',
  !needsScopedGateway('/Users/x/.hermes/plugins/agentmob/sidecar/index.mjs'),
  'it is a child process the adapter respawns; restarting the gateway for it is gratuitous');
ok('the precondition message names the suite and says it was not run',
  /NOT RUN/.test(scopedGatewayPrecondition('e2e-voice', '/x/adapter.py'))
  && /e2e-voice/.test(scopedGatewayPrecondition('e2e-voice', '/x/adapter.py')),
  'missing coverage has to be visible or it becomes the status quo');
ok('sidecarPids returns a list of integers', Array.isArray(sidecarPids())
  && sidecarPids().every((p) => Number.isInteger(p)));

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
