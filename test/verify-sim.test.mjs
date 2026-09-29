#!/usr/bin/env node
/**
 * verify-sim — device-verify's handshake, surface, speak, mute and stop phases, run end to end
 * against a REAL sidecar and a simulated app, with no phone.
 *
 * WHY. Those phases were filed as "waiting on a real phone". They were waiting on a sidecar
 * connection, and a connection can be made from here: sim-sidecar runs the installed sidecar's
 * own code in isolation (its ports, its keypair, its WS-force marker — never the live ones),
 * fake-adb stands in for adbd, and when `am start` arrives it launches sim-phone, a real AEAD
 * client with a werift peer answering at Android's opus PT. Every verdict below is the real
 * sidecar's decision read out of its real log — the transport, the ICE outcome, whether a reply
 * was cut short — not a replayed line.
 *
 * Running it found four things no fake-log suite could have:
 *   - device-verify waited on the sidecar's END-of-send line as "audio is playing", so on the
 *     paced downlink the "mid-sentence" taps landed after the reply was over;
 *   - an ICE failure read as "werift did not expose one";
 *   - on the burst WS fallback, Stop was reported BLOCKED with "retry with a longer --say",
 *     because the host had nothing left to cut — the verdict there is the phone's flush;
 *   - nothing checked that the sidecar HONOURED a forced WS downlink, only that the marker was
 *     written.
 *
 * THE INJECTED FAILURE is sim-phone --break-webrtc: the app receives the SDP answer and never
 * applies it, so ICE cannot complete and the sidecar must fall back to WS on its own.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
await (await import('./lib/suite-list.mjs')).refuseDuringMutation(REPO);
const FAKE = join(REPO, 'test/fixtures/fake-adb.mjs');
const SIDECAR = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
const OUT = join(REPO, 'test/audit/out/device');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
if (!existsSync(SIDECAR)) {
  console.log(`  the installed sidecar is not at ${SIDECAR} — nothing to run against`);
  process.exit(1);
}

const REAL = join(OUT, 'device-verify.json');
const realBefore = existsSync(REAL) ? readFileSync(REAL, 'utf8') : null;

const freePort = () => new Promise((res) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const listening = (port) => new Promise((res) => {
  const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.end(); res(true); });
  c.once('error', () => res(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One run: a fresh isolated sidecar, one scenario, one device-verify invocation.
 * `forceFile` overrides the marker device-verify writes — pointing it somewhere the sidecar does
 * not read is how the "did it honour the force" stage is shown to be able to fail.
 */
async function run(sc, args, { forceFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-sim-'));
  const sdir = join(dir, 'sc');
  const [port, ctl] = [await freePort(), await freePort()];
  const side = spawn(process.execPath, [join(REPO, 'test/fixtures/sim-sidecar.mjs'), sdir, String(port), String(ctl)],
    { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await listening(port)); i++) await sleep(200);
  const scPath = join(dir, 'sc.json');
  writeFileSync(scPath, JSON.stringify({ usb: '33250DLH2000CB', pid: '4242', ...sc }));
  const marker = forceFile || join(sdir, 'force-ws-downlink');
  const r = await new Promise((res) => {
    const p = spawn(process.execPath, [join(REPO, 'test/device-verify.mjs'), ...args], {
      cwd: REPO,
      env: { ...process.env, AGENTMOB_ADB: FAKE, FAKE_ADB_SCENARIO: scPath,
             AGENTMOB_GATEWAY_LOG: join(sdir, 'gateway.log'), AGENTMOB_FORCE_WS_FILE: marker,
             SIM_SIDECAR_URL: `ws://127.0.0.1:${port}`, SIM_SIDECAR_CTL: String(ctl),
             AGENTMOB_APK: 'android/app/build/outputs/apk/release/app-release.apk' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.on('exit', (status, signal) => { clearTimeout(kill); res({ status, signal, stdout, stderr }); });
  });
  const markerLeft = existsSync(marker);
  side.kill('SIGTERM');
  await sleep(800);
  try {
    const st = JSON.parse(readFileSync(scPath + '.state', 'utf8'));
    if (st.phonePid) process.kill(st.phonePid, 'SIGTERM');
  } catch {}
  const gw = existsSync(join(sdir, 'gateway.log')) ? readFileSync(join(sdir, 'gateway.log'), 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  const line = (re) => r.stdout.split('\n').find((l) => re.test(l)) || '(no such line)';
  return { ...r, gw, markerLeft, line };
}

console.log('\n  paced WebRTC downlink — the path a healthy phone takes');
{
  const t = await run({ flushDropped: 6, replySeconds: 30 }, ['--from', 'launch', '--wait', '20']);
  ok('the run finished on its own', t.signal === null, `killed by ${t.signal}`);
  ok('handshake: the AEAD handshake completed against the real sidecar',
    /VERIFIED\] AEAD handshake — client_id [0-9a-f]{8}/.test(t.stdout), t.line(/AEAD handshake/));
  ok('handshake: and the sidecar logged that client, not a replayed line',
    (() => { const id = (/client_id ([0-9a-f]{8})/.exec(t.stdout) || [])[1];
             return !!id && t.gw.includes(id); })(), t.line(/AEAD handshake/));
  ok('handshake: WebRTC negotiated at Android\'s opus PT',
    /VERIFIED\] WebRTC negotiated by Android libwebrtc — opus PT 111/.test(t.stdout));
  ok('handshake: the ICE stage read a real nominated pair (LAN here, and says so)',
    /BLOCKED \] ICE path \(tailnet vs LAN\) — LAN:/.test(t.stdout), t.line(/ICE path/));
  ok('surface: the control bar and tile screenshots were captured and validated',
    /VERIFIED\] screenshot: connected control bar/.test(t.stdout)
    && /VERIFIED\] screenshot: widget tiles/.test(t.stdout),
    [t.line(/connected control bar/), t.line(/widget tiles/)].join(' | '));
  ok('speak: the reply STARTED on WebRTC before the taps (the START line, not the end one)',
    /→ phone pcm START \d+b \(\d+ frames\) via WebRTC/.test(t.gw));
  ok('mute: muting the mic did not stop the reply',
    /VERIFIED\] mute mid-sentence: the reply KEPT playing/.test(t.stdout), t.line(/KEPT playing/));
  ok('stop: the REAL sidecar cut the reply short on the Stop tap',
    /VERIFIED\] Stop actually stopped the audio — cut at \d+\/\d+ frames/.test(t.stdout)
    && /cut short after \d+\/\d+ frames: superseded or interrupted/.test(t.gw),
    t.line(/Stop actually/));
  ok('stop: the interrupt reached the sidecar from the app\'s Stop control',
    /→ bridge \{"type":"interrupt"\}/.test(t.gw));
  ok('the tailnet stage stays blocked — a stand-in is not the phone on record',
    /BLOCKED \] tailnet path exercises the REMOTE case — simulated run/.test(t.stdout));
  ok('it is reported as a PARTIAL pass, never a device one', /PARTIAL PASS/.test(t.stdout));
}

