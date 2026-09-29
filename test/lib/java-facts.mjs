/**
 * java-facts — read the native call sites the device leg depends on, from source.
 *
 * WHY. `mic-mute` proves the WEB layer's state machine: the ring, the interrupt suppression,
 * the double-tap, the reconnect. It drives a stubbed bridge in a browser, so the one thing it
 * cannot see is what the Java actually does with the boolean it is handed.
 *
 * THE DEFECT THIS EXISTS FOR. Write `am.setMicrophoneMute(!muted)` and every host assertion
 * still passes: the field `micMuted` is set correctly, so the ring reads MUTED, the interrupt is
 * still suppressed, the reply still plays. Only the microphone stays live — the exact failure
 * issue #1 is about, surviving all the way to the handset because nothing here looks at the
 * argument. A one-character bug with no host-side detector.
 *
 * This is not a Java parser. It extracts a method body by brace matching and asks narrow
 * questions about it, which is enough for "is the right variable passed to the right call" and
 * is honest about being no more than that.
 */

/** The body of `<name>(...)` — brace-matched, so nested blocks survive. Null when absent. */
export function methodBody(src, name) {
  const s = String(src || '');
  const sig = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(s);
  if (!sig) return null;
  let i = sig.index + sig[0].length;
  let depth = 1;
  const start = i;
  for (; i < s.length && depth > 0; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth === 0 ? s.slice(start, i - 1) : null;
}

/** Strip comments and string literals, so prose about a call is never read as the call. */
export function javaCode(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * The argument expression passed to `<receiver>.<method>(...)`, or null.
 * Single-argument calls only — that is all the call sites here take.
 */
export function callArg(body, method) {
  const m = new RegExp(`\\.\\s*${method}\\s*\\(([^)]*)\\)`).exec(javaCode(body || ''));
  return m ? m[1].trim() : null;
}

/** Does this body call `<name>(...)` at all? */
export function callsMethod(body, name) {
  return new RegExp(`\\b${name}\\s*\\(`).test(javaCode(body || ''));
}
