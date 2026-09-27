/**
 * sidecar-inbound.test — a bad frame must not cost the phone its session.
 *
 * The adapter's read loop learned that a failing handler is not a broken socket. The stakes are
 * higher on this side: the adapter can rebuild its bridge in ~110ms, but tearing down an AEAD
 * channel costs the phone its whole SESSION — re-handshake, new media socket, lost turn.
 *
 * So the assertion that matters is not "it recovers". It is that NOTHING HAPPENED to the
 * channel: same socket, same handshake, no reconnect, and the very next legitimate command
 * still gets its reply on the same encrypted stream with its counters intact. A test that only
 * checked "the phone can talk again afterwards" would pass against a sidecar that dropped the
 * connection and let the client reconnect, which is exactly the outcome being ruled out.
 *
 * Drives a REAL sidecar on throwaway ports with a REAL v2 handshake.
 *
 * Run: npm run sidecar-inbound
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentStream } from '../transport/ws-client.mjs';
import { pack, T } from '../transport/wsframes.js';

const SIDECAR = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
if (!existsSync(SIDECAR)) { console.log('skip: sidecar not installed'); process.exit(0); }

const WS_PORT = 8881, CTL_PORT = 8882;     // throwaway; never 8123/8790

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let out = '';
const proc = spawn(process.execPath, [SIDECAR], {
  env: { ...process.env, AGENTMOB_PORT: String(WS_PORT), AGENTMOB_BIND: '127.0.0.1',
         AGENTMOB_SIDECAR_PORT: String(CTL_PORT), AGENTMOB_RX_FAIL_ESCALATE: '3' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
await sleep(3000);

const s = new AgentStream({ url: `ws://127.0.0.1:${WS_PORT}`, onPair: async () => true });
await s.connect();
ok('a real AEAD channel is up', !!s.channel);

// Wait for the handshake line to actually reach stderr before snapshotting. Reading the count
// too early made every sessionIntact() check compare 0 against 1 and fail for a reason that had
// nothing to do with the sidecar — the product was fine, the test was racing its own log.
for (let i = 0; i < 100 && !/handshake confirmed/.test(out); i++) await sleep(50);
const handshakesBefore = (out.match(/handshake confirmed/g) || []).length;
const socketBefore = s.ws;
const channelBefore = s.channel;
ok('exactly one handshake so far', handshakesBefore === 1, String(handshakesBefore));

/** The session is INTACT — not merely usable again. */
const sessionIntact = () =>
  s.ws === socketBefore
  && s.channel === channelBefore
  && s.ws.readyState === 1
  && (out.match(/handshake confirmed/g) || []).length === handshakesBefore
  && !/phone disconnected/.test(out);

/* ---- 1. an UNKNOWN frame type -------------------------------------------------------------
 * The phone and sidecar ship separately, so a type this build does not know is realistic. */
{
  const UNKNOWN = 0x7e;
  s.ws.send(pack(UNKNOWN, s.channel.send(Buffer.from('hello from the future'), UNKNOWN)),
    { binary: true });
  await sleep(600);
  ok('unknown type: the channel is untouched', sessionIntact(),
    'the session was torn down by a frame it merely did not recognise');
  ok('unknown type: it is LOGGED, not silently dropped',
    /unknown frame type 126/.test(out), out.split('\n').slice(-3).join(' | '));
  ok('unknown type: the log says the channel was kept', /channel kept/.test(out));
  ok('unknown type: it names the likely cause',
    /may be newer than this sidecar/.test(out));
}

/* ---- 2. a well-sealed frame carrying GARBAGE where JSON belongs ---------------------------- */
{
  s.ws.send(pack(T.cmd, s.channel.send(Buffer.from('}{ not json at all'), T.cmd)),
    { binary: true });
  await sleep(600);
  ok('malformed cmd: the channel is untouched', sessionIntact(),
    'a malformed payload cost the phone its session');
  ok('malformed cmd: it is logged rather than vanishing',
    /cmd payload is not JSON/.test(out), out.split('\n').slice(-3).join(' | '));
}

