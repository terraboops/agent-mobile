/**
 * java-exec — compile a harness around SHIPPED method bodies with javac, run it, read JSON lines.
 *
 * The source-reading suites (stop-flush, java-mic) answer "does the text say the right thing";
 * attacked with behaviour mutants that keep the text, both let real defects through — a flush
 * count taken after clearing, an unmute that never reached the hardware. The bodies are lifted
 * from the file the APK is built from (see java-facts methodBody), so a change there is a change
 * to what runs here. The harness supplies stubs for the Android classes they touch; the stubs
 * record calls and decide nothing.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function haveJavac() {
  return spawnSync('javac', ['-version'], { encoding: 'utf8' }).status === 0;
}

/**
 * @returns {{compiled: boolean, compileErr: string, ran: boolean, runErr: string, out: Object<string, any>}}
 *   `out` is keyed by each printed JSON line's `s` field.
 */
export function runHarness(source, className = 'Harness') {
  const dir = mkdtempSync(join(tmpdir(), 'java-exec-'));
  try {
    writeFileSync(join(dir, `${className}.java`), source);
    const c = spawnSync('javac', ['-nowarn', '-d', join(dir, 'out'), join(dir, `${className}.java`)],
      { encoding: 'utf8', timeout: 120000 });
    if (c.status !== 0) return { compiled: false, compileErr: c.stderr || '', ran: false, runErr: '', out: {} };
    const r = spawnSync('java', ['-cp', join(dir, 'out'), className], { encoding: 'utf8', timeout: 60000 });
    const out = {};
    for (const l of (r.stdout || '').split('\n').filter(Boolean)) {
      try { const j = JSON.parse(l); out[j.s] = j; } catch { /* not a result line */ }
    }
    return { compiled: true, compileErr: '', ran: r.status === 0, runErr: r.stderr || '', out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Java string-literal/JSON helpers every harness needs, as Java source. */
export const JSON_HELPERS = `
  static String q(String s) { return "\\"" + s.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"") + "\\""; }
  static String list(java.util.List<?> l) { StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < l.size(); i++) { if (i > 0) b.append(','); Object o = l.get(i);
      b.append(o instanceof String ? q((String) o) : String.valueOf(o)); } return b.append(']').toString(); }
`;
