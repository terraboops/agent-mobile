/**
 * identity-pin.test — the allowlist gate, exercised against a live AEAD handshake.
 *
 * WHY THIS IS THE WEAKEST CLAIM LEFT. The acceptance item `identity-pinning` is about the phone
 * presenting client_id 42c55608 so `allowed_clients` can be pinned to it. Its host proof was
 * entirely about the INSTALLER — debug-keystore signed, so `adb install -r` replaces in place and
 * does not rotate the identity. True, and beside the point: nothing exercised the thing pinning
 * actually depends on, which is that the sidecar ADMITS the pinned client and REJECTS everything
 * else.
 *
 * AGENTMOB_ALLOWED_CLIENTS is unset in production, so that gate has never run in anger. The
 * moment it is pinned it becomes the single point that can lock the handset out of its own
 * gateway — a config typo there is indistinguishable, from the phone, from the gateway being
 * down. proto.js's `allow` callback is unit-covered by the pairing suite; the chain around it
 * (config -> adapter -> env -> sidecar _allowSet -> serverHandshake) was not covered anywhere.
 *
 * Three directions, each a real handshake over a real socket:
 *   1. allowlist = a KNOWN-WRONG id  -> REJECTED, and specifically with `unknown_client`
 *   2. allowlist = the id the client presents -> COMPLETES
 *   3. allowlist removed             -> the same client that was rejected now COMPLETES
 *
 * Direction 3 is the red-proof: it shows the rejection in (1) came from the gate and not from
 * some unrelated breakage, which a rejection test on its own can never distinguish.
 *
 * SAFETY. Everything runs on the SCOPED gateway (its own HERMES_HOME, ports, plugin copy). The
 * production config is never written, and nothing is pinned to 42c55608 — that value belongs to
 * the handset and may only be pinned after a confirmed connection from it. This proves the
 * MECHANISM, not the value.
 *
 * Slow by nature: each direction restarts the scoped gateway. Run: npm run identity-pin
 */
import { genIdentity, identityId } from '../proto.js';
import { AgentStream } from '../transport/ws-client.mjs';
import { setupScopedHome, startScoped, stopScoped, liveGatewayPid, SCOPED_WS_URL, logTail,
         SCOPED_ADAPTER } from './lib/scoped-gateway.mjs';
import { existsSync } from 'node:fs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

/* ONE identity for the whole run, so "rejected" and "accepted" are the same client and the only
 * variable is the allowlist. A fresh identity per attempt would make direction 3 meaningless. */
const identity = genIdentity();
const CLIENT_ID = identityId(identity);
const WRONG_ID = CLIENT_ID === 'deadbeef' ? 'feedface' : 'deadbeef';

const livePidBefore = liveGatewayPid();
console.log(`client id under test: ${CLIENT_ID}`);
console.log(`live gateway pid ${livePidBefore} (must be unchanged at the end)\n`);

const cleanup = [];
const finish = (code = 0) => {
  for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
  const after = liveGatewayPid();
  const same = after === livePidBefore;
  console.log(`\nlive gateway pid ${livePidBefore} -> ${after} `
    + `${same ? '(UNCHANGED)' : '!! CHANGED — production was restarted'}`);
  if (!same) fails.push('the production gateway was restarted');
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length || code) process.exit(1);
  console.log('ALL PASS');
  process.exit(0);
};
process.on('uncaughtException', (e) => { console.error(e); finish(1); });
cleanup.push(() => stopScoped({}));

/** Bring the scoped gateway up with a given allowlist. */
function bringUp(allowedClients, label) {
  console.log(`\n--- ${label} ---`);
  stopScoped({});
  /* configOnly once the plugin copy exists: only the ALLOWLIST changes between directions, and
   * re-rsyncing the plugin would overwrite a mutation applied to the scoped copy with the
   * pristine live file — recording a false MISS and quietly pushing anyone who wanted a working
   * mutation towards editing the LIVE plugin instead. */
  setupScopedHome({ allowedClients, configOnly: existsSync(SCOPED_ADAPTER),
                    log: (m) => console.log(`  [scoped] ${m}`) });
  const r = startScoped({ log: (m) => console.log(`  [scoped] ${m}`) });
  if (!r.ok) {
    ok(`the scoped gateway started (${label})`, false,
      `${r.note}\n${(r.tail || logTail(r.logPath) || '').split('\n').slice(-10).join('\n')}`);
    finish(1);
  }
  return r;
}

/**
 * Attempt a real handshake with our fixed identity.
 * @returns {{connected: boolean, error: string|null}}
 */
async function attempt() {
  const s = new AgentStream({ url: SCOPED_WS_URL, identity, onPair: async () => true });
  try {
    await s.connect();
    try { s.close?.(); } catch {}
    return { connected: true, error: null };
  } catch (e) {
    try { s.close?.(); } catch {}
    return { connected: false, error: String((e && e.message) || e) };
  }
}

/* ---- 1. a known-wrong allowlist must REJECT, and say why ------------------------------------ */
bringUp(WRONG_ID, `allowlist pinned to a WRONG id (${WRONG_ID})`);
const rejected = await attempt();
console.log(`  handshake: ${rejected.connected ? 'CONNECTED' : `rejected — ${rejected.error}`}`);
ok('a client not on the allowlist is REJECTED', !rejected.connected,
  'the handshake completed against an allowlist that does not contain this client — the gate is '
  + 'not enforcing, and pinning would give a false sense of restriction');
/* The specific reason matters. A hang, a timeout, or a generic close would be operationally
 * indistinguishable from the gateway being down, which is exactly the confusion that makes a
 * mis-pinned allowlist so expensive to diagnose from a phone. */
ok('the rejection names unknown_client, not a generic failure',
  /unknown_client/.test(rejected.error || ''),
  `got: ${rejected.error} — a phone seeing this cannot tell "you are not pinned" from "the `
  + 'gateway is down"');

/* ---- 2. the RIGHT id must COMPLETE ----------------------------------------------------------
 * Without this, direction 1 is satisfied by a gate that rejects everyone. */
bringUp(CLIENT_ID, `allowlist pinned to the client's OWN id (${CLIENT_ID})`);
const admitted = await attempt();
console.log(`  handshake: ${admitted.connected ? 'CONNECTED' : `rejected — ${admitted.error}`}`);
ok('the pinned client is ADMITTED', admitted.connected,
  `${admitted.error} — the allowlist rejects the very id it was pinned to, which would lock the `
  + 'handset out of its own gateway');

/* ---- 3. RED-PROOF: remove the allowlist and the same client gets in ------------------------- */
bringUp(null, 'allowlist REMOVED (pairing mode)');
const unpinned = await attempt();
console.log(`  handshake: ${unpinned.connected ? 'CONNECTED' : `rejected — ${unpinned.error}`}`);
ok('with the allowlist removed, the previously-rejected client CONNECTS', unpinned.connected,
  `${unpinned.error} — if this also fails, the rejection in direction 1 proved nothing about the `
  + 'allowlist; something else was breaking the handshake');

finish(0);
