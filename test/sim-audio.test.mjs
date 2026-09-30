#!/usr/bin/env node
/**
 * sim-audio — mute → silence and Stop → quiet, end to end, on OBSERVABLE STATE.
 *
 * The app's shipped audio path (lib/java-phone.mjs: decodePlay, the reply thread, the Stop
 * flush, setMicMuted, encodeLoop — lifted out of AgentChannelPlugin.java and compiled with the
 * real Concentus codec) runs behind the simulated client, against a REAL isolated sidecar over
 * the real AEAD channel. What is asserted is what an observer could measure, not what the source
 * says:
 *
 *   Stop → quiet     what the speaker PLAYED, frame by frame, before and after Stop
 *   mute → silence   what the SIDECAR measured of the uplink (the level it pushes back), and
 *                    how many frames the app put on the wire, before, during and after a mute
 *
 * The Android classes underneath are stubs that model Android's documented contract (see
 * java-phone.mjs). The mute scenario uses the WORST microphone — one that keeps hearing the room
 * whatever AudioManager says — so silence there is the app's doing, not the hardware's.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
await (await import('./lib/suite-list.mjs')).refuseDuringMutation(REPO);
const { buildPhone } = await import('./lib/java-phone.mjs');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
if (!existsSync(join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs'))) {
  console.log('  the installed sidecar is missing — nothing to run against'); process.exit(1);
}
const built = buildPhone();
ok('the shipped audio path compiles against the Android stubs', built.ok, (built.err || '').split('\n').slice(0, 8).join('\n       '));
if (!built.ok) { console.log(`\n${pass} passed, ${fails.length} failed`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const listening = (port) => new Promise((res) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.end(); res(true); }); c.once('error', () => res(false)); });
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const LOUD = 1000;   // rms of a frame that is the 440 Hz tone, not silence

async function sidecar(dir) {
  const [port, ctl] = [await freePort(), await freePort()];
  const p = spawn(process.execPath, [join(REPO, 'test/fixtures/sim-sidecar.mjs'), join(dir, 'sc'), String(port), String(ctl)], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await listening(port)); i++) await sleep(200);
  return { p, port, ctl, gw: join(dir, 'sc', 'gateway.log'), force: join(dir, 'sc', 'force-ws-downlink') };
}

/** device-verify end to end, the shipped audio path behind the app. */
async function verifyRun(sc, args, { after } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sim-audio-'));
  const side = await sidecar(dir);
  const scp = join(dir, 'sc.json');
  writeFileSync(scp, JSON.stringify({ usb: '33250DLH2000CB', pid: '4242', javaPhone: true, replySeconds: 30, ...sc }));
  const r = await new Promise((res) => {
    const p = spawn(process.execPath, [join(REPO, 'test/device-verify.mjs'), ...args], { cwd: REPO,
      env: { ...process.env, AGENTMOB_ADB: join(REPO, 'test/fixtures/fake-adb.mjs'), FAKE_ADB_SCENARIO: scp,
             AGENTMOB_GATEWAY_LOG: side.gw, AGENTMOB_FORCE_WS_FILE: side.force,
             SIM_SIDECAR_URL: `ws://127.0.0.1:${side.port}`, SIM_SIDECAR_CTL: String(side.ctl), SIM_JAVA_CP: built.cp,
             AGENTMOB_APK: 'android/app/build/outputs/apk/release/app-release.apk' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const k = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.on('exit', (c) => { clearTimeout(k); res({ status: c, out }); });
  });
  if (after) await after(side, scp);
  const st = readJson(scp + '.state', {});
  try { process.kill(st.phonePid, 'SIGTERM'); } catch {}
  await sleep(1500);   // the app dumps what the speaker played on its way out
  side.p.kill('SIGTERM'); await sleep(500);
  const res = { ...r, audio: readJson(scp + '.phone.audio.json', {}), speaker: readJson(scp + '.phone.speaker.json', { heard: [] }),
                logcat: readText(scp + '.phone.logcat'), gw: readText(side.gw) };
  rmSync(dir, { recursive: true, force: true });
  res.line = (re) => res.out.split('\n').find((l) => re.test(l)) || '(no such line)';
  return res;
}

/** The app on its own against the sidecar, with the shipped capture loop running. */
async function micRun({ honor }) {
  const dir = mkdtempSync(join(tmpdir(), 'sim-audio-mic-'));
  const side = await sidecar(dir);
  const outp = join(dir, 'phone');
  const args = [join(REPO, 'test/fixtures/sim-phone.mjs'), '--url', `ws://127.0.0.1:${side.port}`, '--pt', '111',
                '--break-webrtc', '--hold', '60', '--java-phone', built.cp, '--mic'];
  if (honor) args.push('--honor-mute');
  const ph = spawn(process.execPath, args, { stdio: 'ignore', env: { ...process.env, SIM_PHONE_OUT: outp } });
  const marks = {};
  await sleep(6000); marks.muteAt = Date.now(); ph.kill('SIGUSR2');      // the native mic button: mute
  await sleep(5000); marks.unmuteAt = Date.now(); ph.kill('SIGUSR2');    // and again: unmute
  await sleep(5000); marks.end = Date.now();
  ph.kill('SIGTERM'); await sleep(1500); side.p.kill('SIGTERM'); await sleep(500);
  const ev = readText(outp + '.uplink').split('\n').filter(Boolean).map((l) => l.split(' '));
  const res = { marks, audio: readJson(outp + '.audio.json', {}), logcat: readText(outp + '.logcat'),
                up: ev.filter((e) => e[1] === 'UP').map((e) => Number(e[0])),
                level: ev.filter((e) => e[1] === 'LEVEL').map((e) => [Number(e[0]), Number(e[2])]) };
  rmSync(dir, { recursive: true, force: true });
  /* A window starts 400ms after its mark, so frames already on the wire at the tap land first. */
  const win = (a, b) => ({ up: res.up.filter((t) => t > a + 400 && t < b).length,
                            maxLevel: Math.max(0, ...res.level.filter(([t]) => t > a + 400 && t < b).map(([, l]) => l)) });
  res.before = win(marks.muteAt - 4400, marks.muteAt);
  res.muted = win(marks.muteAt, marks.unmuteAt);
  res.after = win(marks.unmuteAt, marks.end);
  return res;
}

console.log('\n  Stop → quiet, on the burst WS downlink, through device-verify');
{
  const t = await verifyRun({}, ['--from', 'launch', '--wait', '20', '--ws-fallback']);
  const heard = (t.speaker.heard || []).filter(([, r]) => r > LOUD);
  const stopAt = t.audio.stopAt;
  ok('the run finished', t.status === 0 || t.status === 1, `exit ${t.status}`);
  ok('control: the speaker PLAYED the reply before Stop', heard.filter(([ms]) => ms < stopAt).length > 50,
    `${heard.length} loud frames, stop at ${stopAt}`);
  const after = heard.filter(([ms]) => ms > stopAt).map(([ms]) => ms - stopAt);
  /* At most ONE frame: the one the reply thread already held, blocked in write() when Stop came.
   * A blocking AudioTrack.write finishes writing after a flush — Android's contract — so 20ms of
   * it is heard. Everything queued behind it must not be. */
  ok('Stop → quiet: at most the one frame the reply thread already held is heard after Stop',
    after.length <= 1 && after.every((d) => d <= 120), `heard ${after.length} frame(s) after Stop, at +${after.join('ms, +')}ms`);
  ok('the flush the shipped code logged is the one device-verify reported',
    new RegExp(`Stop flushed ${t.audio.dropped} queued frame`).test(t.out) && t.audio.dropped > 10,
    `${t.line(/Stop flushed the audio/)} vs ${t.audio.dropped}`);
  const muteLine = (t.logcat.match(/(\d\d):(\d\d):(\d\d)\.(\d{3}) \d+ \d+ I AgentChannel: mic MUTED \(native\)/) || []);
  ok('mute: the shipped setMicMuted logged the mute, and AudioManager holds it',
    muteLine.length > 0 && t.audio.mMicMute === true, JSON.stringify(t.audio));
  ok('mute: device-verify read BOTH from the shipped code (dumpsys + logcat), not from a knob',
    /VERIFIED\] mute mid-sentence: the device reports the mic muted \(issue #1\) — mMicMute=true/.test(t.out)
    && /VERIFIED\] mute mid-sentence: the APP logged the native mute — .*4242 4242 I AgentChannel: mic MUTED/.test(t.out));
  ok('mute: and the reply kept PLAYING through it — the speaker never went quiet between mute and Stop',
    (() => { const s = heard.filter(([ms]) => ms < stopAt).map(([ms]) => ms);
             let gap = 0; for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i] - s[i - 1]); return s.length > 50 && gap < 200; })(),
    'a gap over 200ms in the tone before Stop means something cut the reply');
  ok('the page is told the mic went dead on mute', t.audio.micLive === false, JSON.stringify(t.audio));
}

