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
  parseVersionName, highestMajor, parseNavInset,
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
ok('nav inset: read out of a dumpsys window frame',
  parseNavInset('navigationBars frame=[0,2337][1080,2400]') === 2400);
ok('nav inset: absent yields 0, which the tap treats as no inset',
  parseNavInset('no such thing') === 0);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
