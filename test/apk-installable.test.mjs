/**
 * apk-installable.test — would this APK actually install, and would `-r` keep the identity?
 *
 * device-verify's install stage has never run. "The file exists" is not the same claim as "this
 * would install", and the gap between them contains one consequence that is easy to miss:
 *
 *   `adb install -r` only REPLACES IN PLACE when the new APK is signed by the same certificate
 *   as the installed one. If the signer differs, the install fails and the only way forward is
 *   an uninstall — which wipes app-private SharedPreferences, ROTATES the IdentityStore
 *   keypair, and silently invalidates the pinning decision built on client_id 42c55608.
 *
 * So the signer check is not hygiene, it is the difference between keeping and losing the
 * identity the archives identified. Checked here rather than discovered on the phone.
 *
 * Run: npm run apk-installable
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleMatchesWww, declaredMinSdk, APK, DEBUG_APK, RELEASE_APK }
  from './lib/apk-facts.mjs';
import { launcherActivity, canAmStart, parseAmStartRefusal, parseInstallFailure,
         parseActivities }
  from './lib/manifest-facts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools';
const KEYSTORE = join(homedir(), '.android/debug.keystore');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

function buildTool(name) {
  const base = join(SDK, 'build-tools');
  if (!existsSync(base)) return null;
  const { readdirSync } = require('node:fs');
  for (const v of readdirSync(base).sort().reverse()) {
    const p = join(base, v, name);
    if (existsSync(p)) return p;
  }
  return null;
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

const aapt2 = buildTool('aapt2');
const apksigner = buildTool('apksigner');

if (!existsSync(APK)) { console.log(`skip: no APK at ${APK} — run a gradle assembleDebug`); process.exit(0); }
if (!aapt2 || !apksigner) { console.log(`skip: no build-tools under ${SDK}`); process.exit(0); }

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/* ---- structure: does it match what device-verify will ask Android for? -------------------- */
const badging = run(aapt2, ['dump', 'badging', APK]);
const pkg = (badging.match(/package: name='([^']+)'/) || [])[1];
const launch = (badging.match(/launchable-activity: name='([^']+)'/) || [])[1];
const minSdk = Number((badging.match(/minSdkVersion:'(\d+)'/) || [])[1]);
const targetSdk = Number((badging.match(/targetSdkVersion:'(\d+)'/) || [])[1]);
const abis = (badging.match(/native-code: (.+)/) || [])[1] || '';

const dvSrc = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');
const dvPkg = (dvSrc.match(/const PKG = '([^']+)'/) || [])[1];

ok('the APK declares a package', !!pkg, String(pkg));
ok('it is the package device-verify installs and launches', pkg === dvPkg,
  `apk ${pkg} vs device-verify ${dvPkg}`);
ok('the launch activity exists and is the one device-verify starts',
  launch === `${pkg}.MainActivity`,
  `${launch} — device-verify runs am start -n ${dvPkg}/.MainActivity`);

/* ---- EXISTING IS NOT REACHABLE -------------------------------------------------------------
 * The assertion above proves the activity is in the APK. It does not prove Android will let adb
 * start it. A launcher that is not exported installs perfectly and then refuses `am start` with
 * a SecurityException: the process never comes up, nothing of ours runs, and the launch stage
 * reports "no process and no crash in logcat" — the crash attribution added alongside this
 * cannot help, because the refusal is a failure of the START, not of the app.
 *
 * Read from the SHIPPED manifest rather than android/app/src/main/AndroidManifest.xml: the
 * source is one input to a merge, and a library manifest can flip an attribute on the way
 * through. Since targetSdk 31 a missing android:exported on a component with an intent-filter
 * fails the install outright, so the case that actually gets here is exported="false". */