console.log('\n  mute → silence on the uplink, with a microphone that IGNORES the hardware mute');
{
  const m = await micRun({ honor: false });
  ok('control: before the mute the sidecar hears the room', m.before.up > 50 && m.before.maxLevel > 0.1, JSON.stringify(m.before));
  ok('mute → silence: while muted the app puts NO audio on the wire, whatever the hardware does',
    m.muted.up === 0, `${m.muted.up} uplink frame(s) sent while muted — the mute is only as good as the hardware`);
  ok('mute → silence: and the sidecar hears nothing', m.muted.maxLevel === 0, `max level ${m.muted.maxLevel} while muted`);
  ok('unmute: the room is heard again', m.after.up > 50 && m.after.maxLevel > 0.1, JSON.stringify(m.after));
  ok('the shipped toggle logged both', /mic MUTED \(native\)[\s\S]*mic unmuted \(native\)/.test(m.logcat), m.logcat.slice(0, 200));
}

console.log('\n  and with one that honours it (the chain setMicMuted → AudioManager → capture)');
{
  const m = await micRun({ honor: true });
  ok('honouring mic: silent while muted', m.muted.maxLevel === 0, JSON.stringify(m.muted));
  ok('honouring mic: heard again after', m.after.maxLevel > 0.1, JSON.stringify(m.after));
}

