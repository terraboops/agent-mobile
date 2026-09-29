#!/usr/bin/env node
/**
 * fake-adb — a scripted stand-in for the adb binary, so the device paths that have never run
 * can run on the host.
 *
 * WHY. The USB path and the `unauthorized` branch were written and never executed: no cable had
 * been plugged in, and the "Allow wireless debugging?" prompt had never been on screen. That is
 * the same disease as a guard with nothing behind it — code whose first execution would be on
 * the phone, during the ten minutes someone is holding it.
 *
 * WHAT IT IS NOT. It does not emulate Android. It replays the TEXT adb prints, taken from real
 * adb output shapes, and records every invocation so a test can assert on exactly what the
 * scripts asked adb to do. Anything the scripts would learn only from a real device — whether an
 * install actually lands, whether audio plays — stays a device fact.
 *
 * Scenario (env FAKE_ADB_SCENARIO, a JSON file):
 *   { "usb": "33250DLH2000CB",                  a device on the cable, or null
 *     "mdns": "192.168.10.53:37129",            an advertised tls-connect endpoint, or null
 *     "unauthorizedFor": 3,                     `devices` calls before the wireless device flips
 *                                               from unauthorized to device (the tap on Allow)
 *     "model": "Pixel 7",
 *     "install": "Success" }                    or an INSTALL_FAILED_* line
 * State and the call log live next to the scenario file.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenarioPath = process.env.FAKE_ADB_SCENARIO;
if (!scenarioPath) { process.stderr.write('fake-adb: FAKE_ADB_SCENARIO not set\n'); process.exit(1); }
const sc = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const statePath = scenarioPath + '.state';
const logPath = scenarioPath + '.calls';
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { devicesCalls: 0, connected: [] };
const save = () => writeFileSync(statePath, JSON.stringify(st));

/* The phone's and the sidecar's reactions to what the run does. Lines go to the SCRATCH gateway
 * log device-verify is pointed at — never the real one — in its `YYYY-MM-DD HH:MM:SS` format. */
const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const gateway = (line) => {
  const f = process.env.AGENTMOB_GATEWAY_LOG;
  if (f) appendFileSync(f, `${stamp()} ${line}\n`);
};
const phoneLog = (line) => { st.logcat = (st.logcat || '') + `09-29 00:00:00.000 1 1 I AgentChannel: ${line}\n`; };

/* Drop `-P <port>` and `-s <serial>`, remembering the serial. */
let args = [...argv];
if (args[0] === '-P') args = args.slice(2);
let serial = null;
if (args[0] === '-s') { serial = args[1]; args = args.slice(2); }
appendFileSync(logPath, JSON.stringify({ serial, args }) + '\n');

const out = (s) => { process.stdout.write(s); };
const cmd = args[0];

if (cmd === 'fake-trigger') {
  /* With a REAL sidecar behind this run (SIM_SIDECAR_CTL), play only the adapter's part — push
   * TTS audio into the sidecar's socket — and let the sidecar decide the transport and log it.
   * Without one, fall back to replaying the line. */
  if (sc.speaks === false) process.exit(0);
  if (process.env.SIM_SIDECAR_CTL) {
    const { spawnSync } = await import('node:child_process');
    const here = new URL('.', import.meta.url).pathname;
    spawnSync(process.execPath, [here + 'sim-adapter-push.mjs', process.env.SIM_SIDECAR_CTL,
                                 String(sc.replySeconds || 6)], { stdio: 'ignore', timeout: 20000 });
  } else {
    gateway('[sidecar] → phone pcm START 142848b (148 frames) via WebRTC');
  }
  process.exit(0);
}

if (cmd === 'version') { out('Android Debug Bridge version 1.0.41 (fake)\n'); process.exit(0); }
if (cmd === 'start-server' || cmd === 'kill-server') process.exit(0);

