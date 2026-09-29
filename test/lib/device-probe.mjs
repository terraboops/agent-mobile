/**
 * device-probe — the arithmetic and text-parsing inside the device run, pulled out so a Mac can
 * check it.
 *
 * WHY. `device-verify` cannot run without a handset, so everything in it was trusted on the
 * strength of having been read. Most of it genuinely needs the phone — you cannot tap a button
 * from here. But the parts that decide WHERE to tap and WHAT the phone just said are ordinary
 * functions over numbers and strings, and those are exactly the parts that are wrong quietly:
 * a tap that lands ten pixels off does nothing and reports nothing, and a mute check that reads
 * "true" out of the wrong line verifies issue #1 without measuring it.
 *
 * Splitting them means the ten minutes with the phone in hand are spent on what only the phone
 * can answer, instead of on discovering that a regex never matched.
 */

/** `wm density` → dp scale, or 0 when the device did not say. */
export function parseDensity(out) {
  const m = /(\d+)\s*$/.exec(String(out || '').trim());
  const dpi = m ? Number(m[1]) : 0;
  return dpi > 0 ? dpi / 160 : 0;
}

/** `wm size` → {w, h}, or null. */
export function parseSize(out) {
  const m = /(\d+)x(\d+)\s*$/.exec(String(out || '').trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * The native mic button's centre.
 *
 * The button is MIC_SIZE dp tall and sits MIC_GAP dp above the navigation bar, so its centre is
 * (gap + size/2) dp up from the nav inset. Everything is in device pixels by the time it
 * reaches `input tap`.
 */
export function micTapPoint({ w, h, dens, navPx = 0, micSizeDp, micGapDp }) {
  if (!w || !h || !dens || !micSizeDp) return null;
  return {
    x: Math.round(w / 2),
    y: Math.round(h - (navPx + (micGapDp + micSizeDp / 2) * dens)),
  };
}

/** Stop sits at the right of the web control bar, one third of the bar's width in. */
export function stopTapX({ w, dens, insetDp = 66 }) {
  if (!w || !dens) return null;
  return Math.round(w - insetDp * dens);
}

/**
 * Is the microphone muted, according to `dumpsys audio`?
 *
 * THREE ANSWERS, NOT TWO. This was `/true/i.test(greppedText)` over three grepped lines, which
 * says "muted" if the word true appears anywhere in them — including in a neighbouring field, or
 * in a line about something else entirely that happened to match the grep. It also could not
 * distinguish "the phone says not muted" from "the phone said nothing", and those call for
 * opposite responses: one is a failed mute, the other is a probe that needs rewriting for this
 * Android version.
 *
 * So the field is matched by NAME and its own value read.
 *
 * @returns {true|false|null} null = the device reported no mic-mute state at all
 */
export function parseMicMute(out) {
  const text = String(out || '');
  /* Known spellings across Android versions, most specific first. */
  const pats = [
    /\bmMicMute\s*[:=]\s*(true|false)\b/i,
    /\bmic(?:rophone)?[ _]?mute(?:d)?\s*[:=]\s*(true|false)\b/i,
    /\bmute[ _]?mic(?:rophone)?\s*[:=]\s*(true|false)\b/i,
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (m) return /^true$/i.test(m[1]);
  }
  return null;
}

/** `dumpsys package <pkg>` → versionName, or null. */
export function parseVersionName(out) {
  const m = /versionName=(\S+)/.exec(String(out || ''));
  return m ? m[1] : null;
}

/** The highest major version among `pkg=version` strings — the WebView actually in play. */
export function highestMajor(found) {
  const majors = (found || [])
    .map((f) => Number((/=(\d+)/.exec(String(f)) || [])[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  return majors.length ? Math.max(...majors) : null;
}

/** The navigation-bar inset in px out of `dumpsys window`, best effort. */
export function parseNavInset(out) {
  const m = /navigationBars[^\n]*?frame=\[\d+,\d+\]\[\d+,(\d+)\]/.exec(String(out || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Did OUR package crash, according to logcat?
 *
 * WHY. The launch stage was `pidof <pkg>` six seconds after `am start`. That answers "is there a
 * process now", which is not "did it launch": an app that throws in onCreate is restarted by the
 * system, so a pid is present and the stage reads VERIFIED over a crash loop. The opposite case
 * is no better — a crash inside the six seconds gives "failed: no process", which tells whoever
 * is holding the phone nothing they can act on.
 *
 * Only crashes attributed to the named package count. A FATAL EXCEPTION from some other app is
 * background noise on a real handset and must not fail this run.
 *
 * @returns {{kind: string, summary: string}|null}
 */
export function parseCrash(logcat, pkg) {
  const text = String(logcat || '');
  const name = String(pkg || '');
  if (!name) return null;
  const lines = text.split('\n');

  /* FATAL EXCEPTION blocks name their package on a following `Process:` line. */
  for (let i = 0; i < lines.length; i++) {
    if (!/\bFATAL EXCEPTION\b/.test(lines[i])) continue;
    const window = lines.slice(i, i + 4).join('\n');
    if (!window.includes(name)) continue;
    const exc = lines.slice(i, i + 6)
      .find((l) => /^\s*(?:\S+\s+)*?(?:java|android|kotlin|com)\.\S+(?:Exception|Error)\b/.test(l)
                || /\b\w+(?:Exception|Error):/.test(l));
    return { kind: 'fatal', summary: (exc || lines[i]).trim().slice(0, 200) };
  }
  /* ANRs and deaths name the package inline. */
  const anr = new RegExp(`ANR in ${name.replace(/\./g, '\\.')}\\b[^\n]*`).exec(text);
  if (anr) return { kind: 'anr', summary: anr[0].trim().slice(0, 200) };
  const died = new RegExp(`Process ${name.replace(/\./g, '\\.')}[^\n]*?has died[^\n]*`).exec(text);
  if (died) return { kind: 'died', summary: died[0].trim().slice(0, 200) };
  return null;
}
