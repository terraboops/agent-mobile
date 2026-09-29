/**
 * stage-select — run part of the device pass instead of all of it.
 *
 * WHY. The pass discovers, installs, launches, handshakes, negotiates WebRTC, screenshots,
 * speaks, mutes mid-sentence and taps Stop, in one sequence that takes about ten minutes with
 * the phone in hand. A failure in the mute phase means redoing the install to look at it again,
 * and the install is the slowest part. The phone is borrowed time; the iteration loop should not
 * be the whole pass.
 *
 * PHASES, NOT ARBITRARY STAGES. A selector that skipped to any stage by name would be lying
 * about what it can do: most stages need the ones before them — you cannot tap a mic button in
 * an app that was never launched. What IS independently skippable is the install, once the APK
 * is on the phone, and that is where the minutes are. So the unit is a phase, each one a block
 * the run can honestly begin at.
 *
 * DISCOVERY IS NEVER SKIPPED. Every later phase needs a serial, and discovery is seconds when
 * the endpoint is up. Making it optional would only create a way to get a confusing failure.
 */

/** In emission order. `after` names what a phase needs to have happened on the device. */
export const PHASES = [
  { name: 'discover', always: true,
    what: 'reach the phone and authorise adb' },
  { name: 'install',
    what: 'adb install -r, and the WebView version report' },
  { name: 'launch',
    what: 'force-stop, am start, crash check, boot screenshot' },
  { name: 'handshake',
    what: 'AEAD handshake, live client identity, WebRTC negotiation, ICE path' },
  { name: 'surface',
    what: 'connected control bar and widget-tile screenshots' },
  /* `speak` is SELECTABLE but not independently skippable, and the difference is real: the mic
   * cannot be tapped mid-sentence unless something is being spoken, and Stop means nothing
   * against silence. So selecting mute or stop implies the turn. Its guard is therefore the
   * disjunction over the three, not a `phase('speak')` of its own — marked here so the drift
   * check below knows that is deliberate rather than a phase nobody wired up. */
  { name: 'speak', precondition: true, impliedBy: ['mute', 'stop'],
    what: 'trigger a spoken reply and watch the speaking pill — implied by mute and stop, '
        + 'because neither is observable without a reply in flight' },
  { name: 'mute',
    what: 'tap the native mic mid-sentence (issue #1) and read dumpsys audio' },
  { name: 'stop',
    what: 'tap Stop mid-sentence and confirm the audio stops' },
];

export const PHASE_NAMES = PHASES.map((p) => p.name);

/** Levenshtein, small and good enough to say "did you mean". */
function near(a, b) {
  const s = String(a), t = String(b);
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) d[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                         d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
  }
  return d[s.length][t.length];
}

/**
 * Work out which phases to run.
 *
 * An unknown name is REFUSED, never ignored. Silently running everything because a name was
 * misspelled is the worst outcome available: the operator asked for a two-minute check, waited
 * ten, and the report looks exactly like the one they wanted.
 *
 * @param {{only?: string|true|null, from?: string|true|null}} opts
 * @returns {{run: Set<string>, kind: string, error: string|null}}
 */
export function parsePhaseSelector({ only = null, from = null } = {}) {
  const all = new Set(PHASE_NAMES);
  const bad = (msg) => ({ run: new Set(), kind: 'error', error: msg });

  if (only && from) {
    return bad('--only and --from cannot be combined: one names a set, the other a starting '
             + 'point. Pick whichever the run needs.');
  }
  const check = (raw, flagName) => {
    const names = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.length || raw === true) {
      return { names: null, error: `${flagName} needs a phase name. Known phases, in order: `
                                 + PHASE_NAMES.join(', ') };
    }
    for (const n of names) {
      if (all.has(n)) continue;
      const suggestion = PHASE_NAMES
        .map((p) => [p, near(p, n)]).sort((a, b) => a[1] - b[1])
        .filter(([, d]) => d <= 3)[0];
      return { names: null,
               error: `unknown phase "${n}" for ${flagName}`
                    + (suggestion ? ` — did you mean "${suggestion[0]}"?` : '')
                    + `\nKnown phases, in order: ${PHASE_NAMES.join(', ')}` };
    }
    return { names, error: null };
  };

  /* Preconditions are IMPLIED, and the selection has to say so.
   *
   * `--only stop` runs the spoken turn — it has to, since Stop against silence means nothing,
   * and device-verify triggers it whenever any of speak/mute/stop is selected. But the selection
   * did not contain `speak`, so the run printed "SKIPPED ... speak" while speaking. Rehearsing
   * the exact command found it; the summary line was describing a phase that had just run.
   * Adding the implication here keeps the report and the behaviour the same statement. */
  const withImplied = (run) => {
    for (const p of PHASES) {
      if (p.impliedBy && p.impliedBy.some((d) => run.has(d))) run.add(p.name);
      if (p.always) run.add(p.name);
    }
    return run;
  };

  /* `flag()` returns null, a string, or true — never false — so a `!== false` guard here was
   * unreachable defensive code. Asserting a case that cannot occur is the same disease as a
   * guard that cannot fire, so it is removed rather than covered. */
  if (only !== null) {
    const { names, error } = check(only, '--only');
    if (error) return bad(error);
    return { run: withImplied(new Set(names)), kind: 'only', error: null };
  }
  if (from !== null) {
    const { names, error } = check(from, '--from');
    if (error) return bad(error);
    if (names.length > 1) {
      return bad('--from takes ONE phase name; it is a starting point, not a list. '
               + 'Use --only for a set.');
    }
    const at = PHASE_NAMES.indexOf(names[0]);
    return { run: withImplied(new Set(PHASE_NAMES.slice(at))), kind: 'from', error: null };
  }
  return { run: all, kind: 'all', error: null };
}

/** Is this phase in the selection? */
export function runsPhase(sel, name) {
  return !!(sel && sel.run && sel.run.has(name));
}

/** One line for the header, so a partial run never looks like a full one in the report. */
export function describeSelection(sel) {
  if (!sel || sel.kind === 'all') return 'all phases';
  if (sel.kind === 'error') return `selector error: ${sel.error}`;
  const skipped = PHASE_NAMES.filter((n) => !sel.run.has(n));
  return `${sel.kind}: running ${[...sel.run].join(', ')}`
       + (skipped.length ? ` — SKIPPED ${skipped.join(', ')} (this is a PARTIAL pass)` : '');
}
