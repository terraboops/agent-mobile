/**
 * ws-fallback.test — forcing the transport the device run would otherwise never take.
 *
 * WHY. The WebRTC downlink is PACED at 20ms/frame; the WS one is BURST. That is the whole
 * reason Stop behaved differently on each — on WebRTC the phone's queue is about one frame
 * deep, on WS the entire remainder of a reply can already be on the device. stop-control's
 * flush was written for the WS case, and a device run negotiates WebRTC, so without a way to
 * force the fallback the run would exercise the easy path and report a pass over the case the
 * fix exists for.
 *
 * WHAT THIS CANNOT SHOW: that forcing it on a handset produces the truncation the fix promises.
 * That is a device fact and stop-control stays open on it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SC = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nws-fallback — making the burst path reachable on purpose\n');

const sc = readFileSync(SC, 'utf8');
const dv = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');

/* ---- the sidecar honours it, and the downlink decision is where it bites ------------------- */
ok('the sidecar has a forceWsDownlink switch', /function forceWsDownlink\(\)/.test(sc));
ok('it gates the DOWNLINK decision, not something adjacent',
  /const viaW = !forceWsDownlink\(\) && !!\(target\.webrtc && target\.webrtc\.ready\)/.test(sc),
  'forcing it would not change which transport carries the reply');
ok('an env var can set it, for a scoped instance or an e2e run',
  /AGENTMOB_FORCE_WS_DOWNLINK/.test(sc));
ok('and a marker FILE can, for the live sidecar with no restart',
  /FORCE_WS_FILE/.test(sc) && /existsSync\(FORCE_WS_FILE\)/.test(sc),
  'the device run would need the gateway bounced, which is not a thing to do mid-pass');
ok('the file is re-read on a timer, not once at startup',
  /_forceWsAt/.test(sc) && /> 1000/.test(sc),
  'a value read once could not be turned on for one phase of a run');
ok('and not once per FRAME',
  /now - _forceWsAt > 1000/.test(sc),
  'a reply is hundreds of frames; a stat per frame would show up as jitter');

/* ---- it has to ANNOUNCE itself ---------------------------------------------------------------
 * A forced fallback nobody notices is a run whose result means something other than what the
 * reader thinks — the exact shape this project keeps finding in its own reporting. */
ok('turning it on is logged', /WS DOWNLINK FORCED/.test(sc));
ok('turning it off is logged too', /no longer forced/.test(sc),
  'a run that cleared the marker and a run that never set it would look the same');
ok('every forced reply is marked in the transport line',
  /\[FORCED\]/.test(sc),
  'the per-reply line is what a device run greps; without the tag a forced WS reply reads like '
  + 'a genuine fallback, which is a different finding entirely');
ok('the announcement says the path BURSTS, which is the point',
  /BURSTS a reply/.test(sc));

/* ---- the device run can drive it, and cannot leave it behind -------------------------------- */
ok('device-verify takes --ws-fallback', /--ws-fallback/.test(dv));
ok('it writes the marker the sidecar reads',
  /\.force-ws-downlink/.test(dv) && /writeFileSync\(FORCE_WS_FILE/.test(dv));
ok('it waits for the sidecar to notice before speaking',
  /sidecar re-reads the marker/.test(dv) && /await sleep\(1500\)/.test(dv),
  'the turn would start before the switch took effect and take WebRTC anyway');
ok('the run REPORTS that it forced the path',
  /WS fallback forced for this run/.test(dv),
  'a report of a forced run and of a normal one must not read the same');
ok('a failure to set it is a FAILED stage, not a silent normal run',
  /set \? 'built' : 'failed'/.test(dv),
  'the run would exercise WebRTC while the report said otherwise');
ok('finish() clears the marker',
  /const finish = \(code\) => \{[\s\S]{0,400}?setForcedWs\(false\)/.test(dv),
  'a forced fallback left on disk would degrade every later conversation on this machine');
ok('and clears it FIRST, before anything that can throw',
  (() => { const f = dv.slice(dv.indexOf('const finish = (code) => {'));
           return f.indexOf('setForcedWs(false)') < f.indexOf('stopAdb()'); })(),
  'a throw in the report writer would leave the machine in diagnostic mode');
ok('clearing tolerates a marker that is already gone',
  /rmSync\(FORCE_WS_FILE, \{ force: true \}\)/.test(dv));
ok('and a failure to clear is reported rather than swallowed',
  /could not \$\{on \? 'set' : 'clear'\}/.test(dv),
  'silently failing to clear is how the machine stays in diagnostic mode');

/* ---- the marker must not be lying around right now ------------------------------------------ */
{
  const { existsSync } = await import('node:fs');
  ok('no forced-fallback marker is left on this machine',
    !existsSync(join(homedir(), '.hermes/plugins/agentmob/sidecar/.force-ws-downlink')),
    'the live sidecar is in diagnostic mode: every reply is being burst over the WebSocket');
}

console.log('\n  This asserts the switch works and cannot be left on. That forcing it on a');
console.log('  handset produces the truncation stop-control needs is a device fact, and that');
console.log('  item stays open.');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
