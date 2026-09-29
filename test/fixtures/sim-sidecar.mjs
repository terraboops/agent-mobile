#!/usr/bin/env node
/**
 * sim-sidecar — a REAL sidecar, isolated, whose log looks like the gateway's.
 *
 * The live sidecar's code, run as a second process: its own ports, its own identity keypair
 * (never the live one), its own WS-force marker (never the live one), no parent watchdog, and
 * stderr stamped `YYYY-MM-DD HH:MM:SS` line by line into a scratch gateway log — the format
 * device-verify reads, which the real gateway produces when it relays the sidecar's stderr.
 *
 *   node sim-sidecar.mjs <dir> <port> <ctlPort>     runs until SIGTERM
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [dir, port, ctl] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const LOG = join(dir, 'gateway.log');
const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const child = spawn(process.execPath, [join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs')], {
  env: { ...process.env,
         AGENTMOB_PORT: String(port), AGENTMOB_SIDECAR_PORT: String(ctl), AGENTMOB_BIND: '127.0.0.1',
         AGENTMOB_IDENTITY_FILE: join(dir, 'identity.json'),
         AGENTMOB_FORCE_WS_FILE: join(dir, 'force-ws-downlink'),
         AGENTMOB_NO_PARENT_WATCH: '1', AGENTMOB_NO_TAILNET_ICE: '1', AGENTMOB_ICE: 'none',
         AGENTMOB_ICE_DEADLINE_MS: String(process.env.SIM_ICE_DEADLINE_MS || 8000) },
  stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
const pump = (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop();
                      for (const l of lines) if (l.trim()) appendFileSync(LOG, `${stamp()} ${l}\n`); };
child.stdout.on('data', pump); child.stderr.on('data', pump);
const stop = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(0), 300); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('exit', (c) => { appendFileSync(LOG, `${stamp()} [sim-sidecar] sidecar exited ${c}\n`); process.exit(0); });
