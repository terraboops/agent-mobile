/**
 * ice-config.test — the sidecar's ICE configuration contract.
 *
 * Covers the two levers added for remote-phone reachability:
 *   - AGENTMOB_ICE: comma-separated stun:/turn: urls, STUN-only by DEFAULT. A TURN entry may
 *     carry credentials inline (turn:user:pass@host:3478), which must be split into the
 *     RTCIceServer username/credential fields and must NEVER appear in a log line or in the
 *     `ice` list handed to the phone.
 *   - the tailnet host candidate: neither side enumerates the Tailscale utun on its own, so
 *     the sidecar advertises it explicitly or a REMOTE phone has no routable path.
 *
 * The sidecar lives outside this repo (gitignored), so it is exercised as a black box: spawn it
 * on spare ports and read the startup line it prints. That is the real binary, not a mock.
 *
 * NOTE: the ctl port env var is AGENTMOB_SIDECAR_PORT, NOT AGENTMOB_CTL_PORT. Getting that
 * wrong once made a scratch sidecar collide with the live one on 8790.
 *
 * Run: npm run ice-config
 */
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SIDECAR = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
if (!existsSync(SIDECAR)) {
  console.log(`skip: no sidecar at ${SIDECAR}`);
  process.exit(0);
}

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const hasTailnet = Object.values(networkInterfaces()).flat()
  .some((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal
    && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));

/**
 * Boot the real sidecar on spare ports and return its startup line.
 * Ports are well away from the live 8123/8790 so a run never disturbs the running gateway.
 */
function boot(env, { port = 8899, ctl = 8898 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SIDECAR], {
      env: { ...process.env, AGENTMOB_PORT: String(port), AGENTMOB_BIND: '127.0.0.1',
             AGENTMOB_SIDECAR_PORT: String(ctl), ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let buf = '';
    const done = (line) => { try { p.kill('SIGKILL'); } catch {} resolve({ line, all: buf }); };
    const timer = setTimeout(() => done(null), 15000);
    p.stderr.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/\[sidecar\] (agent id .*)$/m);
      if (m) { clearTimeout(timer); done(m[1]); }
    });
    p.on('error', () => { clearTimeout(timer); done(null); });
  });
}

/* ---- 1. default: STUN only, no relay, no spend ------------------------------------------ */
{
  const { line } = await boot({});
  ok('default: sidecar starts', !!line, 'no startup line');
  ok('default: STUN-only', !!line && /ice=stun:stun\.l\.google\.com:19302/.test(line), line);
  ok('default: no turn relay configured', !!line && !/turn:/i.test(line), line);
  ok('default: still PAIRING MODE (nothing pinned behind our back)',
    !!line && /PAIRING MODE/.test(line), line);
  if (hasTailnet) {
    ok('default: advertises the tailnet host candidate',
      !!line && /tailnet-ice=100\./.test(line), line);
  } else {
    console.log('  skip  tailnet assertions (no 100.64/10 address on this host)');
  }
}

/* ---- 2. inline TURN credentials are parsed, and never logged ---------------------------- */
{
  const SECRET = 'sup3rs3cret';
  const { line, all } = await boot({ AGENTMOB_ICE: `stun:stun.example:3478,turn:alice:${SECRET}@relay.example:3478` });
  ok('turn: sidecar starts with an inline-credential TURN url', !!line, 'no startup line');
  ok('turn: the relay url is kept', !!line && /turn:relay\.example:3478/.test(line), line);
  ok('turn: the stun entry is kept too', !!line && /stun:stun\.example:3478/.test(line), line);
  /* The whole reason credentials are split out of the url rather than passed through. */
  ok('turn: the CREDENTIAL never reaches the startup log', !!line && !line.includes(SECRET), line);
  ok('turn: the credential is nowhere in stderr at all', !all.includes(SECRET));
  ok('turn: the username is not logged either', !!line && !/alice/.test(line), line);
}

/* ---- 3. explicit opt-out of all ICE ------------------------------------------------------ */
{
  const { line } = await boot({ AGENTMOB_ICE: 'none' });
  ok('none: sidecar starts', !!line);
  /* Anchor on a word boundary: a bare /ice=/ also matches inside "tailnet-ice=", which is a
   * different field and legitimately still present here. */
  ok('none: no ice servers advertised', !!line && !/(^|\s)ice=/.test(line), line);
  ok('none: the tailnet candidate is independent of it', !!line && /tailnet-ice=/.test(line), line);
}

/* ---- 4. junk entries are dropped rather than crashing the sidecar ------------------------ */
{
  const { line } = await boot({ AGENTMOB_ICE: 'http://nope.example,stun:good.example:3478,,   ' });
  ok('junk: sidecar starts', !!line);
  ok('junk: the non-stun/turn entry is dropped', !!line && !/nope\.example/.test(line), line);
  ok('junk: the valid entry survives', !!line && /stun:good\.example:3478/.test(line), line);
}

/* ---- 5. the tailnet candidate can be opted out of ---------------------------------------- */
if (hasTailnet) {
  const { line } = await boot({ AGENTMOB_NO_TAILNET_ICE: '1' });
  ok('opt-out: sidecar starts', !!line);
  ok('opt-out: tailnet candidate suppressed', !!line && /tailnet-ice=none/.test(line), line);
} else {
  console.log('  skip  opt-out assertions (no tailnet address on this host)');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