const xmltree = run(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', APK]);
const dvComponent = (dvSrc.match(/am', 'start', '-n', `\$\{PKG\}\/(\.[\w.]+)`/) || [])[1]
  || '.MainActivity';
const launcher = launcherActivity(xmltree);
/* `!!launcher` alone was not enough, and a mutation said so: the LAUNCHER category is found by
 * a line match, not by an attribute, so breaking the ATTRIBUTE parser still produced a record —
 * with every field null. A record whose name is null is not a parse, it is the shape of one. */
ok('the shipped manifest was parsed into activities',
  !!launcher && !!launcher.name,
  `launcher=${JSON.stringify(launcher)} — no named activity carrying the LAUNCHER category was `
  + 'found in the APK. Either the attribute parse broke or the app has no launcher, and both '
  + 'make every assertion below vacuous');
ok('the launcher activity declares android:exported',
  launcher && launcher.exported !== null,
  `exported=${launcher && launcher.exported} — since targetSdk 31 this must be explicit`);
const reach = canAmStart(xmltree, dvComponent);
ok(`am start can reach the component device-verify names (${dvComponent})`, reach.ok, reach.reason);

/* Both ways. Every assertion above passes on a manifest that is already correct, so the same
 * checks are run against dumps that are definitely wrong — otherwise a parser that returned
 * "exported" for everything would look identical from here. */
const FIX_NOT_EXPORTED = xmltree.replace(
  /(:exported\(0x[0-9a-fA-F]+\)=)true/, '$1false');
ok('control: the shipped dump and the altered one really differ',
  FIX_NOT_EXPORTED !== xmltree, 'the exported attribute was not found to alter, so the negative '
  + 'control below proves nothing');
ok('control: exported=false is REFUSED', !canAmStart(FIX_NOT_EXPORTED, dvComponent).ok,
  'a non-exported launcher read as startable');
ok('control: the refusal says WHY, naming exported',
  /not exported/.test(canAmStart(FIX_NOT_EXPORTED, dvComponent).reason),
  canAmStart(FIX_NOT_EXPORTED, dvComponent).reason);
ok('control: a component that is not in the manifest is refused',
  !canAmStart(xmltree, '.NoSuchActivity').ok
  && /does not exist/.test(canAmStart(xmltree, '.NoSuchActivity').reason),
  canAmStart(xmltree, '.NoSuchActivity').reason);
/* A SIBLING ELEMENT ENDS THE ACTIVITY. The `/^E: /` half of that test had nothing behind it:
 * every fixture had well-formed nesting, so dropping it — which would end an activity on any
 * shallower line at all, including an attribute — changed nothing. A manifest with a provider
 * after the activity is the ordinary case. */
{
  const TWO = ['  E: activity (line=1)',
               '    A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.x.Main" (Raw: "")',
               '    A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true',
               '      E: intent-filter (line=4)',
               '          E: category (line=5)',
               '            A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "")',
               '  E: provider (line=7)',
               '    A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.x.Provider" (Raw: "")',
               '    A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false'].join('\n');
  const acts = parseActivities(TWO);
  ok('control: a provider after the activity does not become part of it',
    acts.length === 1 && acts[0].name === 'com.x.Main' && acts[0].exported === true,
    JSON.stringify(acts));
  ok('control: and the provider\'s exported=false does not overwrite the activity\'s',
    canAmStart(TWO, '.Main').ok,
    'a later element bleeding into the activity would report the launcher as not exported');
}

ok('control: an empty dump does not read as startable',
  !canAmStart('', dvComponent).ok && launcherActivity('') === null);

/* And the DEVICE-SIDE half of the same blind spot: device-verify keeps what `am start` printed
 * and names the refusal, instead of letting it fall through to "no process". The parse is here
 * because this is the suite that owns the exported claim. */
ok('device-verify keeps what am start printed', /const amOut = adb\(/.test(dvSrc),
  'the launch stage discards am start output again, so a refusal would read as "no process"');
ok('am start refusal: a not-exported SecurityException is recognised',
  parseAmStartRefusal('Starting: Intent { cmp=com.agentmobile.agent/.MainActivity }\n'
    + 'java.lang.SecurityException: Permission Denial: starting Intent ... not exported from uid 10234')
  === 'the launch component is not exported — Android refused the start');
ok('am start refusal: a missing component is told apart from a refusal',
  parseAmStartRefusal('Error type 3\nError: Activity class {com.x/.Nope} does not exist.')
  === 'the launch component does not exist under that name');
ok('am start refusal: an ordinary successful start is NOT a refusal',
  parseAmStartRefusal('Starting: Intent { cmp=com.agentmobile.agent/.MainActivity }') === null,
  'every launch would be reported as refused');
ok('am start refusal: empty output is not a refusal',
  parseAmStartRefusal('') === null && parseAmStartRefusal(null) === null);

/* ---- THE INSTALL FAILURE WHOSE OBVIOUS FIX IS DESTRUCTIVE ----------------------------------
 * `-r` was asserted as a flag in device-verify's argv. That says the right command is run; it
 * says nothing about what happens when it fails. One failure matters more than the rest: a
 * signer mismatch cannot be replaced in place, the documented fix is `adb uninstall`, and
 * app-private storage holds the IdentityStore keypair the sidecar's allowlist pins. Uninstalling
 * rotates the phone's identity, the gateway then refuses it as an unknown client, and a handset
 * has to be re-paired to recover from a build flag.
 *
 * Real adb output, not a paraphrase — this is what a Pixel prints. */
const SIGNER_STDERR = 'Performing Streamed Install\n'
  + 'adb: failed to install /path/app-release.apk: Failure '
  + '[INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.agentmobile.agent signatures do '
  + 'not match newer version; ignoring!]';
const signer = parseInstallFailure(SIGNER_STDERR);
ok('install failure: a signer mismatch is recognised',
  signer && signer.code === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE', JSON.stringify(signer));
ok('install failure: the verdict says NOT to uninstall, in words',
  signer && /DO NOT UNINSTALL/.test(signer.verdict),
  'the operator is left to find the documented fix, which is the destructive one');
ok('install failure: the verdict says WHY not — the pinned identity',
  signer && /IdentityStore|identity/i.test(signer.verdict) && /pin/i.test(signer.verdict),
  signer && signer.verdict);
ok('install failure: it is flagged for the caller, not only for a human reader',
  signer && signer.doNotUninstall === true,
  'device-verify raises a second stage off this flag; a verdict only a person can parse cannot '
  + 'drive that');
ok('install failure: it names the fix that is not destructive',
  signer && /same keystore|rebuild/i.test(signer.verdict), signer && signer.verdict);

/* The other direction. A classifier that returns the signer verdict for everything would pass
 * every assertion above, and would tell someone not to uninstall over a full disk. */
const OTHER = [
  ['Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', 'INSTALL_FAILED_INSUFFICIENT_STORAGE'],
  ['Failure [INSTALL_FAILED_OLDER_SDK]', 'INSTALL_FAILED_OLDER_SDK'],
  ['Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries]',
   'INSTALL_FAILED_NO_MATCHING_ABIS'],
  ['Failure [INSTALL_FAILED_VERSION_DOWNGRADE]', 'INSTALL_FAILED_VERSION_DOWNGRADE'],
  ['adb: error: device unauthorized.', 'UNAUTHORIZED'],
];
for (const [text, code] of OTHER) {
  const f = parseInstallFailure(text);
  ok(`install failure: ${code} is told apart from a signer mismatch`,
    f && f.code === code && f.doNotUninstall === false, JSON.stringify(f));
}
ok('install failure: an unrecognised error is reported as unrecognised, not guessed',
  (() => { const f = parseInstallFailure('Failure [INSTALL_FAILED_SOMETHING_NEW]');
           return f && f.code === 'UNKNOWN' && f.doNotUninstall === false
                    && /not one this run recognises/.test(f.verdict); })(),
  JSON.stringify(parseInstallFailure('Failure [INSTALL_FAILED_SOMETHING_NEW]')));
ok('install failure: an unrecognised error still carries the raw text to act on',
  /INSTALL_FAILED_SOMETHING_NEW/.test(parseInstallFailure('Failure [INSTALL_FAILED_SOMETHING_NEW]').verdict),
  'naming it "unknown" and dropping the evidence is worse than dumping stderr');
ok('install failure: SUCCESS is not a failure',
  parseInstallFailure('Performing Streamed Install\nSuccess') === null,
  'every successful install would be reported as failed');
ok('install failure: no output at all is its own verdict',
  (parseInstallFailure('') || {}).code === 'NO_OUTPUT'
  && (parseInstallFailure(null) || {}).code === 'NO_OUTPUT',
  'silence read as success would report an install that never happened');

/* And the wiring: device-verify must actually use it, and raise the second stage off the flag. */
ok('device-verify classifies the install result rather than dumping stderr',
  /parseInstallFailure\(/.test(dvSrc) && !/\(r\.stderr \|\| r\.stdout\)\.trim\(\)/.test(dvSrc),
  'the install stage prints raw adb output again');
/* ---- BOTH staged APKs, because the operator can pick either ---------------------------------
 *
 * This file checks ONE apk — whichever AGENTMOB_APK names, debug by default. Two are staged: the
 * debug build and the release build device-leg.md tells the operator to install. If their
 * signers ever diverge, alternating between them produces INSTALL_FAILED_UPDATE_INCOMPATIBLE —
 * the exact failure the verdict above exists for, triggered by following our own instructions.
 * The release variant is signed with the debug keystore precisely so this cannot happen
 * (android/app/build.gradle), and until now nothing checked that it still does. */
{
  const both = [DEBUG_APK, RELEASE_APK].filter((p) => existsSync(p));
  ok('at least one APK is staged to check', both.length >= 1, 'neither build output exists');
  if (both.length === 2) {
    const digests = both.map((p) => {
      const v = run(apksigner, ['verify', '--print-certs', p]);
      return (v.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/) || [])[1] || null;
    });
    ok('both staged APKs report a signer', digests.every(Boolean), JSON.stringify(digests));
    ok('the debug and release APKs share ONE signer, so either can replace the other',
      digests[0] && digests[0] === digests[1],
      `debug ${String(digests[0]).slice(0, 16)}… vs release ${String(digests[1]).slice(0, 16)}… `
      + '— installing one over the other would fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE, and '
      + 'the only documented way out of that destroys the pinned identity');
  } else {
    ok('only one APK is staged, so there is nothing to diverge', true,
      `staged: ${both.map((p) => p.replace(REPO + '/', '')).join(', ')}`);
  }
}

ok('device-verify raises a DO NOT UNINSTALL stage off the flag',
  /fail\.doNotUninstall/.test(dvSrc) && /DO NOT UNINSTALL to recover/.test(dvSrc),
  'the flag is computed and never acted on');
ok('targetSdk is 36 (the edge-to-edge assumption the bottom bar is built on)',
  targetSdk === 36, String(targetSdk));
/* The SHIPPED minSdk must match what the project declares.
 *
 * This used to assert `minSdk === 24` with the note "the @container fallback reasoning depends
 * on this" — a hardcoded number propping up a premise that turned out to be false. Android lint
 * had never run; when it did, the Java was calling API 33 inside the AEAD handshake path, so 24
 * was a promise the code could not keep. Pinning the literal meant this assertion would have
 * FOUGHT the correction.
 *
 * Comparing the APK against variables.gradle instead checks the thing that can actually go
 * wrong — a stale build carrying a different floor than the source declares — and lets the
 * number move when the code's real requirements move. android-lint is what keeps the number
 * itself honest. */
const declared = declaredMinSdk();
ok('the project declares a minSdkVersion', Number.isInteger(declared), String(declared));
ok('the APK\'s minSdk matches android/variables.gradle', minSdk === declared,
  `APK says ${minSdk}, variables.gradle says ${declared} — the APK predates the change, `
  + 'so it would install on devices the current code cannot run on');
ok('it carries arm64-v8a, which is what a Pixel 7 runs', /arm64-v8a/.test(abis), abis);

/* ---- permissions the voice path cannot work without ------------------------------------- */
const perms = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
/* MODIFY_AUDIO_SETTINGS is load-bearing for issue #1 and easy to drop by accident.
 *
 * The native mic toggle calls AudioManager.setMicrophoneMute(), which REQUIRES this permission.
 * The call site wraps it in `catch (Exception e) { Log.w(...) }` and sets the `micMuted` field
 * BEFORE attempting it, so without the permission the mute silently does nothing while the badge
 * still renders "muted" — the UI would claim the mic is off while it is live. That is the worst
 * shape of failure this project has: a control that lies about a microphone.
 *
 * Asserted against the built APK's own manifest, not the source, because the source declaring it
 * and the shipped artifact carrying it are different claims. */
for (const p of ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET',
                 'android.permission.MODIFY_AUDIO_SETTINGS',
                 'android.permission.FOREGROUND_SERVICE',
                 'android.permission.FOREGROUND_SERVICE_MICROPHONE']) {
  ok(`declares ${p.replace('android.permission.', '')}`, perms.includes(p));
}

/* ---- signature: valid, and modern enough for this targetSdk ------------------------------ */
const verify = run(apksigner, ['verify', '--verbose', '--print-certs', APK]);
const v2 = /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(verify);
const signers = Number((verify.match(/Number of signers: (\d+)/) || [])[1]);
const apkSha = (verify.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/) || [])[1];

ok('the APK signature verifies', /Verified\b/.test(verify) && !!apkSha);
ok('signed with v2 or better (required for targetSdk 30+)', v2, verify.split('\n')[0]);
ok('exactly one signer', signers === 1, String(signers));

/* ---- THE ONE THAT MATTERS: would `-r` keep the IdentityStore? ----------------------------- */
if (!existsSync(KEYSTORE)) {
  ok('the debug keystore is present to compare against', false, KEYSTORE);
} else {
  const kt = execFileSync('keytool',
    ['-list', '-v', '-keystore', KEYSTORE, '-storepass', 'android', '-alias', 'androiddebugkey'],
    { encoding: 'utf8' });
  const ksSha = (kt.match(/SHA256:\s*([0-9A-F:]+)/) || [])[1];
  const norm = (s) => String(s || '').replace(/:/g, '').toLowerCase();

  ok('the keystore fingerprint was read', !!ksSha, String(ksSha));
  ok('the APK is signed by the DEBUG KEYSTORE, so `adb install -r` replaces in place',
    norm(ksSha) === norm(apkSha),
    `apk ${norm(apkSha).slice(0, 16)}… vs keystore ${norm(ksSha).slice(0, 16)}… — a mismatch `
    + `forces an UNINSTALL, which wipes SharedPreferences, rotates the IdentityStore keypair, `
    + `and invalidates the pinning decision built on client_id 42c55608`);

  /* The keystore predating the phone's sessions is what makes the above conclusive: the build
   * already on the handset was signed by this same certificate. */
  const ksAge = statSync(KEYSTORE).mtime;
  ok('the keystore predates the phone sessions in the archives (2026-08-13)',
    ksAge < new Date('2026-08-13T00:00:00'),
    `keystore mtime ${ksAge.toISOString().slice(0, 10)} — if it were newer, the installed build `
    + `was signed by a different key and -r would fail`);
}

/* ---- and the install stage must actually use -r ------------------------------------------- */
ok('device-verify installs with -r', /'install', '-r', APK/.test(dvSrc),
  'without -r the install wipes app data and rotates the identity');

console.log(`\n  package ${pkg} | minSdk ${minSdk} target ${targetSdk} | signer ${String(apkSha).slice(0, 16)}…`);
/* ---- does this APK actually carry the CURRENT surface? -------------------------------------
 * Everything above says the file would install and would replace in place. None of it says the
 * file is the one you meant to install. That gap was not hypothetical: on 2026-09-27 this suite
 * passed 17/17 against an APK built BEFORE commit 16e58df — the issue #2 fix itself — so the
 * handset would have received the surface the fix replaced, with every assertion green.
 *
 * The comparison itself lives in test/lib/apk-facts.mjs because device-verify needs the same
 * check for its pre-device preflight. It was inline here first; two copies of a staleness check
 * drift, and then one of them goes green on a stale bundle and nobody knows which. */
{
  /* POSITIVE CONTROL: the comparator must be able to SAY a file differs.
   *
   * "every bundled asset matches" is satisfied by a comparator that can never find a mismatch —
   * and when the APK is fresh, both look identical. Proven, not theorised: a mutation deleting
   * the comparison went MISSED against this suite. So point it at a fixture whose contents
   * deliberately differ and require it to notice. */
  {
    const { mkdtempSync, writeFileSync: wf, readdirSync: rd, copyFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const fixture = mkdtempSync(join(tmpdir(), 'apk-ctl-'));
    const wwwDir = join(REPO, 'www');
    for (const f of rd(wwwDir)) {
      if (/\.(html|js|css)$/.test(f)) copyFileSync(join(wwwDir, f), join(fixture, f));
    }
    const victim = rd(fixture).find((f) => f.endsWith('.js'));
    wf(join(fixture, victim), readFileSync(join(fixture, victim), 'utf8') + '\n/* drift */\n');
    const ctl = bundleMatchesWww(APK, { wwwDir: fixture });
    ok('the asset comparator DETECTS a file that differs', ctl.mismatched.includes(victim),
      `mismatched=${JSON.stringify(ctl.mismatched)} — if it cannot report a difference, `
      + '"every bundled asset matches" below is unfalsifiable');
  }

  const bundle = bundleMatchesWww();
  ok('the APK bundle could be read', !bundle.reason, bundle.reason || '');
  ok('checked a meaningful number of web assets', bundle.checked >= 3, `${bundle.checked} files`);
  ok('every bundled web asset matches the current www/ source', bundle.mismatched.length === 0,
    `stale in the APK: ${bundle.mismatched.join(', ')}\n`
    + '       rebuild before installing (npx cap sync android, then assembleDebug through a JDK '
    + 'gradle supports — see test/lib/android-build.mjs)\n'
    + '       this APK would install cleanly and show the OLD surface, which is the failure mode '
    + 'that looks like the bug came back');
  ok('no www/ asset is missing from the bundle', bundle.missing.length === 0,
    `absent from the APK: ${bundle.missing.join(', ')}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
