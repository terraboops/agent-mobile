#!/usr/bin/env node
/**
 * handoff-wait — the SESSION half of handoff announce: block until the real events file has an
 * event this session has not seen, print it, exit. Run it as a background task; its exit is what
 * re-invokes an idle Claude session.
 *
 * It keeps a CURSOR (the number of lines delivered) beside the events file. A waiter re-armed
 * after the session restarted therefore delivers what landed while nobody was listening, at once,
 * instead of waiting for the next event and losing the one that mattered.
 *
 *   node test/handoff-wait.mjs            deliver unseen events, or wait for the next one
 *   node test/handoff-wait.mjs --reset    mark everything so far as seen, then wait
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsPath, cursorPath } from './lib/handoff-announce.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'audit/out/device');
const EV = eventsPath(OUT, process.argv.includes('--sim'));
const CUR = cursorPath(OUT) + (process.argv.includes('--sim') ? '.sim' : '');
const lines = () => (existsSync(EV) ? readFileSync(EV, 'utf8').split('\n').filter(Boolean) : []);
let seen = 0;
try { seen = Number(readFileSync(CUR, 'utf8')) || 0; } catch {}
if (process.argv.includes('--reset')) { seen = lines().length; writeFileSync(CUR, String(seen)); }
console.log(`${new Date().toISOString()} waiting on ${EV} (${seen} line(s) already delivered)`);
for (;;) {
  const l = lines();
  if (l.length > seen) {
    console.log('HANDOFF EVENT(S):');
    for (const e of l.slice(seen)) console.log(e);
    writeFileSync(CUR, String(l.length));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
