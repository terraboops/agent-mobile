/**
 * device-watch.test — prove the on-device evidence classifier before trusting it.
 *
 * test/device-watch.mjs is the thing that will decide, unattended, whether a handshake in the
 * gateway log came from the real Pixel or from my own werift fake phone. If it gets that wrong
 * it will hand back harness traffic dressed up as on-device proof, which is worse than no
 * evidence at all. So drive it against synthetic logs whose answer is known.
 *
 * Fixtures are written in the real adapter log shape:
 *   "<ts> INFO hermes_plugins.agentmob_platform.adapter: agentmob[sidecar]: [sidecar] <msg>"
 *
 * Run: npm run device-watch-test
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = join(ROOT, 'test/device-watch.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'devwatch-'));

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const L = (ts, msg) =>
  `${ts} INFO hermes_plugins.agentmob_platform.adapter: agentmob[sidecar]: [sidecar] ${msg}`;

/** Run the watcher in history-only mode over a synthetic log; return its JSON report. */
function run(name, lines) {
  const log = join(tmp, name + '.log');
  const out = join(tmp, name + '.json');
  writeFileSync(log, lines.join('\n') + '\n');
  let stdout = '', code = 0;
  try {
    stdout = execFileSync(process.execPath, [WATCH, '--history'],
      { env: { ...process.env, AGENTMOB_WATCH_LOG: log, AGENTMOB_WATCH_OUT: out }, encoding: 'utf8' });
  } catch (e) { stdout = (e.stdout || '') + (e.stderr || ''); code = e.status; }
  return { report: JSON.parse(readFileSync(out, 'utf8')), stdout, code };
}

/* ---- 1. a real Android device: libwebrtc offers opus PT 111 ------------------------------ */
{
  const t = '2026-09-26 21:00:';
  const { report, stdout, code } = run('android', [
    L(t + '01', 'phone connected'),
    L(t + '01', 'PAIRING: client 42c55608 identity=MCowBQYDK2VwAyEAreAlDeviceKeyAAAAAAAAAAAAAAAAAAAAAA= — add to AGENTMOB_ALLOWED_CLIENTS to pin'),
    L(t + '02', 'handshake confirmed 42c55608'),
    L(t + '03', 'webrtc st connecting'),
    L(t + '04', 'webrtc answer sent opusPT=111'),
    L(t + '05', 'webrtc st connected'),
    L(t + '09', '→ phone pcm 88704b -> 92 opus packets via WebRTC'),
    L(t + '20', 'phone disconnected'),
  ]);
  const s = report.sessions.at(-1);
  ok('android: one session parsed', report.sessions.length === 1, `${report.sessions.length}`);
  ok('android: classified as a REAL device', report.realDeviceSessions === 1);
  ok('android: opus PT 111 captured', s.opusPT === 111, `${s.opusPT}`);
  ok('android: handshake confirm recorded', s.confirmed === true);
  ok('android: live phone identity extracted',
    report.livePhoneIdentity && report.livePhoneIdentity.clientId === '42c55608',
    JSON.stringify(report.livePhoneIdentity));
  ok('android: the trailing prose is stripped off the identity',
    !/add to AGENTMOB/.test(s.identity || '') && /=$/.test(s.identity || ''), s.identity);
  ok('android: downlink recorded as WebRTC, not a fallback',
    s.downlink.length === 1 && s.downlink[0].via === 'WebRTC' && s.downlink[0].packets === 92);
  ok('android: ICE reached connected', s.iceStates.includes('connected'));
  ok('android: prints the exact pin command', stdout.includes('AGENTMOB_ALLOWED_CLIENTS=42c55608'));
  ok('android: exits 0 when real-device evidence exists', code === 0, `exit ${code}`);
}

/* ---- 2. my own harness: werift offers opus PT 96. Must NOT count as device evidence. ----- */
{
  const t = '2026-09-26 21:10:';
  const { report, stdout, code } = run('werift', [
    L(t + '01', 'phone connected'),
    L(t + '01', 'PAIRING: client aa11bb22 identity=MCowBQYDK2VwAyEAhArnessKeyBBBBBBBBBBBBBBBBBBBBBB= — add to AGENTMOB_ALLOWED_CLIENTS to pin'),
    L(t + '02', 'handshake confirmed aa11bb22'),
    L(t + '04', 'webrtc answer sent opusPT=96'),
    L(t + '05', 'webrtc st connected'),
    L(t + '09', '→ phone pcm 88704b -> 92 opus packets via WebRTC'),
  ]);
  ok('werift: NOT counted as a real device', report.realDeviceSessions === 0);
  ok('werift: no live phone identity claimed', report.livePhoneIdentity === null);
  ok('werift: named as the harness in the output', /werift/.test(stdout) && /harness/.test(stdout));
  ok('werift: exits non-zero (no device evidence)', code !== 0, `exit ${code}`);
}