/* ---- 3. a cmd that is valid JSON but structurally nonsense --------------------------------- */
{
  for (const junk of ['[]', '"just a string"', '{"i":"not-a-number","d":{"cmd":12345}}',
                      '{"d":{"cmd":"webrtc","sdp_type":"offer"}}']) {
    s.ws.send(pack(T.cmd, s.channel.send(Buffer.from(junk), T.cmd)), { binary: true });
    await sleep(250);
  }
  ok('nonsense cmds: the channel survives all of them', sessionIntact(),
    'one of the nonsense payloads killed the session');
}

/* ---- 4. a truncated / undecodable audio frame ---------------------------------------------- */
{
  s.ws.send(pack(T.audio, s.channel.send(Buffer.from([0x01, 0x02]), T.audio)), { binary: true });
  await sleep(500);
  ok('bad audio: the channel survives', sessionIntact(), 'a short audio frame killed the session');
}

/* ---- 5. raw junk that is not even a valid frame -------------------------------------------- */
{
  s.ws.send(Buffer.from([0xff, 0x00, 0x01, 0x02, 0x03]), { binary: true });
  await sleep(500);
  ok('raw junk: the channel survives', sessionIntact(), 'undecodable bytes killed the session');
}

/* ---- 6. THE POINT: the same session still works ------------------------------------------- */
{
  const before = s.stats ? { ...s.stats } : null;
  let pong = false;
  try {
    // ping/pong rides the same channel and counters; a reply proves the stream is still valid.
    s.ping?.();
    await sleep(800);
    pong = true;
  } catch { pong = false; }

  ok('after all of it: still the SAME socket and channel', sessionIntact(),
    'the session was replaced somewhere along the way');
  ok('after all of it: no reconnect happened',
    (out.match(/phone connected/g) || []).length === 1,
    `${(out.match(/phone connected/g) || []).length} connections — it reconnected`);

  // A real command must still get a real reply on the same stream. A webrtc OFFER is the right
  // probe: the sidecar answers it entirely on its own, with no adapter or agent attached.
  // (An earlier version sent sdp_type:'candidate' with a null candidate, which the sidecar
  // ignores BY DESIGN — it timed out and I nearly read that as a broken channel.)
  let replied = false, answer = null;
  try {
    const { RTCPeerConnection, MediaStreamTrack } = await import('werift');
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
    await pc.setLocalDescription(await pc.createOffer());
    await sleep(500);
    const r = await s.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
      { timeoutMs: 20000 });
    answer = r && r.webrtc && r.webrtc.sdp;
    replied = !!answer;
    try { pc.close(); } catch {}
  } catch (e) { replied = false; }
  ok('after all of it: a legitimate command still gets a reply on the same channel', replied,
    'the encrypted stream stopped working even though the socket stayed open');
  ok('after all of it: the reply is a real SDP answer, not an empty ack',
    !!answer && /a=rtpmap/.test(answer), String(answer).slice(0, 60));
  ok('after all of it: STILL the same session', sessionIntact());
}

/* ---- 7. repeated handler failures escalate rather than repeating one line ------------------ */
{
  const escalated = /RX HANDLER WEDGED/.test(out);
  // Not asserted as required: these payloads are handled cleanly rather than throwing, which is
  // the correct outcome. Report what actually happened instead of pretending to force it.
  console.log(`  note  RX HANDLER WEDGED escalation ${escalated ? 'fired' : 'did not fire'} `
    + `(no payload here made a handler throw — the loop handled them all)`);
  ok('the escalation exists in the sidecar for when a handler does throw',
    /RX HANDLER WEDGED/.test(
      (await import('node:fs')).readFileSync(SIDECAR, 'utf8')));
}

try { proc.kill('SIGKILL'); } catch {}
try { s.close?.(); } catch {}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log('\n--- sidecar log ---\n' + out.split('\n').slice(-25).join('\n')); process.exit(1); }
console.log('ALL PASS');
process.exit(0);
