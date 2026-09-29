// pairing.test.mjs — the CLIENT ALLOWLIST gate (pinning the phone's identity).
//
// The sidecar ships in PAIRING MODE by default: AGENTMOB_ALLOWED_CLIENTS unset
// means `allow` is null and serverHandshake accepts ANY client that can speak
// v2. That is correct for first pairing and wrong to leave running — anything
// that reaches the port gets a live agent channel (mic uplink, surface ops).
//
// These cases pin down the gate itself, so enabling it cannot silently fail
// open, and so a wrong-format pin (the realistic operator mistake) is a LOUD
// failure rather than a phone that mysteriously stops connecting.
import { genIdentity, identityId, clientHello, serverHandshake, clientFinish, verifyConfirm } from '../proto.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// The allowlist the sidecar builds from AGENTMOB_ALLOWED_CLIENTS: it accepts
// EITHER the 8-hex short id or the base64 SPKI. Mirrored here exactly.
const buildAllow = (csv) => {
  const set = new Set(String(csv || '').split(',').map((x) => x.trim()).filter(Boolean));
  return set.size ? (pub, id) => set.has(id) || set.has(Buffer.from(pub).toString('base64')) : null;
};

const server = genIdentity();
const phone = genIdentity();
const stranger = genIdentity();
const phoneId = identityId(phone);
const phoneSpki = Buffer.from(phone.publicKey).toString('base64');

// A full round trip, so "accepted" means a usable channel, not just no throw.
function connect(clientIdentity, allow) {
  const eph = genIdentity();
  const hello = clientHello(clientIdentity, eph);
  const hs = serverHandshake(server, hello, { allow });
  const fin = clientFinish(clientIdentity, eph, hello, hs.reply, { expectServerIdentity: server.publicKey });
  if (!verifyConfirm(hs.expectedConfirm, fin.confirm)) throw new Error('confirm_failed');
  return { hs, fin };
}

console.log('\npairing — client allowlist gate');

// 1. No allowlist = pairing mode: any client gets in. Documents the default.
ok(connect(stranger, buildAllow('')).hs.clientId.length === 8,
  'PAIRING MODE (unset) accepts an unknown client — this is the shipping default');

// 2. Pinned by short id: the phone gets in, a stranger does not.
{
  const allow = buildAllow(phoneId);
  ok(connect(phone, allow).hs.clientId === phoneId, 'pinned by short id: the phone connects');
  ok(threw(() => connect(stranger, allow), /unknown_client/), 'pinned by short id: a stranger is rejected as unknown_client');
}

/* THE MIRROR MUST MATCH THE SHIPPED CODE.
 *
 * buildAllow above is a REIMPLEMENTATION of the sidecar's allowlist, and the comment says
 * "mirrored here exactly" — which is exactly the drift hazard this project has already been
 * bitten by once (device-stages was exercising its own copy of the gateway-log helpers). A
 * mirror that drifts proves the mirror works and says nothing about what ships: mutating the
 * sidecar's allowlist could not fail this suite at all.
 *
 * So compare against the source. Not elegant, but it fails the moment the shipped line changes
 * shape, which is the only thing that makes the cases below evidence about the product. */
{
  const shipped = readFileSync(
    join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs'), 'utf8');
  const line = (/const clientAllow = [\s\S]{0,200}?;\n/.exec(shipped) || [''])[0];
  ok(/_allowSet\.has\(id\)/.test(line) && /_allowSet\.has\(Buffer\.from\(pub\)\.toString\('base64'\)\)/.test(line),
    'the mirrored allowlist matches the shipped one (id OR base64 SPKI)',
    `shipped:\n       ${line.trim().replace(/\n/g, '\n       ')}\n`
    + '       buildAllow above no longer reflects the sidecar — the cases below would be '
    + 'testing a local copy and nothing that ships');
}

// 3. Pinned by base64 SPKI: same outcome (the log line prints this form).
{
  const allow = buildAllow(phoneSpki);
  ok(connect(phone, allow).hs.clientId === phoneId, 'pinned by SPKI: the phone connects');
  ok(threw(() => connect(stranger, allow), /unknown_client/), 'pinned by SPKI: a stranger is rejected');
}

// 4. Several pins coexist (phone + a laptop client), whitespace tolerated.
{
  const laptop = genIdentity();
  const allow = buildAllow(` ${phoneId} , ${identityId(laptop)} `);
  ok(connect(phone, allow).hs.clientId === phoneId, 'multi-entry list: phone connects');
  ok(connect(laptop, allow).hs.clientId === identityId(laptop), 'multi-entry list: second device connects');
  ok(threw(() => connect(stranger, allow), /unknown_client/), 'multi-entry list: stranger still rejected');
}

// 5. Operator mistakes must FAIL CLOSED (lock out), never fail open. If any of
//    these accepted the stranger, a typo would silently disable the allowlist.
for (const [label, csv] of [
  ['uppercased id', phoneId.toUpperCase()],
  ['truncated id', phoneId.slice(0, 6)],
  ['SPKI without padding', phoneSpki.replace(/=+$/, '')],
  ['a comment/typo entry', 'the-phone'],
]) {
  const allow = buildAllow(csv);
  ok(allow !== null, `${label}: still builds a gate (not treated as unset)`);
  ok(threw(() => connect(stranger, allow), /unknown_client/), `${label}: stranger rejected (fails closed)`);
}
// The realistic consequence of those typos, stated once: the PHONE is locked out too.
ok(threw(() => connect(phone, buildAllow(phoneId.toUpperCase())), /unknown_client/),
  'a case-wrong pin locks out the phone as well — copy the id verbatim from the PAIRING log line');

// 6. The gate runs BEFORE any channel exists: a rejected client gets no keys.
{
  const allow = buildAllow(phoneId);
  const eph = genIdentity();
  const hello = clientHello(stranger, eph);
  let hs = null;
  try { hs = serverHandshake(server, hello, { allow }); } catch (_) {}
  ok(hs === null, 'a rejected client never receives a reply or a channel');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