/* ---- 3. a pinned allowlist rejecting a stale id — the lockout this tool exists to avoid -- */
{
  const t = '2026-09-26 21:20:';
  const { report } = run('reject', [
    L(t + '01', 'phone connected'),
    L(t + '01', 'REJECT unknown client 99999999 (MCowBQYDK2VwAyEAstaleKeyCCCC=)'),
    L(t + '02', 'phone disconnected'),
  ]);
  const s = report.sessions.at(-1);
  ok('reject: session recorded as not confirmed', s.confirmed === false);
  ok('reject: the rejected id is captured', s.rejects.length === 1 && s.rejects[0].id === '99999999');
  ok('reject: not counted as device evidence', report.realDeviceSessions === 0);
}

/* ---- 4. connected but WebRTC never negotiated -> the silent WS fallback ------------------ */
{
  const t = '2026-09-26 21:30:';
  const { report } = run('fallback', [
    L(t + '01', 'phone connected'),
    L(t + '02', 'handshake confirmed 42c55608'),
    L(t + '09', '→ phone pcm 88704b -> 92 opus packets via WS'),
  ]);
  const s = report.sessions.at(-1);
  ok('fallback: opus PT absent', s.opusPT === null);
  ok('fallback: downlink flagged as WS, not WebRTC', s.downlink[0].via === 'WS');
  ok('fallback: not counted as device evidence', report.realDeviceSessions === 0);
}

/* ---- 5. two connections in a row must not bleed into one session ------------------------- */
{
  const t = '2026-09-26 21:40:';
  const { report } = run('two', [
    L(t + '01', 'phone connected'),
    L(t + '02', 'handshake confirmed aaaaaaaa'),
    L(t + '03', 'webrtc answer sent opusPT=96'),
    L(t + '04', 'phone disconnected'),
    L(t + '05', 'phone connected'),
    L(t + '06', 'handshake confirmed bbbbbbbb'),
    L(t + '07', 'webrtc answer sent opusPT=111'),
    L(t + '08', '→ phone pcm 100b -> 5 opus packets via WebRTC'),
  ]);
  ok('two: both sessions kept separate', report.sessions.length === 2, `${report.sessions.length}`);
  ok('two: only the Android one counts', report.realDeviceSessions === 1);
  ok('two: the harness PT did not leak into session 2', report.sessions[1].opusPT === 111);
  ok('two: identity reported is the device one', report.livePhoneIdentity.clientId === 'bbbbbbbb');
}

/* ---- 5b. ICE gave up: handshake fine, voice silently on the WS fallback ------------------ */
{
  const t = '2026-09-27 00:05:';
  const { report, stdout } = run('icefail', [
    L(t + '01', 'phone connected'),
    L(t + '02', 'handshake confirmed 42c55608'),
    L(t + '03', 'webrtc answer sent opusPT=111'),
    L(t + '04', 'webrtc st connecting'),
    L(t + '20', 'webrtc st closed'),
    L(t + '20', 'webrtc ICE FAILED (never reached connected) — voice falls back to WS/UDP. ice=stun:stun.l.google.com:19302 tailnet-ice=none'),
    L(t + '25', '→ phone pcm 88704b -> 92 opus packets via WS (webrtc ready=false)'),
  ]);
  const s = report.sessions.at(-1);
  ok('icefail: the give-up line is captured', !!s.iceFailed, String(s.iceFailed));
  ok('icefail: verdict says ICE FAILED, not a healthy session',
    /ICE FAILED/.test(stdout), 'verdict not surfaced');
  ok('icefail: the diagnosis keeps the ice config', /tailnet-ice=none/.test(s.iceFailed || ''));
  ok('icefail: downlink recorded as the WS fallback', s.downlink[0]?.via === 'WS');
  /* Still a real device: it is a reachability failure, not an identity question. */
  ok('icefail: still counted as a real-device session', report.realDeviceSessions === 1);
}

