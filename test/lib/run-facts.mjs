/**
 * run-facts — the ways a device pass can waste ten minutes or mislead afterwards.
 *
 * None of this is evidence about the phone. All of it is about the run being worth doing: a
 * trigger phrase too short to tap mid-sentence, a screenshot that captured a black frame, or a
 * report whose shape nobody checked. Each fails in the same direction — it looks like a device
 * fault, and the phone gets blamed for the harness.
 */

/* What the run actually does with the reply, in seconds after audio starts:
 *   1.2  let the pill render and a little audio play   (device-verify)
 *   +    tap the mic, 1.5s settle, dumpsys, screenshot
 *   +    tap Stop and wait for a truncation line
 * So the reply has to still be playing roughly 6s in, or the mute and stop phases come back
 * blocked for a reason that has nothing to do with either control. */
export const NEEDED_SPEECH_S = 6;

/* Neural TTS at a normal rate lands near 15 characters per second across engines; the figure is
 * only used to reject phrases that are obviously too short, so a rough one is honest. */
export const CHARS_PER_SEC = 15;

/**
 * Is this trigger phrase long enough to still be speaking when the taps land?
 * @returns {{seconds: number, adequate: boolean, why: string}}
 */
export function triggerAdequacy(text, { charsPerSec = CHARS_PER_SEC,
                                        needSec = NEEDED_SPEECH_S } = {}) {
  const t = String(text || '').trim();
  if (!t) {
    return { seconds: 0, adequate: false,
             why: 'the trigger is empty — nothing would be spoken at all' };
  }
  const seconds = t.length / charsPerSec;
  return {
    seconds: Math.round(seconds * 10) / 10,
    adequate: seconds >= needSec,
    why: seconds >= needSec
      ? `about ${seconds.toFixed(1)}s of speech, and the taps land by ${needSec}s`
      : `about ${seconds.toFixed(1)}s of speech but the taps do not land until ${needSec}s — the `
        + 'reply would be over before the mic is tapped, and mute and stop would come back '
        + 'blocked for a reason that has nothing to do with either control',
  };
}

/** A phrase the agent might answer in one word is no good either, however long it is. */
export function invitesLongReply(text) {
  const t = String(text || '');
  /* The shipped phrase counts aloud, which forces a long utterance regardless of what the model
   * feels like saying. Anything with that shape passes; a bare question does not. */
  return /\bone,\s*two,\s*three\b/i.test(t) || /\bcount(ing)?\b/i.test(t)
      || /\brepeat\b/i.test(t) || t.split(/[.!?]/).filter((s) => s.trim().length > 12).length >= 2;
}

/* ---- PNG -----------------------------------------------------------------------------------
 * `screencap -p` can return a well-formed PNG of a black screen: the device was asleep, the
 * activity had not drawn, or the screenshot raced the launch. The run wrote the file and
 * reported `verified`, and the evidence for four acceptance items is a black rectangle nobody
 * looked at until later. */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @returns {{ok: boolean, width: number, height: number, idat: number, reason: string|null}}
 */
export function validatePng(buf, { minWidth = 200, minHeight = 200,
                                   minBytesPerPixel = 0.01 } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const bad = (reason) => ({ ok: false, width: 0, height: 0, idat: 0, reason });
  /* Signature FIRST, then length. The other order reported "only 92 bytes — not an image" for a
   * perfectly well-formed 64x64 PNG, which is a true sentence about the wrong thing: the reason
   * it is not a screencap is its size, and that is what the operator needs to read. Caught by
   * the thumbnail case in this module's own suite. */
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) {
    return bad(b.length < 8 ? `only ${b.length} bytes — not an image`
                            : 'no PNG signature — screencap returned something else');
  }
  if (b.length < 33) return bad(`only ${b.length} bytes — the PNG header is incomplete`);
  if (b.readUInt32BE(12) !== 0x49484452) return bad('first chunk is not IHDR — the PNG is malformed');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height) return bad('IHDR reports a zero dimension');
  if (width < minWidth || height < minHeight) {
    return { ok: false, width, height, idat: 0,
             reason: `${width}x${height} is smaller than a phone screen — this is not a screencap` };
  }
  /* Truncation: exec-out over a flaky link can cut the stream mid-chunk, and a half PNG still
   * carries a valid header. IEND is the only thing that says the image finished arriving. */
  if (b.indexOf(Buffer.from('IEND')) < 0) {
    return { ok: false, width, height, idat: 0,
             reason: 'no IEND chunk — the capture was truncated in transit' };
  }
  /* Blankness, without decoding: a flat-colour image deflates to almost nothing, and a real
   * screen with text and a control bar does not. MEASURED rather than guessed, against the 22
   * captures ux-audit had already written to test/audit/out:
   *
   *     an all-black 1080x2400 frame        0.0029 bytes/pixel
   *     sparsest real capture (boot screen) 0.0428
   *     typical surface capture             0.07 - 0.15
   *
   * 0.01 sits about 3x above the blank and 4x below the sparsest real one. The first threshold
   * here was 0.0008, picked by intuition, and it passed the black frame — zlib does not
   * compress 7.7MB of zeros to nothing, it compresses it to 7.5KB. The suite caught it. */
  let idat = 0;
  for (let i = 8; i + 8 <= b.length;) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    if (type === 'IDAT') idat += len;
    if (type === 'IEND') break;
    i += 12 + len;
    if (len < 0 || i > b.length) break;
  }
  const perPixel = idat / (width * height);
  if (perPixel < minBytesPerPixel) {
    return { ok: false, width, height, idat,
             reason: `${idat} bytes of image data for ${width}x${height} — that compresses like a `
                   + 'blank frame, so the screen was off or the activity had not drawn' };
  }
  return { ok: true, width, height, idat, reason: null };
}