if (cmd === 'mdns' && args[1] === 'services') {
  out('List of discovered mdns services\n');
  /* mdnsOnce: advertise a single time, the way a sweep find is a single event. Anything that
   * relies on rediscovery to notice a later change is exposed by this. */
  st.mdnsCalls = (st.mdnsCalls || 0) + 1; save();
  if (sc.mdns && !(sc.mdnsOnce && st.mdnsCalls > 1)) {
    out(`adb-${sc.usb || '33250DLH2000CB'}-vWDsdX\t_adb-tls-connect._tcp\t${sc.mdns}\n`);
  }
  process.exit(0);
}

if (cmd === 'connect') {
  const ep = args[1];
  if (sc.mdns && ep === sc.mdns) {
    if (!st.connected.includes(ep)) st.connected.push(ep);
    save(); out(`connected to ${ep}\n`); process.exit(0);
  }
  out(`failed to connect to '${ep}': Connection refused\n`); process.exit(1);
}
if (cmd === 'disconnect') {
  st.connected = st.connected.filter((e) => e !== args[1]); save();
  out(`disconnected ${args[1]}\n`); process.exit(0);
}

if (cmd === 'devices') {
  st.devicesCalls++; save();
  out('List of devices attached\n');
  if (sc.usb) {
    out(`${sc.usb}         device usb:1-1 product:panther model:${String(sc.model || 'Pixel 7').replace(/\s/g, '_')} device:panther transport_id:1\n`);
  }
  for (const ep of st.connected) {
    const authorised = st.devicesCalls > (sc.unauthorizedFor ?? 0);
    out(authorised
      ? `${ep}\tdevice product:panther model:${String(sc.model || 'Pixel 7').replace(/\s/g, '_')} device:panther transport_id:2\n`
      : `${ep}\tunauthorized transport_id:2\n`);
  }
  process.exit(0);
}

if (cmd === 'shell') {
  const line = args.slice(1).join(' ');
  if (/getprop ro\.product\.model/.test(line)) { out(`${sc.model || 'Pixel 7'}\n`); process.exit(0); }
  if (/getprop ro\.serialno/.test(line)) { out(`${sc.usb || '33250DLH2000CB'}\n`); process.exit(0); }
  if (/dumpsys package/.test(line)) { out('    versionName=139.0.7258.158\n'); process.exit(0); }
  if (/cmd webviewupdate/.test(line)) { out('Current WebView package (name, version): (com.google.android.webview, 139.0.7258.158)\n'); process.exit(0); }
  /* launch: am start's own output, and the process list after it */
  if (/^am force-stop/.test(line)) {
    if (st.phonePid) { try { process.kill(st.phonePid, 'SIGTERM'); } catch {} st.phonePid = null; save(); }
    process.exit(0);
  }
  if (/^am start/.test(line)) {
    out('Starting: Intent { cmp=com.agentmobile.agent/.MainActivity }\n');
    /* The app, launched: with a real sidecar behind the run, it dials in and does the protocol. */
    if (process.env.SIM_SIDECAR_URL && sc.amStart !== 'not-exported') {
      const { spawn } = await import('node:child_process');
      const here = new URL('.', import.meta.url).pathname;
      const args = [here + 'sim-phone.mjs', '--url', process.env.SIM_SIDECAR_URL,
                    '--pt', String(sc.phonePT || 111), '--hold', '600'];
      if (sc.breakWebrtc) args.push('--break-webrtc');
      const ph = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
      ph.unref(); st.phonePid = ph.pid; save();
    }
    if (sc.amStart === 'not-exported') {
      process.stderr.write('java.lang.SecurityException: Permission Denial: starting Intent { cmp=com.agentmobile.agent/.MainActivity } from null (pid=1, uid=2000) not exported from uid 10234\n');
    }
    process.exit(0);
  }
  if (/pidof/.test(line)) { if (sc.pid) out(`${sc.pid}\n`); process.exit(0); }
  if (/^wm density/.test(line)) { out('Physical density: 420\n'); process.exit(0); }
  if (/^wm size/.test(line)) { out('Physical size: 1080x2400\n'); process.exit(0); }
  if (/dumpsys window/.test(line)) { out('navigationBars frame=[0,2337][1080,2400]\n'); process.exit(0); }
  if (/dumpsys audio/.test(line)) {
    if (sc.dumpsysMute !== false) out(`  mMicMute=${!!st.micMuted}\n`);
    process.exit(0);
  }
  if (/^input tap/.test(line)) {
    const [x, y] = line.split(/\s+/).slice(2).map(Number);
    st.taps = [...(st.taps || []), [x, y]];
    /* Off the 1080x2400 screen, a tap presses nothing. The stand-in used to react to any x
     * regardless of y, which let a Stop tap at y = -163 "verify" — a fidelity gap that hid a
     * real aiming bug for as long as it existed. */
    if (!(x >= 0 && x < 1080 && y >= 0 && y < 2400)) { save(); process.exit(0); }
    if (x < 700) {
      /* the native mic button: the app mutes, logs it, and the reply keeps playing */
      if (sc.micTapLands !== false) { st.micMuted = !st.micMuted; phoneLog(`mic ${st.micMuted ? 'MUTED' : 'unmuted'} (native)`); }
      /* muteTruncates: the issue #1 regression itself — the mute cuts the reply off */
      if (sc.muteTruncates) gateway('[sidecar] → phone pcm 142848b -> 148 opus packets via WebRTC [cut short after 20/148 frames: superseded or interrupted]');
    } else {
      /* Stop: with a real sidecar, the simulated app sends the interrupt and the SIDECAR decides
       * whether anything was left to cut. Otherwise replay the line. */
      if (process.env.SIM_SIDECAR_URL && st.phonePid) {
        try { process.kill(st.phonePid, 'SIGUSR1'); } catch {}
      } else if (sc.stopTruncates !== false) {
        gateway('[sidecar] → phone pcm 142848b -> 148 opus packets via WebRTC [cut short after 61/148 frames: superseded or interrupted]');
      }
      if (sc.flushDropped !== undefined) phoneLog(`playback flushed (${sc.flushDropped} queued frame(s) dropped)`);
    }
    save(); process.exit(0);
  }
  process.exit(0);
}

