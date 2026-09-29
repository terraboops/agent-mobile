/**
 * device-probe.test — the half of the handset run a Mac can decide.
 *
 * Every assertion here is about a value the device run computes BEFORE it touches the phone, or
 * about text the phone sends back. None of it replaces the device pass; all of it removes a way
 * for the device pass to fail for a reason that has nothing to do with the phone.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDensity, parseSize, micTapPoint, stopTapX, parseMicMute,
  parseVersionName, highestMajor, parseNavInset, parseCrash, micMuteEvents,
  stopEvidence, agentChannelLines,
} from './lib/device-probe.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\ndevice-probe — what the handset run decides before it taps anything\n');

/* ---- wm density / wm size ------------------------------------------------------------------ */
ok('density: a Pixel 7 reports 420dpi -> 2.625', parseDensity('Physical density: 420') === 2.625);
ok('density: an override line still yields the last number',
  parseDensity('Physical density: 420\nOverride density: 560') === 3.5);
ok('density: junk yields 0, not NaN', parseDensity('wm: command not found') === 0);
ok('density: nothing yields 0', parseDensity('') === 0 && parseDensity(null) === 0);

ok('size: a Pixel 7 reports 1080x2400',
  JSON.stringify(parseSize('Physical size: 1080x2400')) === '{"w":1080,"h":2400}');
ok('size: junk yields null, not a partial object', parseSize('Physical size: unknown') === null);

/* ---- where the native mic actually is ------------------------------------------------------
 * A tap that misses does nothing AND reports nothing: the run carries on and the mute stage
 * reports "not muted", which reads as issue #1 reproducing when in fact nothing was pressed. */
const P7 = { w: 1080, h: 2400, dens: 2.625, navPx: 63, micSizeDp: 72, micGapDp: 16 };
const tap = micTapPoint(P7);
ok('mic tap: horizontally centred', tap.x === 540, JSON.stringify(tap));
ok('mic tap: sits above the nav bar by gap + half the button',
  tap.y === Math.round(2400 - (63 + (16 + 36) * 2.625)), JSON.stringify(tap));
ok('mic tap: lands INSIDE the button, not on its edge',
  Math.abs(tap.y - (2400 - 63 - (16 + 36) * 2.625)) < (72 * 2.625) / 2,
  'the tap must be within half a button-height of the centre or a rounding change misses it');
ok('mic tap: is on screen', tap.y > 0 && tap.y < 2400 && tap.x > 0 && tap.x < 1080);
ok('mic tap: a bigger nav bar moves the tap UP, not down',
  micTapPoint({ ...P7, navPx: 130 }).y < tap.y,
  'gesture nav vs 3-button nav is the difference between hitting the mic and hitting the nav bar');
ok('mic tap: missing constants yield null rather than NaN coordinates',
  micTapPoint({ ...P7, micSizeDp: undefined }) === null
  && micTapPoint({ ...P7, dens: 0 }) === null,
  'tapping at NaN silently does nothing, which the run would read as the feature being broken');

ok('stop tap: sits in from the right edge', stopTapX({ w: 1080, dens: 2.625 }) === 1080 - Math.round(66 * 2.625));
ok('stop tap: is not the same point as the mic', stopTapX({ w: 1080, dens: 2.625 }) !== tap.x);
ok('stop tap: null without a density', stopTapX({ w: 1080, dens: 0 }) === null);

/* ---- the constants must be the ones MainActivity actually uses ------------------------------
 * The tap arithmetic is only right if it is fed the real numbers; the Java is the source. */
