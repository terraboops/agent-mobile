// frames.test.mjs — malformed/hostile frames must be dropped, never thrown.
// (H1: a single junk UDP datagram used to crash the Node media receiver with an
// uncaught "Invalid initialization vector" from inside proto.decrypt.)
import { createSocket } from 'node:dgram';
import { Channel } from '../proto.js';
import { unpack, HEADER_LEN } from '../transport/wsframes.js';
import { UdpMedia } from '../transport/udp-media.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

const ch = new Channel(Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3));

// proto.decrypt never throws on malformed input
for (const [name, frame] of [
  ['short nonce', { nonce: Buffer.alloc(5), tag: Buffer.alloc(16), ct: Buffer.alloc(0) }],
  ['short tag', { nonce: Buffer.alloc(12), tag: Buffer.alloc(3), ct: Buffer.alloc(0) }],
  ['missing fields', {}],
  ['null', null],
  ['wrong types', { nonce: 'x', tag: 7, ct: {} }],
]) {
  let r, threw = false;
  try { r = ch.recvBytes(frame); } catch { threw = true; }
  ok(!threw && r === null, `recvBytes(${name}) -> null, no throw`);
}

// wsframes.unpack rejects short buffers with a throw (callers drop)
let threw = false; try { unpack(Buffer.alloc(HEADER_LEN - 1)); } catch { threw = true; }
ok(threw, 'unpack(short) throws RangeError for caller to drop');

// UdpMedia survives junk datagrams
const m = new UdpMedia({ channel: ch });
await m.start({ port: 0, host: '127.0.0.1' });
let died = null, authfails = 0;
m.on('authfail', () => authfails++);
const onUncaught = (e) => { died = e; };
process.on('uncaughtException', onUncaught);
const s = createSocket('udp4');
const send = (b) => new Promise((r) => s.send(b, m.port, '127.0.0.1', () => r()));
await send(Buffer.from([1, 2, 3, 4, 5]));          // too short
await send(Buffer.alloc(HEADER_LEN));              // right length, garbage
await send(Buffer.alloc(200, 0xff));               // long garbage
await send(Buffer.alloc(0));                       // empty
await new Promise((r) => setTimeout(r, 300));
process.off('uncaughtException', onUncaught);
ok(died === null, 'UdpMedia survives junk datagrams (no uncaught exception)');
ok(authfails >= 3, `junk datagrams reported as authfail (${authfails})`);
s.close(); m.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
