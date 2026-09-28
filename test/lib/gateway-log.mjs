/**
 * gateway-log — read the Hermes gateway log safely across a rotation.
 *
 * Every device stage that proves something (handshake, identity, opus PT, speaking, truncation)
 * does it by finding a line in this log. Two traps, both of which have already reported healthy
 * systems as broken in this repo:
 *
 *   BYTE OFFSETS  gateway.log rotates at 5MB. An offset taken before the roll points into a
 *                 file that no longer exists, slice() yields '', and every log-based assertion
 *                 fails on a working system.
 *   UTC STAMPS    the log stamps LOCAL time. toISOString() is UTC, which here sits hours in the
 *                 future and matches nothing at all.
 *
 * Kept in its own module so tests can drive THESE functions rather than a copy of them — a test
 * that reimplements the helper is testing its own reimplementation, which a mutation run
 * correctly refuses to credit.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GATEWAY_LOG = process.env.AGENTMOB_GATEWAY_LOG
  || join(homedir(), '.hermes/logs/gateway.log');

/** A mark to read from later: local time, a couple of seconds back for clock slack. */
export const logStamp = (nowMs = Date.now()) => {
  const d = new Date(nowMs - 2000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
       + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

/** Everything logged at or after `stamp`, including lines that rotated away mid-run. */
export const logSince = (stamp, file = GATEWAY_LOG) => {
  let text = '';
  for (const f of [file + '.1', file]) {
    try { text += readFileSync(f, 'utf8'); } catch { /* absent or rotated */ }
  }
  return text.split('\n').filter((l) => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    return m && m[1] >= stamp;
  }).join('\n');
};
