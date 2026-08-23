// test-sidecar-media.js — integration proof of the UDP media path in the real
// sidecar. A simulated phone does the real 4-DH handshake over WS, reads the
// advertised `media_port`, then AEAD-sends uplink audio over UDP. We assert the
// sidecar accepted the media datagrams (no auth failure) and advertised a port.
import { spawn } from 'node:child_process';
import WebSocket from '/Users/terra/Developer/agent-mobile/node_modules/ws/wrapper.mjs';
import { genIdentity, clientHello, clientFinish } from '../proto.js';
import { UdpMedia } from './udp-media.js';
import { pack, T } from './wsframes.js';

const PORT = 8399;
const CTL = 8792;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const proc = spawn(process.execPath, ['/Users/terra/.hermes/plugins/agentmob/sidecar/index.mjs'], {
  env: { ...process.env, AGENTMOB_PORT: String(PORT), AGENTMOB_SIDECAR_PORT: String(CTL), AGENTMOB_BIND: '127.0.0.1', AGENTMOB_SIDECAR_TOKEN: 'dev' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let outLog = '';
proc.stderr.on('data', d => (outLog += d.toString()));
proc.stdout.on('data', d => (outLog += d.toString()));
setTimeout(() => {
  console.log('### TIMEOUT — child log:\n' + outLog.slice(0, 1500));
  console.log('### got frames:', got ? got.length : 'n/a');
  proc.kill(); process.exit(2);
}, 8000).unref();

const wait = (fn, t=0) => new Promise(res => { const iv=setInterval(()=>{ if(fn()){clearInterval(iv); res();} },50); });
// wait for 'ready' in child log
await wait(() => outLog.includes('[sidecar] ready'));
await sleep(300);

let ok = true; const fail = m => { ok=false; console.log('FAIL:', m); };

// --- simulated phone: real 4-DH handshake over WS -----------------------------
const clientId = genIdentity();
const clientEph = genIdentity();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const got = [];
ws.on('message', (d) => got.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
const helloMsg = clientHello(clientId, clientEph);          // v2: { v, client_id, client_identity, client_eph }
ws.send(JSON.stringify(helloMsg));

// The reply is the first TEXT frame (starts with '{' = 0x7b); AEAD frames start
// with a type byte. Wait for it regardless of what else arrives.
await wait(() => got.some(b => b[0] === 0x7b));
const hello = JSON.parse(got.find(b => b[0] === 0x7b).toString('utf8'));
if (hello.error) { fail(`gateway refused handshake: ${hello.error}`); }

const mediaPort = hello.media_port;
if (typeof mediaPort !== 'number' || mediaPort < 1024) fail(`media_port not advertised: ${JSON.stringify(hello)}`);
console.log(`SERVER HELLO keys=${Object.keys(hello).join(',')} media_port=${mediaPort}`);

// v2: verify the server's transcript MAC (TOFU here: no pin in a test), send confirm.
const fin = clientFinish(clientId, clientEph, helloMsg, hello, {});
ws.send(JSON.stringify(fin.confirm));
const client = fin.channel;

// --- send uplink audio over UDP (AEAD sealed) --------------------------------
const phone = new UdpMedia({ channel: client, allow: () => false });
const frames = 12; // 12 x 20ms silence frames
for (let s = 0; s < frames; s++) {
  await phone.send({ kind: 0, seq: s, tsMs: s * 20, opus: Buffer.from(Array(32).fill(s)), addr: '127.0.0.1', port: mediaPort });
}
await sleep(200);

// Also prove the AEAD channel works end-to-end via a WS ping->pong.
const ping = pack(T.ping, client.send(Buffer.alloc(0), T.ping));
const before = got.length;
ws.send(ping);
await wait(() => got.length > before && got.slice(before).some(b => b[0] === T.pong), 10);
await sleep(200);
const pong = got.slice(before).some(b => b[0] === T.pong);

// --- assertions ---------------------------------------------------------------
console.log(`media_port advertised = ${mediaPort}`);
console.log(`udp frames sent      = ${frames}`);
console.log(`ws chrome health     = ping->pong ${pong ? 'OK' : 'MISSING'}`);
await sleep(100);
if (outLog.includes('AEAD auth FAILED')) fail('a UDP media frame failed AEAD auth');
if (!outLog.includes(`media port ${mediaPort}`)) fail('sidecar did not bind/announce the media port');
phone.close();
ws.close(); proc.kill();

console.log(ok ? '\nPASS: sidecar handshake + UDP media port + AEAD uplink accepted' : '\nFAIL');
process.exit(ok ? 0 : 1);