console.log('\n  INJECTED FAILURE: the app never applies the answer, so ICE cannot complete');
{
  const t = await run({ flushDropped: 1180, replySeconds: 30, breakWebrtc: true },
    ['--from', 'launch', '--wait', '20']);
  ok('the sidecar itself declared ICE failed and fell back',
    /webrtc ICE FAILED \(never reached connected\) — voice falls back to WS/.test(t.gw));
  ok('fallback: the reply really went out on WS, by the sidecar\'s own decision',
    /→ phone pcm START \d+b \(\d+ frames\) via WS\b(?! \[FORCED\])/.test(t.gw)
    && /via WS \(webrtc ready=false\)/.test(t.gw));
  ok('device-verify names the ICE failure as a FAILURE, not a logging gap',
    /FAILED  \] ICE path \(tailnet vs LAN\) — ICE FAILED/.test(t.stdout)
    && !/werift did not expose/.test(t.stdout), t.line(/ICE path/));
  ok('and the run exits non-zero for it', t.status === 1, `exit ${t.status}`);
  ok('stop: on the burst path it does not wait for a cut the host cannot make',
    /VERIFIED\] Stop actually stopped the audio — the reply went out via WS in one burst/.test(t.stdout)
    && !/retry with a longer --say/.test(t.stdout), t.line(/Stop actually/));
  ok('stop: the phone-side flush is judged by the BURST rule',
    /VERIFIED\] Stop flushed the audio already on the phone — Stop flushed 1180 queued frame\(s\) — the burst path/.test(t.stdout),
    t.line(/Stop flushed/));
}

console.log('\n  --ws-fallback: the forced marker, honoured');
{
  const t = await run({ flushDropped: 1180, replySeconds: 30 },
    ['--from', 'launch', '--wait', '20', '--ws-fallback']);
  ok('the sidecar read the marker', /WS DOWNLINK FORCED \(marker file\)/.test(t.gw));
  ok('and the reply carries [FORCED]', /→ phone pcm START [^\n]* via WS \[FORCED\]/.test(t.gw));
  ok('device-verify checks the force was HONOURED, not only that it wrote the file',
    /VERIFIED\] the sidecar honoured the forced WS downlink — the reply went out via WS \[FORCED\]/.test(t.stdout),
    t.line(/honoured/));
  ok('ICE still connected — the force is on the downlink, not a failure',
    !/FAILED  \] ICE path/.test(t.stdout), t.line(/ICE path/));
  ok('stop: the burst flush is the verdict', /VERIFIED\] Stop actually stopped the audio — the reply went out via WS in one burst/.test(t.stdout));
  ok('the marker is removed when the run ends', !t.markerLeft);
}

console.log('\n  --ws-fallback whose marker the sidecar never sees');
{
  const stray = join(mkdtempSync(join(tmpdir(), 'verify-sim-stray-')), 'force-ws-downlink');
  const t = await run({ flushDropped: 6, replySeconds: 30 }, ['--only', 'stop', '--wait', '20', '--ws-fallback'],
    { forceFile: stray });
  ok('the unhonoured force FAILS by name',
    /FAILED  \] the sidecar honoured the forced WS downlink — the reply went out via WebRTC with no \[FORCED\] tag/.test(t.stdout),
    t.line(/honoured/));
  ok('and the paced flush is then called what it is — the force did not take',
    /FAILED  \] Stop flushed the audio already on the phone — only 6 frame\(s\) were queued, which is the PACED profile/.test(t.stdout),
    t.line(/Stop flushed/));
  rmSync(dirname(stray), { recursive: true, force: true });
}

ok('the real device-verify.json was not touched by any of this',
  (existsSync(REAL) ? readFileSync(REAL, 'utf8') : null) === realBefore);

console.log('\n  A real sidecar and a simulated app. What is left is the handset\'s: Android\'s');
console.log('  libwebrtc really completing ICE, AudioTrack really going quiet, the real mic.');
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
