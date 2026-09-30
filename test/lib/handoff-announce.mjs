/**
 * handoff-announce — make an unattended device pass HEARD.
 *
 * WHY. device-handoff is armed for hours and exits when it is done. A pass that landed at 03:00
 * used to leave exactly one record: a JSON file nobody was watching. The session that armed it
 * never saw it, so nothing woke on it — and a device pass that lands invisibly is worth about as
 * much as one that never ran.
 *
 * Two channels, because they reach different people:
 *   1. EVENTS FILE  one JSON line per moment appended to device-handoff.events.jsonl (sim runs:
 *                   device-handoff.sim.events.jsonl). A waiter in the Claude session that armed
 *                   the loop (a background `until` on this file) exits when it grows, and that
 *                   exit re-invokes the session — so the verdict lands in the transcript.
 *   2. DESKTOP      a macOS notification, visible on the screen with no session open at all.
 *                   Off for simulated runs unless AGENTMOB_HANDOFF_ANNOUNCE=1 (to prove it fires).
 *
 * Moments: `found` (the phone is confirmed; passes are starting) and `verdict` (the handoff is
 * over — passes ran, or nothing appeared). Announcing never throws: a notification that fails
 * must not take the verdict down with it.
 */
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const eventsPath = (outDir, simulated) =>
  join(outDir, simulated ? 'device-handoff.sim.events.jsonl' : 'device-handoff.events.jsonl');

/** The notification's text — short enough for a banner, specific enough to act on. */
export function announceText(ev) {
  const tag = ev.simulated ? 'SIMULATED — ' : '';
  if (ev.kind === 'found') return { title: `${tag}agentmob: phone found`, body: `${ev.endpoint || 'handset'} — device passes starting` };
  if (ev.kind === 'died') return { title: `${tag}agentmob handoff DIED`, body: `loop pid ${ev.pid} (armed ${ev.started}) is gone without a verdict — nothing is watching for the phone` };
  if (ev.kind === 'stopped') return { title: `${tag}agentmob handoff stopped`, body: `loop pid ${ev.pid} stopped by ${ev.signal} before any verdict` };
  const fails = (ev.results || []).filter((r) => r.exit !== 0).length;
  const ran = (ev.results || []).length;
  const head = !ev.found ? 'no phone appeared' : fails ? `${fails} of ${ran} pass(es) FAILED` : `${ran} pass(es) passed`;
  return { title: `${tag}agentmob handoff: ${head}`, body: String(ev.note || '').slice(0, 180) };
}

export function announce(ev, { outDir, platform = process.platform, run = spawnSync, append = appendFileSync } = {}) {
  const done = { event: false, desktop: false, errors: [] };
  const line = { at: new Date().toISOString(), ...ev };
  try { append(eventsPath(outDir, !!ev.simulated), JSON.stringify(line) + '\n'); done.event = true; }
  catch (e) { done.errors.push(`events: ${e.message}`); }
  const wantDesktop = platform === 'darwin' && (!ev.simulated || process.env.AGENTMOB_HANDOFF_ANNOUNCE === '1');
  if (wantDesktop) {
    const { title, body } = announceText(ev);
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    try {
      const r = run('osascript', ['-e', `display notification ${q(body)} with title ${q(title)} sound name "Glass"`],
        { encoding: 'utf8', timeout: 10000 });
      if (r.status === 0) done.desktop = true; else done.errors.push(`osascript exit ${r.status}: ${(r.stderr || '').trim()}`);
    } catch (e) { done.errors.push(`osascript: ${e.message}`); }
  }
  return done;
}

/* ---- DURABILITY -----------------------------------------------------------------------------
 * A dead loop cannot announce its own death, and the session waiter dies with its session. So the
 * loop leaves a PIDFILE while it is armed, and a launchd agent (handoff-watch.mjs, every 2 min,
 * no session required) turns "pidfile names a dead process and no verdict was announced" into a
 * `died` event and a banner. The waiter (handoff-wait.mjs) keeps a CURSOR into the events file,
 * so one re-armed after a restart delivers whatever landed while nobody was listening. */
export const pidfilePath = (repo) => join(repo, 'test', '.handoff-running');
export const cursorPath = (outDir) => join(outDir, '.handoff-events.cursor');

/** Events since `startedIso`, parsed; bad lines skipped. */
export function eventsSince(text, startedIso) {
  const t0 = Date.parse(startedIso || 0) || 0;
  return String(text || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && (Date.parse(e.at) || 0) >= t0);
}

/**
 * What the watchdog should do. Pure.
 * @returns {{action: 'none'|'died'|'clear', why: string}}
 */
export function watchDecision({ pidfile, alive, events }) {
  if (!pidfile) return { action: 'none', why: 'no loop is armed' };
  if (alive) return { action: 'none', why: `loop pid ${pidfile.pid} is alive` };
  const ended = (events || []).find((e) => e.kind === 'verdict' || e.kind === 'stopped' || e.kind === 'died');
  if (ended) return { action: 'clear', why: `loop pid ${pidfile.pid} is gone but announced its end (${ended.kind})` };
  return { action: 'died', why: `loop pid ${pidfile.pid} is gone and announced NOTHING — it died` };
}
