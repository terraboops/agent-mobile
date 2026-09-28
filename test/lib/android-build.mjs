/**
 * android-build — run a gradle task with a JDK gradle can actually use.
 *
 * WHY THIS IS NOT JUST `./gradlew`. This machine's default java is Temurin 25, and Gradle's
 * Groovy cannot parse a build script under it: "Unsupported class file major version 69",
 * thrown while evaluating the root project. It surfaced only after a build-script edit forced a
 * re-parse, because a warm daemon had been serving previously-compiled scripts — so
 * `./gradlew assembleDebug` appeared to work right up until something changed.
 *
 * That near-miss is the reason this file exists rather than a note in a README. A build command
 * that works from a warm daemon and fails from cold is indistinguishable from a working one
 * until the day it matters, and `npm run apk-installable` was already TELLING people to run
 * exactly that command when the bundle went stale.
 *
 * So: find a JDK gradle supports, pass it explicitly, and say which one was used.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ANDROID = join(REPO, 'android');

/** Gradle 8.x tops out well below 25; 17 and 21 are the LTS releases it supports. */
const WANT_MAJORS = [21, 17];

/** Candidate JDK homes, best first. */
export function candidateJdks() {
  const out = [];
  if (process.env.AGENTMOB_JAVA_HOME) out.push(process.env.AGENTMOB_JAVA_HOME);
  for (const major of WANT_MAJORS) {
    out.push(`/opt/homebrew/opt/openjdk@${major}/libexec/openjdk.jdk/Contents/Home`);
    out.push(`/usr/local/opt/openjdk@${major}/libexec/openjdk.jdk/Contents/Home`);
  }
  /* Android Studio bundles a JBR that is always a supported version. */
  out.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  /* Anything installed system-wide, newest first — filtered by version below. */
  const sys = '/Library/Java/JavaVirtualMachines';
  if (existsSync(sys)) {
    for (const d of readdirSync(sys).sort().reverse()) out.push(join(sys, d, 'Contents', 'Home'));
  }
  return out.filter((p) => existsSync(join(p, 'bin', 'java')));
}

/** The major version a JDK home reports, or null. */
export function javaMajor(home) {
  const r = spawnSync(join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
  const t = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /version "(\d+)[.")]/.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * The first candidate gradle can use.
 * @returns {{home: string, major: number}|null}
 */
export function resolveJdk() {
  for (const home of candidateJdks()) {
    const major = javaMajor(home);
    if (major && WANT_MAJORS.includes(major)) return { home, major };
  }
  /* Nothing preferred: accept anything <= 21 rather than failing outright, since an older
   * supported JDK is still better than the default that cannot parse the script at all. */
  for (const home of candidateJdks()) {
    const major = javaMajor(home);
    if (major && major <= 21) return { home, major };
  }
  return null;
}

/**
 * Run a gradle task. Returns { ok, status, stdout, stderr, jdk, reason }.
 * Never throws: a missing JDK is a reportable state, not a crash.
 */
export function gradle(args, { timeout = 900000 } = {}) {
  const jdk = resolveJdk();
  if (!jdk) {
    return { ok: false, status: null, stdout: '', stderr: '', jdk: null,
             reason: 'no JDK 17 or 21 found. Gradle cannot parse its build scripts under Java 25 '
                   + '("Unsupported class file major version 69"). Install one '
                   + '(brew install openjdk@21) or set AGENTMOB_JAVA_HOME.' };
  }
  const r = spawnSync(join(ANDROID, 'gradlew'), args, {
    cwd: ANDROID, encoding: 'utf8', timeout,
    env: { ...process.env, JAVA_HOME: jdk.home },
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
           jdk, reason: null };
}