const JAVA = join(REPO, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');
const java = readFileSync(JAVA, 'utf8');
const micSize = Number((/MIC_SIZE_DP\s*=\s*(\d+)/.exec(java) || [])[1]);
const micGap = Number((/MIC_BOTTOM_GAP_DP\s*=\s*(\d+)/.exec(java) || [])[1]);
ok('constants: MIC_SIZE_DP is readable from MainActivity', Number.isFinite(micSize) && micSize > 0,
  `got ${micSize} — device-verify computes its tap from this and would produce NaN`);
ok('constants: MIC_BOTTOM_GAP_DP is readable', Number.isFinite(micGap) && micGap >= 0, `got ${micGap}`);
ok('constants: the real numbers give an on-screen tap',
  (() => { const t = micTapPoint({ ...P7, micSizeDp: micSize, micGapDp: micGap });
           return t && t.y > 0 && t.y < 2400; })(),
  'the constants in MainActivity put the computed tap off screen');

/* ---- dumpsys audio: muted / not muted / did not say ----------------------------------------
 * This is the evidence for issue #1, so a false "muted" is the most expensive wrong answer in
 * the whole run. It used to be /true/i over three grepped lines. */
ok('mic mute: mMicMute=true reads as muted', parseMicMute('  mMicMute=true') === true);
ok('mic mute: mMicMute=false reads as NOT muted', parseMicMute('  mMicMute=false') === false);
ok('mic mute: a neighbouring "true" does not make it muted',
  parseMicMute('mMicMute=false\n  mHasVibrator=true\n  mBluetoothScoOn=true') === false,
  'the old /true/i scan reported MUTED for this, which verifies issue #1 without measuring it');
ok('mic mute: the word true in unrelated prose is not a reading',
  parseMicMute('ringerModeAffectedStreams=true') === null,
  'no mic-mute field is present here at all');
ok('mic mute: nothing reported is NULL, not false',
  parseMicMute('') === null && parseMicMute(null) === null,
  '"the phone says not muted" and "the phone said nothing" need opposite responses — one is a '
  + 'failed mute, the other is a probe that needs rewriting for this Android version');
ok('mic mute: the spaced spelling is understood',
  parseMicMute('mic mute: true') === true && parseMicMute('microphone_muted = false') === false);
ok('mic mute: the most specific field wins over a later loose match',
  parseMicMute('mMicMute=false\nmic mute: true') === false,
  'mMicMute is the authoritative field; a looser line must not override it');

/* ---- WebView version reporting -------------------------------------------------------------- */
ok('webview: versionName is extracted',
  parseVersionName('  versionCode=607308733\n  versionName=139.0.7258.158') === '139.0.7258.158');
ok('webview: a package with no versionName yields null',
  parseVersionName('Unable to find package: com.android.chrome') === null);
ok('webview: the highest major across providers wins',
  highestMajor(['com.android.webview=107.0.1', 'com.android.chrome=139.0.7258.158']) === 139);
ok('webview: no providers yields null, not 0',
  highestMajor([]) === null && highestMajor(['bogus']) === null,
  '0 would compare as below every floor and report a failure the device never stated');

/* ---- nav inset ------------------------------------------------------------------------------ */
/* This assertion used to say 2400 — the frame's bottom edge, which is the whole screen — and
 * passed, because the parser returned exactly that. The inset is the bar's HEIGHT. */
ok('nav inset: the HEIGHT of the frame, not its bottom edge',
  parseNavInset('navigationBars frame=[0,2337][1080,2400]') === 63,
  `got ${parseNavInset('navigationBars frame=[0,2337][1080,2400]')} — 2400 is the screen, and `
  + 'subtracting it put every tap at y = -163');
ok('nav inset: composed with the tap, it lands ON the screen',
  (() => { const t = micTapPoint({ w: 1080, h: 2400, dens: 2.625,
             navPx: parseNavInset('navigationBars frame=[0,2337][1080,2400]'),
             micSizeDp: 72, micGapDp: 26 });
           return t && t.y > 0 && t.y < 2400; })(),
  'the two were only ever tested apart; together they aimed off the screen');
ok('tap: a point that would land off the screen is refused, not tapped',
  micTapPoint({ w: 1080, h: 2400, dens: 2.625, navPx: 2400, micSizeDp: 72, micGapDp: 26 }) === null,
  'tapping at a negative y presses nothing and the mute stage reads it as issue #1');
ok('nav inset: absent yields 0, which the tap treats as no inset',
  parseNavInset('no such thing') === 0);

/* ---- did the app actually launch, or is there merely a process? -----------------------------
 * The launch stage was `pidof` alone. Android restarts an app that throws in onCreate, so a pid
 * is present during a crash loop and the stage read VERIFIED over it. */
const PKG = 'com.agentmobile.agent';
const FATAL = [
  '10-01 01:02:03.456  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
  '10-01 01:02:03.456  1234  1234 E AndroidRuntime: Process: com.agentmobile.agent, PID: 1234',
  '10-01 01:02:03.456  1234  1234 E AndroidRuntime: java.lang.NullPointerException: ko keypair',
  '10-01 01:02:03.456  1234  1234 E AndroidRuntime: \tat com.agentmobile.agent.MainActivity.onCreate',
].join('\n');
ok('crash: a FATAL EXCEPTION for our package is found',
  (parseCrash(FATAL, PKG) || {}).kind === 'fatal', JSON.stringify(parseCrash(FATAL, PKG)));
ok('crash: the summary names the exception, not just that one happened',
  /NullPointerException/.test((parseCrash(FATAL, PKG) || {}).summary || ''),
  (parseCrash(FATAL, PKG) || {}).summary);
ok('crash: ANOTHER app crashing is not our failure',
  parseCrash(FATAL.replace(/com\.agentmobile\.agent/g, 'com.someone.else'), PKG) === null,
  'a real handset has other apps crashing in the background; failing on those makes the run '
  + 'unusable and teaches people to ignore it');
ok('crash: an ANR is reported',
  (parseCrash('10-01 E ActivityManager: ANR in com.agentmobile.agent (reason: Input dispatching timed out)', PKG) || {}).kind === 'anr');
ok('crash: a process death is reported',
  (parseCrash('10-01 I ActivityManager: Process com.agentmobile.agent (pid 1234) has died: prcp', PKG) || {}).kind === 'died');
ok('crash: an ordinary log with our package in it is NOT a crash',
  parseCrash('10-01 I agentmob: com.agentmobile.agent connected to the sidecar', PKG) === null,
  'the package name appearing in a log line is not a crash');
ok('crash: empty logcat is not a crash', parseCrash('', PKG) === null && parseCrash(null, PKG) === null);
ok('crash: no package named means no verdict, not a false positive',
  parseCrash(FATAL, '') === null && parseCrash(FATAL, null) === null,
  'without a package to attribute to, every crash on the device would be ours');

/* ---- THE PHONE'S OWN LOG AS EVIDENCE --------------------------------------------------------
 * Several device stages were 'built' — a human comparing screenshots afterwards, which is not a
 * verdict a run can carry and cannot be re-checked once the phone is gone. The app logs what it
 * did, so those halves become machine-checkable. */
const LOG_MUTE = [
  '09-29 09:10:00.000  1234  1234 I AgentChannel: mic MUTED (native)',
  '09-29 09:10:01.000  1234  1234 I AgentChannel: audio rx decoded=960 samples',
].join('\n');
ok('log: a native mute is read out of logcat',
  micMuteEvents(LOG_MUTE).length === 1 && micMuteEvents(LOG_MUTE)[0].muted === true);
ok('log: an UNMUTE is not read as a mute',
  micMuteEvents('I AgentChannel: mic unmuted (native)')[0].muted === false,
  'the toggle would report muted on the way back');
ok('log: the LAST event wins, since the tap may have toggled twice',
  (() => { const e = micMuteEvents('I AgentChannel: mic MUTED (native)\nI AgentChannel: mic unmuted (native)');
           return e.length === 2 && e[1].muted === false; })());
ok('log: another app\'s line is not ours',
  micMuteEvents('I SomeOtherTag: mic MUTED (native)').length === 0,
  'a real handset has plenty of audio logging');
ok('log: nothing logged is no events, not a false mute',
  micMuteEvents('').length === 0 && micMuteEvents(null).length === 0);

/* stop-control's machine-checkable half: HOW MANY frames were already on the phone. */
const flush = (n) => `09-29 I AgentChannel: playback flushed (${n} queued frame(s) dropped)`;
ok('stop: a flush with a big queue proves the BURST path was in use',
  (() => { const e = stopEvidence(flush(143), { forcedWs: true });
           return e.ok && e.dropped === 143; })(),
  JSON.stringify(stopEvidence(flush(143), { forcedWs: true })));
ok('stop: a forced-WS run that drops almost nothing is a FAILURE, not a pass',
  !stopEvidence(flush(2), { forcedWs: true }).ok,
  'a handful of frames is the PACED profile — the force did not take, and the run did not '
  + 'exercise the case it was for, which otherwise looks identical to success');
ok('stop: and it says which profile it saw',
  /PACED profile/.test(stopEvidence(flush(2), { forcedWs: true }).why),
  stopEvidence(flush(2), { forcedWs: true }).why);
ok('stop: the same small flush is FINE on the paced downlink',
  stopEvidence(flush(2), { forcedWs: false }).ok,
  'one frame deep is what pacing means; failing it would fail every normal run');
ok('stop: NO flush at all is a failure whatever the transport',
  !stopEvidence('I AgentChannel: something else', { forcedWs: false }).ok
  && !stopEvidence('', { forcedWs: true }).ok,
  'Stop did not reach the native layer, so whatever the audio did was not this fix');
ok('stop: the no-flush verdict says what it means',
  /did not reach the native layer/.test(stopEvidence('', {}).why));
ok('stop: the LAST flush is the one read, not the first',
  stopEvidence([flush(200), flush(3)].join('\n'), { forcedWs: false }).dropped === 3,
  'an earlier turn\'s flush would otherwise be quoted as this Stop\'s evidence');
ok('log: agentChannelLines keeps only our tag',
  agentChannelLines('I Other: x\nI AgentChannel: y').length === 1);

/* and device-verify has to actually use them */
{
  const dvSrc = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');
  {
    const few = '09-29 00:00:00.000 1 1 I AgentChannel: playback flushed (3 queued frame(s) dropped)\n';
    const many = '09-29 00:00:00.000 1 1 I AgentChannel: playback flushed (900 queued frame(s) dropped)\n';
    const e1 = stopEvidence(few, { transport: 'WS' });
    ok('stop: an UNFORCED fallback (ICE failed) is judged by the burst rule too', e1.ok === false,
      JSON.stringify(e1));
    ok('stop: and the verdict names the transport, not a force that never happened',
      /via WS in one burst/.test(e1.why) && !/forced/i.test(e1.why), e1.why);
    ok('stop: a big flush on an unforced WS reply passes', stopEvidence(many, { transport: 'UDP' }).ok === true);
    ok('stop: transport WebRTC keeps the paced rule', stopEvidence(few, { transport: 'WebRTC' }).ok === true);
  }
  ok('device-verify reads the mute out of logcat', /micMuteEvents\(/.test(dvSrc));
  ok('device-verify reads the Stop flush out of logcat', /stopEvidence\(/.test(dvSrc));
  ok('and tells stopEvidence whether the fallback was forced',
    /stopEvidence\(stopLog, \{ forcedWs: WS_FALLBACK, transport: replyVia \}\)/.test(dvSrc),
    'without that it would accept the paced profile on a run that was supposed to be bursting');
  ok('and which transport the sidecar SAID the reply went on, read off the START line',
    /phone pcm START [^\n]*via \(\\S\+\)/.test(dvSrc) && /const replyVia = speaking \? speaking\[1\]/.test(dvSrc),
    'an ICE failure falls back on its own; without the transport it is judged by the paced rule');
  ok('device-verify SAVES the log, not just greps it',
    /logcat-stop\.txt/.test(dvSrc),
    'the evidence has to outlive the phone being unplugged');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
