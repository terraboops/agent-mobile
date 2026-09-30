#!/usr/bin/env node
/**
 * handoff-watch — the machine-side half of handoff announce. Run by launchd, not by a session.
 *
 * device-handoff announces the phone being found and its verdict itself. What it cannot announce
 * is its own death: a SIGKILL, a crash, an OOM leaves nothing. It keeps a pidfile while armed;
 * this reads it, and if the pid is gone with no end announced, appends a `died` event to the real
 * events file (which a session waiter picks up) and posts a desktop banner (which does not need a
 * session at all). Idempotent: the pidfile is removed once the death is announced.
 *
 *   node test/handoff-watch.mjs              one check (what launchd runs)
 *   node test/handoff-watch.mjs --install    write + load the LaunchAgent (every 120s, at load, after wake)
 *   node test/handoff-watch.mjs --uninstall  unload + remove it
 */
import { readFileSync, writeFileSync, existsSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { announce, pidfilePath, eventsPath, eventsSince, watchDecision } from './lib/handoff-announce.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'test/audit/out/device');
const LOG = join(OUT, 'handoff-watch.log');
const LABEL = 'io.bitcomplete.agentmob.handoff-watch';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const uid = process.getuid();

if (process.argv.includes('--install')) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(REPO, 'test/handoff-watch.mjs')}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`);
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { encoding: 'utf8' });
  console.log(r.status === 0 ? `installed ${PLIST} (every 120s)` : `bootstrap failed: ${r.stderr}`);
  process.exit(r.status === 0 ? 0 : 1);
}
if (process.argv.includes('--uninstall')) {
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
  rmSync(PLIST, { force: true });
  console.log(`removed ${PLIST}`);
  process.exit(0);
}

const stamp = () => new Date().toISOString();
const PIDFILE = pidfilePath(REPO);
let pidfile = null;
try { pidfile = JSON.parse(readFileSync(PIDFILE, 'utf8')); } catch { /* none armed */ }
let alive = false;
if (pidfile) { try { process.kill(pidfile.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
const events = pidfile && existsSync(eventsPath(OUT, false))
  ? eventsSince(readFileSync(eventsPath(OUT, false), 'utf8'), pidfile.started) : [];
const d = watchDecision({ pidfile, alive, events });
if (d.action === 'died') {
  const a = announce({ kind: 'died', simulated: false, pid: pidfile.pid, started: pidfile.started, by: 'handoff-watch' }, { outDir: OUT });
  rmSync(PIDFILE, { force: true });
  console.log(`${stamp()} ${d.why} — announced (events ${a.event ? 'written' : 'NOT written'}, desktop ${a.desktop ? 'shown' : 'not shown'})`);
} else if (d.action === 'clear') {
  rmSync(PIDFILE, { force: true });
  console.log(`${stamp()} ${d.why} — stale pidfile cleared`);
} else if (pidfile) {
  console.log(`${stamp()} ${d.why}`);
}