if (cmd === 'logcat') { out((sc.logcat || '') + (st.logcat || '')); process.exit(0); }
if (cmd === 'exec-out') {
  const drain = (buf) => new Promise((res) => process.stdout.write(buf, res));
  /* screencap -p. A real capture (one ux-audit already rendered), or a well-formed BLACK frame,
   * which is what a sleeping phone returns and what validatePng has to catch. */
  const { readFileSync: rf } = await import('node:fs');
  const { deflateSync } = await import('node:zlib');
  if (sc.screen === 'none') process.exit(1);
  if (sc.screen === 'blank') {
    const w = 1080, h = 2400;
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
                              return Buffer.concat([l, Buffer.from(t, 'latin1'), d, Buffer.alloc(4)]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    await drain(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ih), chunk('IDAT', deflateSync(Buffer.alloc(w * h * 3))), chunk('IEND', Buffer.alloc(0))]));
    process.exit(0);
  }
  const here = new URL('.', import.meta.url).pathname;
  /* Exit only once the pipe has taken it. process.exit() straight after write() on a pipe drops
   * whatever has not drained — the first version served 246 KB and device-verify received a
   * truncated PNG with no IEND. validatePng caught it, which is its job; the bug was here.
   * A write CALLBACK is not enough either: the script carries on past it to the next branch
   * and a later process.exit() cuts the pipe just the same. Await the drain, then exit. */
  await drain(rf(here + '../audit/out/02-idle-matrix.png'));
  process.exit(0);
}

if (cmd === 'install') {
  const result = sc.install || 'Success';
  if (/^Success/.test(result)) { out('Performing Streamed Install\nSuccess\n'); process.exit(0); }
  process.stderr.write(`adb: failed to install ${args[args.length - 1]}: ${result}\n`); process.exit(1);
}

process.exit(0);
