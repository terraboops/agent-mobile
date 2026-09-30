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
