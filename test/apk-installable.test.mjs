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

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APK = join(REPO, 'android/app/build/outputs/apk/debug/app-debug.apk');
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
ok('targetSdk is 36 (the edge-to-edge assumption the bottom bar is built on)',
  targetSdk === 36, String(targetSdk));
ok('minSdk 24 (the @container fallback reasoning depends on this)', minSdk === 24, String(minSdk));
ok('it carries arm64-v8a, which is what a Pixel 7 runs', /arm64-v8a/.test(abis), abis);

/* ---- permissions the voice path cannot work without ------------------------------------- */
const perms = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
for (const p of ['android.permission.RECORD_AUDIO', 'android.permission.INTERNET',
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
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