/* ---- 6. a truncated playback: logged AFTER the disconnect that truncated it -------------- */
{
  const t = '2026-09-26 21:45:';
  const { report } = run('truncated', [
    L(t + '01', 'phone connected'),
    L(t + '02', 'handshake confirmed 42c55608'),
    L(t + '03', 'webrtc answer sent opusPT=111'),
    L(t + '04', 'webrtc st connected'),
    L(t + '09', 'phone disconnected'),
    // the disconnect is WHAT truncated the send, so finish() logs after it
    L(t + '09', '→ phone pcm 142848b -> 148 opus packets via WebRTC [cut short after 119/148 frames: peer gone (ICE drop/disconnect)]'),
  ]);
  const s = report.sessions.at(-1);
  ok('truncated: downlink attributed to the session that just ended', s.downlink.length === 1,
    `${s.downlink.length}`);
  ok('truncated: transport still recorded as WebRTC', s.downlink[0]?.via === 'WebRTC');
  ok('truncated: the truncation reason is kept',
    /cut short after 119\/148/.test(s.downlink[0]?.truncated || ''), s.downlink[0]?.truncated);
  ok('truncated: still counts as real-device evidence', report.realDeviceSessions === 1);
}

/* ---- 7. a clean send carries no truncation note ------------------------------------------ */
{
  const t = '2026-09-26 21:55:';
  const { report } = run('clean', [
    L(t + '01', 'phone connected'),
    L(t + '02', 'handshake confirmed 42c55608'),
    L(t + '03', 'webrtc answer sent opusPT=111'),
    L(t + '09', '→ phone pcm 88704b -> 92 opus packets via WebRTC'),
  ]);
  const d = report.sessions.at(-1).downlink[0];
  ok('clean: no truncation note on a complete send', d && d.truncated === null, JSON.stringify(d));
  ok('clean: packet count parsed', d && d.packets === 92);
}

/* ---- 6. unrelated log noise must not invent sessions ------------------------------------- */
{
  const { report } = run('noise', [
    '2026-09-26 21:50:00 INFO gateway.run: ✓ agentmob connected',
    '2026-09-26 21:50:01 INFO something.else: phone connected',
    '2026-09-26 21:50:02 INFO fleet: cc-p-agentmob-rev ALIVE LIMIT',
  ]);
  ok('noise: no sessions invented from unrelated lines', report.sessions.length === 0,
    `${report.sessions.length}`);
}

/* ---- 8. FOLLOW mode must survive log rotation -------------------------------------------
 * The gateway rotates gateway.log on every restart. An armed watcher that follows the inode
 * goes silently deaf at exactly the moment a phone is most likely to reconnect — observed for
 * real: a watcher armed before two gateway restarts reported none of the handshakes after
 * them. This drives the follow path (not --history) across a rotation. */
{
  const { spawn } = await import('node:child_process');
  const { writeFileSync: wf, appendFileSync, renameSync } = await import('node:fs');
  const log = join(tmp, 'rotate.log');
  const out = join(tmp, 'rotate.json');
  wf(log, '');
  const child = spawn(process.execPath, [WATCH, '--timeout', '20'],
    { env: { ...process.env, AGENTMOB_WATCH_LOG: log, AGENTMOB_WATCH_OUT: out }, encoding: 'utf8' });
  let so = '';
  child.stdout.on('data', (d) => { so += d.toString(); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(4000);
  appendFileSync(log, L('2026-09-27 00:30:01', 'phone connected') + '\n');
  appendFileSync(log, L('2026-09-27 00:30:02', 'handshake confirmed beforeRotate') + '\n');
  await wait(2500);
  renameSync(log, log + '.1'); wf(log, '');          // exactly what the gateway does
  await wait(2500);
  appendFileSync(log, L('2026-09-27 00:30:10', 'phone connected') + '\n');
  appendFileSync(log, L('2026-09-27 00:30:11', 'handshake confirmed afterRotate') + '\n');
  appendFileSync(log, L('2026-09-27 00:30:12', 'webrtc answer sent opusPT=111') + '\n');
  await new Promise((r) => child.on('exit', r));
  const rep = JSON.parse(readFileSync(out, 'utf8'));
  ok('rotate: session BEFORE the rotation is seen', rep.sessions.some((x) => x.clientId === 'beforeRotate'));
  ok('rotate: session AFTER the rotation is still seen (tail -F, not -f)',
    rep.sessions.some((x) => x.clientId === 'afterRotate'),
    'the watcher went deaf at rotation');
  ok('rotate: the post-rotation device is classified', rep.realDeviceSessions === 1,
    `${rep.realDeviceSessions}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
