/**
 * port-in-use.test — the sidecar must fail BY NAME when its ports are taken.
 *
 * Both of the sidecar's listeners have had the same bug: an unhandled 'error' event killing the
 * process with a raw stack. The adapter respawns every 3 seconds, so the result is a log full of
 * identical stack traces and nothing saying why — and it happens at the worst possible moment,
 * when a stale instance is holding the port.
 *
 * That stale instance is a real state, not a hypothetical: **stopping the gateway does not stop
 * the sidecar**. `launchctl bootout` leaves it orphaned and still listening on 8123. This was
 * found by doing exactly that by accident.
 *
 * The two ports differ in what "handled" means, and the tests differ accordingly:
 *   - ctl (AGENTMOB_SIDECAR_PORT) is OPTIONAL — the sidecar must keep running without it.
 *   - ws  (AGENTMOB_PORT) IS the service — it cannot continue, but it must exit with a named
 *     reason and a distinguishable code, never a stack, so the respawn acts as the retry.
 *
 * Every assertion is written so it RED-lines without the guard: the old behaviour printed
 * "Emitted 'error' event on WebSocketServer instance" and exited 1.
 *
 * Run: npm run port-in-use
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SIDECAR = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
if (!existsSync(SIDECAR)) { console.log(`skip: no sidecar at ${SIDECAR}`); process.exit(0); }

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Occupy a port the way a stale sidecar does: a plain listener that just sits there. */
function hold(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer(() => {});
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** Start the real sidecar and watch it for `ms`. Returns stderr + how it ended. */
function runSidecar(env, ms) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SIDECAR], {
      env: { ...process.env, AGENTMOB_BIND: '127.0.0.1', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let out = '';
    p.stderr.on('data', (d) => { out += d.toString('utf8'); });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    p.on('exit', (code, signal) => finish({ out, exited: true, code, signal }));
    setTimeout(() => {
      if (!done) { const alive = p.exitCode === null; try { p.kill('SIGKILL'); } catch {}
        finish({ out, exited: !alive, code: null, alive: true }); }
    }, ms);
  });
}

/* A raw unhandled 'error' looks like this. Its ABSENCE is the point of the guard. */
const RAW_CRASH = /Emitted 'error' event|ERR_UNHANDLED_ERROR|^\s+at .*node:net/m;

/* ---- 1. the MAIN ws port is taken -> named exit, no stack -------------------------------- */
{
  const PORT = 8123, CTL = 8891;
  const holder = await hold(PORT);
  const r = await runSidecar({ AGENTMOB_PORT: String(PORT), AGENTMOB_SIDECAR_PORT: String(CTL) }, 8000);
  holder.close();

  ok('ws port in use: the sidecar exits rather than hanging', r.exited === true,
    r.alive ? 'still running with no listener — it would accept nothing' : '');
  ok('ws port in use: it does NOT die with a raw unhandled error', !RAW_CRASH.test(r.out),
    r.out.split('\n').find((l) => RAW_CRASH.test(l)) || '');
  ok('ws port in use: the log NAMES the port conflict',
    /FATAL: port 8123 is already in use/.test(r.out), r.out.trim().split('\n').pop() || '(no output)');
  ok('ws port in use: it explains the usual cause (an orphaned sidecar)',
    /orphan/i.test(r.out) && /stopping the gateway does NOT stop the sidecar/i.test(r.out));
  ok('ws port in use: it gives a command to clear it', /lsof -nP -iTCP:8123/.test(r.out));
  ok('ws port in use: exit code is distinguishable (69 EX_UNAVAILABLE, not 1)',
    r.code === 69, `exit ${r.code}`);
}

/* ---- 2. the OPTIONAL ctl port is taken -> keep serving ------------------------------------ */
{
  const PORT = 8892, CTL = 8890;
  const holder = await hold(CTL);
  const r = await runSidecar({ AGENTMOB_PORT: String(PORT), AGENTMOB_SIDECAR_PORT: String(CTL) }, 8000);
  holder.close();

  ok('ctl port in use: the sidecar KEEPS RUNNING (ctl is optional)', r.alive === true,
    `exited with ${r.code}`);
  ok('ctl port in use: no raw unhandled error', !RAW_CRASH.test(r.out));
  ok('ctl port in use: it says it is continuing without the ctl channel',
    /continuing WITHOUT the ctl channel|continuing without the ctl channel/i.test(r.out));
  ok('ctl port in use: the phone-facing server still came up',
    new RegExp(`ws://127\\.0\\.0\\.1:${PORT}`).test(r.out), r.out.trim().split('\n')[0] || '');
}

/* ---- 3. both free -> normal start, no scary words ---------------------------------------- */
{
  const r = await runSidecar({ AGENTMOB_PORT: '8889', AGENTMOB_SIDECAR_PORT: '8888' }, 7000);
  ok('both ports free: the sidecar runs', r.alive === true, `exited with ${r.code}`);
  ok('both ports free: no FATAL in the log', !/FATAL/.test(r.out));
  ok('both ports free: ctl listens', /ctl listening/.test(r.out));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
