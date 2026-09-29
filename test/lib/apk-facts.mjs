/**
 * apk-facts — what can be known about the built APK without a phone.
 *
 * Shared deliberately. These checks were written inside apk-installable, and device-verify needed
 * the same ones for a preflight that runs BEFORE the device gate. Two copies of "do the bundled
 * assets match www/" would drift, and a drifting duplicate of a staleness check is worse than no
 * check: one of them goes green on a stale bundle and nobody knows which.
 *
 * Everything here is local. No adb, no handset.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APK = join(REPO, 'android/app/build/outputs/apk/debug/app-debug.apk');
const SDK = process.env.ANDROID_HOME || '/opt/homebrew/share/android-commandlinetools';

export function buildTool(name) {
  const base = join(SDK, 'build-tools');
  if (!existsSync(base)) return null;
  for (const v of readdirSync(base).sort().reverse()) {
    const p = join(base, v, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** minSdkVersion as the PROJECT declares it (the source of truth the APK must match). */
export function declaredMinSdk() {
  try {
    const g = readFileSync(join(REPO, 'android', 'variables.gradle'), 'utf8');
    const m = /minSdkVersion\s*=\s*(\d+)/.exec(g);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** package / minSdk / targetSdk as the BUILT APK declares them. */
export function apkBadging(apk = APK) {
  const aapt2 = buildTool('aapt2');
  if (!aapt2 || !existsSync(apk)) return null;
  const r = spawnSync(aapt2, ['dump', 'badging', apk], { encoding: 'utf8', timeout: 60000 });
  const t = r.stdout || '';
  const g = (re) => (re.exec(t) || [])[1];
  return {
    pkg: g(/package: name='([^']+)'/),
    minSdk: Number(g(/minSdkVersion:'(\d+)'/)),
    targetSdk: Number(g(/targetSdkVersion:'(\d+)'/)),
  };
}

/**
 * Do the APK's bundled web assets match the current www/ source?
 *
 * Capacitor copies www/ verbatim into assets/public/, so this is a byte comparison. NOT mtime:
 * the mutation harness rewrites www/ files on restore, which makes timestamps useless here.
 *
 * `wwwDir` is injectable ONLY so a test can point it at a fixture that deliberately differs.
 * Without that, "every asset matches" is unfalsifiable: when they all match, a comparator that
 * can never report a difference produces exactly the same green — which is how a mutation
 * deleting the comparison went MISSED.
 *
 * @returns {{ok, mismatched: string[], missing: string[], checked: number, reason?: string}}
 */
export function bundleMatchesWww(apk = APK, { wwwDir = join(REPO, 'www') } = {}) {
  if (!existsSync(apk)) return { ok: false, mismatched: [], missing: [], checked: 0,
                                 reason: 'no APK' };
  const tmp = mkdtempSync(join(tmpdir(), 'apk-facts-'));
  try {
    const un = spawnSync('unzip', ['-q', '-o', apk, 'assets/public/*', '-d', tmp],
      { encoding: 'utf8', timeout: 120000 });
    if (un.status !== 0) {
      return { ok: false, mismatched: [], missing: [], checked: 0, reason: 'unzip failed' };
    }
    const want = readdirSync(wwwDir).filter((f) => /\.(html|js|css)$/.test(f));
    const mismatched = [];
    const missing = [];
    for (const f of want) {
      const inApk = join(tmp, 'assets', 'public', f);
      if (!existsSync(inApk)) { missing.push(f); continue; }
      if (sha(inApk) !== sha(join(wwwDir, f))) mismatched.push(f);
    }
    return { ok: mismatched.length === 0 && missing.length === 0,
             mismatched, missing, checked: want.length };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Everything device-verify can check before it has a phone.
 * Each entry is {name, status: 'verified'|'failed'|'blocked', detail}.
 */
export function localApkPreflight() {
  const out = [];
  const declared = declaredMinSdk();

  if (!existsSync(APK)) {
    out.push({ name: 'APK present', status: 'blocked',
      detail: `${APK} — build it first: npx cap sync android, then assembleDebug via a JDK `
            + 'gradle supports (see test/lib/android-build.mjs)' });
    return out;   // nothing below can be judged without the file
  }
  out.push({ name: 'APK present', status: 'verified', detail: APK });

  const b = apkBadging();
  if (!b) {
    out.push({ name: 'APK declares its SDK levels', status: 'blocked',
      detail: 'aapt2 not found; install Android build-tools or set ANDROID_HOME' });
  } else {
    /* A stale APK carrying an older floor would install on devices the current code cannot run
     * on — the exact failure raising minSdk to 33 was meant to prevent. */
    out.push({ name: 'APK minSdk matches the project declaration',
      status: b.minSdk === declared ? 'verified' : 'failed',
      detail: `APK ${b.minSdk} vs variables.gradle ${declared}`
            + (b.minSdk === declared ? '' : ' — the APK predates the change; rebuild before installing') });
  }

  /* The one that has already bitten: an APK that installs cleanly and shows the OLD surface. */
  const bundle = bundleMatchesWww();
  out.push({ name: 'bundled web assets match www/',
    status: bundle.ok ? 'verified' : 'failed',
    detail: bundle.reason ? bundle.reason
      : bundle.ok ? `${bundle.checked} file(s) byte-identical`
      : `stale: ${bundle.mismatched.join(', ')}${bundle.missing.length ? ` | missing: ${bundle.missing.join(', ')}` : ''}`
        + ' — this would install cleanly and behave like the bug you already fixed' });
  return out;
}