/* ---- the report someone reads afterwards --------------------------------------------------- */

export const STATUSES = ['verified', 'built', 'blocked', 'failed', 'skipped'];

/**
 * Validate the shape of device-verify.json — not the stage names, which device-stages owns, but
 * that the file is the thing it claims to be.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateReport(obj) {
  const problems = [];
  const o = obj && typeof obj === 'object' ? obj : null;
  if (!o) return { ok: false, problems: ['the report is not an object'] };
  if (typeof o.generated !== 'string' || Number.isNaN(Date.parse(o.generated))) {
    problems.push('`generated` is missing or not a parseable timestamp — a report with no time '
                + 'on it cannot be told from last week\'s');
  }
  if (typeof o.dryRun !== 'boolean') {
    problems.push('`dryRun` is missing or not a boolean — a dry run and a device run must never '
                + 'be indistinguishable in the file');
  }
  if (!Array.isArray(o.report)) {
    problems.push('`report` is not an array');
    return { ok: false, problems };
  }
  o.report.forEach((r, i) => {
    if (!r || typeof r !== 'object') { problems.push(`entry ${i} is not an object`); return; }
    if (typeof r.name !== 'string' || !r.name.trim()) problems.push(`entry ${i} has no name`);
    if (!STATUSES.includes(r.status)) {
      problems.push(`entry ${i} ("${r.name}") has status "${r.status}", which is not one of `
                  + STATUSES.join('/'));
    }
    if (r.detail !== undefined && typeof r.detail !== 'string') {
      problems.push(`entry ${i} ("${r.name}") has a non-string detail`);
    }
  });
  const names = o.report.map((r) => r && r.name);
  const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dupes.length) {
    problems.push(`repeated stage name(s): ${[...new Set(dupes)].join(', ')} — two rows with one `
                + 'name means the later verdict silently replaces the earlier when anyone reads '
                + 'it by name');
  }
  return { ok: problems.length === 0, problems };
}

/** The stage that says whether the run ever got to the phone. */
export const DEVICE_GATE = 'device authorised';

/**
 * Was this report a full device pass, or something less? A partial pass must never read like a
 * verification, and "no failures" is not the same claim as "everything was attempted".
 *
 * NOT REACHED IS THE COMMON CASE AND IT WAS THE ONE THIS GOT WRONG. The first version defined
 * "full" as "no skipped rows", and a real cold run — the first one ever driven end to end —
 * produced exactly that: four host-side preflight stages verified, the device gate blocked, no
 * skipped rows anywhere, and the file classified itself `full: 5 stage(s) attempted`. Nothing
 * on the phone had been attempted at all. A report that says full while the device was never
 * reached is worse than one that says nothing, because it is the file someone quotes tomorrow.
 *
 * So the gate stage decides it. Everything before that gate is host-side preflight, and passing
 * preflight is not a device pass however many rows it fills.
 */
export function reportKind(obj, { gate = DEVICE_GATE } = {}) {
  const rows = (obj && Array.isArray(obj.report)) ? obj.report : [];
  if (obj && obj.dryRun) return { kind: 'dry-run', note: 'no device was touched' };
  if (obj && obj.simulated) {
    return { kind: 'simulated', note: 'adb was a scripted stand-in — every device stage here '
           + 'describes a replay, not a phone' };
  }
  if (!rows.length) return { kind: 'empty', note: 'the report has no stages at all' };

  const gateRow = rows.find((r) => r && r.name === gate);
  if (!gateRow || gateRow.status === 'blocked' || gateRow.status === 'failed') {
    return { kind: 'not-reached',
             note: gateRow
               ? `"${gate}" is ${gateRow.status}, so nothing on the phone was attempted — the `
                 + `${rows.length} stage(s) here are host-side preflight`
               : `"${gate}" never ran, so there is no evidence the phone was reached at all` };
  }
  const skipped = rows.filter((r) => r && r.status === 'skipped');
  if (skipped.length) {
    return { kind: 'partial',
             note: `${skipped.length} stage(s) were never attempted: `
                 + `${skipped.map((r) => r.name).join(', ')}` };
  }
  return { kind: 'full', note: `${rows.length} stage(s) attempted` };
}
