/**
 * aead-trigger.test — prove the device run's trigger actually makes the agent speak.
 *
 * device-verify needs the agent to say something so the speaking pill and the Stop truncation
 * can be observed. Its old trigger, `hermes send -t agentmob`, does not work at all and exits 0
 * while failing, so the stage reported success for a command that did nothing.
 *
 * This drives the replacement against the LIVE sidecar, in the exact topology the device run
 * has: a stand-in phone connects FIRST and negotiates WebRTC, then the trigger connects, sends
 * a typed turn and leaves. The audio must arrive at the stand-in — because the sidecar sends
 * reply audio to conns[0], the first connection, not to whoever asked. Getting that ordering
 * wrong would speak the reply at the trigger and leave the handset silent, which is precisely
 * the failure a host-side test can catch and a hardware run would waste itself on.
 *
 * Needs the gateway up. Run: npm run aead-trigger
 */
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import { AgentStream } from '../transport/ws-client.mjs';
import { typedTurn } from './lib/aead-trigger.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GLOG = join(homedir(), '.hermes/logs/gateway.log');
let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, d); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Timestamps, not byte offsets — gateway.log rotates at 5MB, and local time because the log
 * stamps local. Both learned the hard way in e2e-interrupt. */
const stamp = () => {
  const d = new Date(Date.now() - 2000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
       + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const logSince = (since) => {
  let t = '';
  for (const f of [GLOG + '.1', GLOG]) { try { t += readFileSync(f, 'utf8'); } catch {} }
  return t.split('\n').filter((l) => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return m && m[1] >= since;
  }).join('\n');
};
const waitFor = async (fn, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (fn()) return true; await sleep(200); } return fn(); };

const mark = stamp();
console.log('aead trigger — a typed turn must make the agent speak to the FIRST connection\n');

/* ---- the stand-in phone: connects FIRST, exactly as the handset does at stage 3 ---- */
const phone = new AgentStream({ url: 'ws://127.0.0.1:8123', onPair: async () => true });
await phone.connect();
ok(!!phone.channel, 'stand-in phone connected first (as the handset does)');

const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
pc.addTransceiver(new MediaStreamTrack({ kind: 'audio' }), { direction: 'sendrecv' });
let downlink = 0;
pc.onTrack.subscribe((t) => { t.onReceiveRtp.subscribe(() => { downlink++; }); });
await pc.setLocalDescription(await pc.createOffer());
await sleep(1200);
const ans = await phone.cmd({ cmd: 'webrtc', sdp_type: 'offer', sdp: pc.localDescription.sdp },
  { timeoutMs: 20000 });
const sdp = ans && ans.webrtc && ans.webrtc.sdp;
ok(!!sdp, 'the stand-in negotiated WebRTC, so reply audio is observable');
await pc.setRemoteDescription({ type: 'answer', sdp });
ok(await waitFor(() => pc.connectionState === 'connected', 25000),
  `ICE connected (${pc.connectionState})`);

/* ---- the trigger: connects second, sends a turn, leaves ---- */
const before = downlink;
const t0 = Date.now();
const r = await typedTurn({
  text: 'Say a short sentence out loud so this run can hear you. Keep it under ten words.',
});
ok(r.ok, `the typed turn was delivered${r.error ? ` (${r.error})` : ''}`, String(r.error));

/* ---- the agent must actually speak, and to the STAND-IN ---- */
const spoke = await waitFor(() => downlink > before + 10, 180000);
ok(spoke, `the agent spoke to the FIRST connection (${downlink - before} RTP packets)`,
  'no audio arrived at the stand-in — conns[0] routing may have changed');

/* POLL for it. finish() writes this line only after the whole reply has finished pacing —
 * ~3.1s of audio at 20ms a frame — and the RTP counter crosses its threshold long before that.
 * Reading once here reported "the sidecar logged no audio" while it was still mid-sentence.
 * Fourth time today I have raced this log; the pattern is always the same: the wire is ahead
 * of the file. */
await waitFor(() => /→ phone pcm /.test(logSince(mark)), 30000);
const tail = logSince(mark);
ok(/→ phone pcm /.test(tail), 'the sidecar logged the reply audio',
  tail.split('\n').slice(-2).join(' | '));
const via = (tail.match(/→ phone pcm .*opus packets via (\w+)/) || [])[1];
ok(!!via, `the reply went out over ${via || '(unknown)'}`);
ok(!/No live adapter/.test(tail), 'nothing reported a missing adapter (the old trigger did)');

console.log(`\n  trigger -> speech in ${((Date.now() - t0) / 1000).toFixed(1)}s, `
  + `${downlink - before} RTP to the stand-in, transport ${via}`);

/* ---- and the wiring: device-verify must use this, not the dead path ---- */
{
  const src = readFileSync(new URL('./device-verify.mjs', import.meta.url), 'utf8');
  ok(/from '\.\/lib\/aead-trigger\.mjs'/.test(src), 'device-verify imports the AEAD trigger');
  ok(/await typedTurn\(/.test(src), 'device-verify calls it');
  ok(!/\['send', '-t', 'agentmob', TRIGGER\]/.test(src),
    'device-verify no longer shells out to the dead `hermes send` path');
  ok(/conns\[0\]|first connection|connect AFTER the phone/i.test(src),
    'the ordering dependency is written down where the stage runs');
}

try { pc.close(); } catch {}
try { phone.close?.(); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
