// handshake.test.mjs — prove the mutual key exchange + channel (protocol v2):
//   PASS: honest pair completes hello/reply/confirm and round-trips both ways
//   FAIL: server whose identity differs from the PIN is rejected (identity_mismatch)
//   FAIL: server that cannot produce the transcript MAC is rejected (mac_mismatch)
//   FAIL: client not on the allowlist is rejected (unknown_client)
//   FAIL: impostor confirm is rejected
//   FAIL: tampered frame / flipped type byte (AAD) / replayed frame are rejected
//   PASS: reordering inside the window is accepted; WS and UDP streams are independent
import { genIdentity, identityId, sessionFrom, clientHello, serverHandshake, clientFinish,
         verifyConfirm, STREAM_UDP, REPLAY_WINDOW } from '../proto.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const throwsWith = (fn, code) => { try { fn(); return false; } catch (e) { return e.message === code; } };

console.log('=== honest parties ===');
const idApp = genIdentity();
const idAgent = genIdentity();
console.log('  app id   ', identityId(idApp));
console.log('  agent id ', identityId(idAgent));

function handshake({ app = idApp, agent = idAgent, pin = agent.publicKey, allow = null } = {}) {
  const eph = genIdentity();
  const hello = clientHello(app, eph);
  const srv = serverHandshake(agent, hello, { allow });
  const cli = clientFinish(app, eph, hello, srv.reply, { expectServerIdentity: pin });
  const confirmed = verifyConfirm(srv.expectedConfirm, cli.confirm);
  return { appCh: cli.channel, agtCh: srv.channel, confirmed, srv, cli, hello, eph };
}

const h = handshake();
ok(h.confirmed, 'server verifies the client confirm MAC');
ok(h.cli.agentId === identityId(idAgent), 'client learns the agent fingerprint from the verified identity');
const { appCh, agtCh } = h;

const msg = 'BABEL<on id, you bail>';
ok(agtCh.recv(appCh.send(msg)) === msg, 'app->agent round-trip');
const reply = 'SLA p95 < 250ms';
ok(appCh.recv(agtCh.send(reply)) === reply, 'agent->app round-trip');

console.log('=== identity pinning / impostor server (MITM) ===');
const idImpostor = genIdentity();
// Impostor presents ITS OWN identity: the MAC verifies (it holds that key) but the
// pin does not match -> rejected before any frame is sent.
ok(throwsWith(() => handshake({ agent: idImpostor, pin: idAgent.publicKey }), 'identity_mismatch'),
  'server identity != pinned SPKI -> identity_mismatch');
// Impostor CLAIMS the real agent identity but cannot compute authKey -> bad MAC.
{
  const eph = genIdentity();
  const hello = clientHello(idApp, eph);
  const forged = serverHandshake(idImpostor, hello);
  forged.reply.server_identity = idAgent.publicKey.toString('base64');
  ok(throwsWith(() => clientFinish(idApp, eph, hello, forged.reply, { expectServerIdentity: idAgent.publicKey }), 'mac_mismatch'),
    'server claiming the pinned identity without its key -> mac_mismatch');
}
// TOFU (no pin) still requires a VALID mac for the presented identity.
{
  const eph = genIdentity();
  const hello = clientHello(idApp, eph);
  const srv = serverHandshake(idAgent, hello);
  srv.reply.mac = Buffer.alloc(32).toString('base64');
  ok(throwsWith(() => clientFinish(idApp, eph, hello, srv.reply, {}), 'mac_mismatch'), 'TOFU still rejects a bad server MAC');
}

console.log('=== client allowlist / impostor client ===');
const allowOnlyApp = (pub, id) => id === identityId(idApp);
ok(handshake({ allow: allowOnlyApp }).confirmed, 'allowlisted client accepted');
ok(throwsWith(() => handshake({ app: idImpostor, allow: allowOnlyApp }), 'unknown_client'), 'unknown client rejected by allowlist');
{
  // Impostor presents the REAL app identity but holds only its own ephemeral:
  // it cannot derive authKey -> its confirm fails, and it can't read frames.
  const eph = genIdentity();
  const hello = clientHello(idApp, eph);                         // claims idApp
  const srv = serverHandshake(idAgent, hello);
  const impCh = sessionFrom('client', idImpostor, { publicKey: idAgent.publicKey }, eph, Buffer.from(srv.reply.server_eph, 'base64'));
  const fakeConfirm = { v: 2, confirm: impCh.handshakeMac('client', Buffer.from('guess')).toString('base64') };
  ok(!verifyConfirm(srv.expectedConfirm, fakeConfirm), 'impostor client confirm rejected');
  ok(srv.channel.recv(impCh.send('i am your app')) === null, 'impostor client frames do not decrypt');
}

console.log('=== tamper / forge / AAD ===');
{
  const frame = appCh.send('integrity matters', 0);
  const ct = Buffer.from(frame.ct); ct[0] ^= 0x01;
  ok(agtCh.recv({ ...frame, ct }) === null, 'tampered ciphertext rejected (AEAD auth)');
  const nonce = Buffer.from(frame.nonce); nonce[11] ^= 0x01;
  ok(agtCh.recv({ ...frame, nonce }) === null, 'tampered nonce rejected');
  ok(agtCh.recv({ ...frame, type: 1 }) === null, 'flipped type byte rejected (type is AAD)');
  ok(agtCh.recv(frame) === 'integrity matters', 'untouched frame still accepted after failed forgeries');
}

console.log('=== replay / reorder / streams ===');
{
  const f = appCh.send('once', 0);
  ok(agtCh.recv(f) === 'once', 'fresh frame accepted');
  ok(agtCh.recv(f) === null && agtCh.rejected.replay >= 1, 'replayed frame rejected');
  const a = appCh.send('a'), b = appCh.send('b'), c = appCh.send('c');
  ok(agtCh.recv(c) === 'c' && agtCh.recv(a) === 'a' && agtCh.recv(b) === 'b', 'reorder inside the window accepted');
  ok(agtCh.recv(a) === null, 'replay of an in-window old frame rejected');
  // Too old: advance the window past REPLAY_WINDOW, then present an old frame.
  const old = appCh.send('old');
  for (let i = 0; i < REPLAY_WINDOW + 5; i++) agtCh.recv(appCh.send('x'));
  ok(agtCh.recv(old) === null, 'frame older than the window rejected');
  // UDP stream has its own counter + window: a big WS stall must not evict UDP.
  const u1 = appCh.send('udp1', 1, STREAM_UDP);
  for (let i = 0; i < REPLAY_WINDOW + 5; i++) agtCh.recv(appCh.send('ws', 0));
  ok(agtCh.recvBytes(u1).toString() === 'udp1', 'UDP stream unaffected by WS counter advance');
  ok(agtCh.recvBytes(u1) === null, 'UDP replay rejected');
  const w = appCh.send('ws-late', 0);
  ok(agtCh.recv({ ...w, nonce: Buffer.from(w.nonce) }) === 'ws-late', 'WS frame after UDP traffic accepted');
  ok(appCh.txCounter(0) > 0 && appCh.txCounter(STREAM_UDP) === 1, 'per-stream send counters');
}

console.log('=== forward secrecy / freshness ===');
{
  const h2 = handshake();
  ok(h2.agtCh.recv(appCh.send('x')) === null, 'different ephemeral => different session key (FS)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
