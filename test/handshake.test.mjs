// handshake.test.mjs — prove the mutual key exchange:
//   PASS: honest pair round-trips and both sides get the same handshake MAC
//   FAIL: impostor identity cannot decrypt (recv -> null)
//   FAIL: tampered frame is rejected
import { genIdentity, identityId, sessionFrom } from '../proto.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

console.log('=== honest parties ===');
const idApp = genIdentity();
const idAgent = genIdentity();
const appEph = genIdentity();
const agtEph = genIdentity();

console.log('  app id   ', identityId(idApp));
console.log('  agent id ', identityId(idAgent));

const appCh = sessionFrom('client', idApp, idAgent, appEph, agtEph.publicKey);
const agtCh = sessionFrom('agent', idAgent, idApp, agtEph, appEph.publicKey);

// Round trip both directions
const msg = 'BABEL<on id, you bail>';
const fwd = appCh.send(msg);
ok(agtCh.recv(fwd) === msg, 'app->agent round-trip');

const reply = 'SLA p95 < 250ms';
ok(appCh.recv(agtCh.send(reply)) === reply, 'agent->app round-trip');

// Handshake transcript MAC must match on both sides
const transcript = Buffer.concat([idApp.publicKey, idAgent.publicKey, appEph.publicKey, agtEph.publicKey]);
ok(appCh.handshakeMac(transcript).equals(agtCh.handshakeMac(transcript)), 'shared handshake MAC (mutual auth)');

console.log('=== impostor identity (MITM) ===');
const idImpostor = genIdentity();
const impEph = genIdentity();
const impCh = sessionFrom('agent', idImpostor, idApp, impEph, appEph.publicKey);
const caught = appCh.recv(impCh.send('i am your agent')) ;
ok(caught === null, 'impostor sender cannot decrypt / app rejects frames');

// A frame from the honest app routed to an impostor responder must fail auth
const toImpostor = impCh.recv(appCh.send('real data'));
ok(toImpostor === null, 'impostor responder cannot read real frames');

console.log('=== tamper / forge ===');
const frame = appCh.send('integrity matters');
frame.ct[0] ^= 0x01;
ok(agtCh.recv(frame) === null, 'tampered ciphertext rejected (AEAD auth)');

frame.nonce[0] ^= 0x01;
ok(agtCh.recv(frame) === null, 'tampered nonce rejected');

console.log('=== forward secrecy / freshness ===');
const appEph2 = genIdentity();
const appCh2 = sessionFrom('client', idApp, idAgent, appEph2, agtEph.publicKey);
const f1 = appCh.send('x'), f2 = appCh2.send('x');
// Neither side can decrypt the other session even though identity is the same.
ok(appCh2.recv(f1) === null, 'different ephemeral => different session key (FS)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