console.log('\n  Stop on a SLOW link: part of the burst is still in flight when Stop is pressed');
{
  let secondAt = null;
  /* breakWebrtc, not --ws-fallback: device-verify lifts the force marker when it exits, and the
   * SECOND reply would then go out over WebRTC to the stand-in's werift peer — never reaching the
   * shipped path at all. With ICE failed the sidecar stays on WS by its own decision. */
  const t = await verifyRun({ linkFps: 60, replySeconds: 14, breakWebrtc: true }, ['--from', 'launch', '--wait', '20'], {
    /* Stay up while the stale tail drains through the slow pipe, then speak AGAIN: the gate must
     * have fallen on the ack, and a new reply must play — a gate that never opens is a mute. */
    after: async (side, scp) => {
      for (let i = 0; i < 60 && !/stop gate (released|fell)/.test(readText(scp + '.phone.logcat')); i++) await sleep(500);
      await sleep(1500);
      secondAt = true;
      try { process.kill(readJson(scp + '.state', {}).phonePid, 'SIGHUP'); } catch {}
      await sleep(200);
      const push = spawn(process.execPath, [join(REPO, 'test/fixtures/sim-adapter-push.mjs'), String(side.ctl), '3'], { stdio: 'ignore' });
      await new Promise((r) => push.on('exit', r));
      await sleep(6000);
    } });
  const heard = (t.speaker.heard || []).filter(([, r]) => r > LOUD);
  const stopAt = t.audio.stopAt;
  const secondMs = secondAt && typeof t.audio.markAt === 'number' ? t.audio.markAt : Infinity;
  const after = heard.filter(([ms]) => ms > stopAt + 120 && ms < secondMs);
  ok('control: the speaker played the reply before Stop', heard.filter(([ms]) => ms < stopAt).length > 50, `${heard.length}`);
  ok('the gate was released by the sidecar\'s ack, not by the timeout',
    /stop gate released by the interrupt ack/.test(t.logcat) && !/stop gate timed out/.test(t.logcat),
    t.logcat.split('\n').filter((l) => /stop gate/.test(l)).join(' | ') || 'no stop-gate line at all');
  ok('Stop → quiet: frames that arrive AFTER the Stop are not played either',
    after.length === 0,
    `${after.length} tone frame(s) heard after Stop (+${after.length ? after[0][0] - stopAt : 0}ms to +${after.length ? after.at(-1)[0] - stopAt : 0}ms) — the in-flight tail of the burst, played after the flush`);
  ok('and the NEXT reply plays once the gate has fallen — Stop does not become a mute',
    heard.filter(([ms]) => ms >= secondMs).length > 50,
    `${heard.filter(([ms]) => ms >= secondMs).length} loud frame(s) after the second reply was pushed`);
}

console.log('\n  What this cannot reach: whether Android\'s AudioTrack/AudioRecord behave as their contracts say,');
console.log('  libwebrtc\'s own capture and playout on the WebRTC path, and the room going quiet to an ear.');
console.log(`\n${pass} passed, ${fails.length} failed`);
rmSync(built.dir, { recursive: true, force: true });
if (fails.length) process.exit(1);
console.log('ALL PASS');
