/**
 * device-watch — capture on-device evidence without adb.
 *
 * The phone dials OUT to the sidecar, so a real handshake leaves a trail in the gateway log
 * whether or not anyone is watching. adb needs Wireless debugging switched on at the phone;
 * this does not. Leave it running, open the app, and the evidence lands in a report.
 *
 * What makes this evidence and not a guess: the sidecar logs the negotiated opus payload type,
 * and the two stacks disagree about it. Android libwebrtc offers 111; werift (the fake phone in
 * test/e2e-webrtc.mjs) offers 96. So a run can tell a real device from my own harness instead of
 * quietly reporting harness traffic as on-device proof.
 *
 * It also captures the PAIRING line's client identity — the LIVE phone identity, which is what
 * AGENTMOB_ALLOWED_CLIENTS has to be pinned to. Pinning a stale id locks the phone out.
 *
 * Usage:
 *   npm run device-watch              # replay what the log already holds, then follow
 *   npm run device-watch -- --history # replay only, no follow
 *   npm run device-watch -- --timeout 900
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Overridable so the classifier itself can be tested against synthetic logs — an
 * unvalidated parser is not evidence. See test/device-watch.test.mjs. */
const LOG = process.env.AGENTMOB_WATCH_LOG || join(homedir(), '.hermes/logs/gateway.log');
const OUT = process.env.AGENTMOB_WATCH_OUT || join(ROOT, 'test/audit/out/device-watch.json');

const argv = process.argv.slice(2);
const historyOnly = argv.includes('--history');
const timeoutSec = Number((argv[argv.indexOf('--timeout') + 1]) || 0) || 1800;

/* opus payload type -> which stack offered it. The sidecar answers with the PT the OFFERER
 * proposed, so this reflects the peer, not the sidecar. */
const STACKS = { 111: 'Android libwebrtc (REAL DEVICE)', 96: 'werift (test/e2e-webrtc.mjs harness)' };

if (!existsSync(LOG)) {
  console.error(`no gateway log at ${LOG} — is Hermes running?`);
  process.exit(2);
}

/* One connection attempt's worth of facts. */
const sessions = [];
let cur = null;
const newSession = (ts) => { cur = { start: ts, clientId: null, identity: null, confirmed: false, iceFailed: null,
  opusPT: null, stack: null, iceStates: [], downlink: [], rejects: [], turns: 0, end: null }; return cur; };

const RX = [
  [/\[sidecar\] phone connected/, (m, ts) => { if (cur && !cur.end) cur.end = ts; sessions.push(newSession(ts)); }],
  [/\[sidecar\] PAIRING: client (\S+) identity=(\S+)/, (m) => {
    if (!cur) newSession(null) && sessions.push(cur);
    cur.clientId = m[1]; cur.identity = m[2].replace(/\s*—.*$/, '');
  }],
  [/\[sidecar\] handshake confirmed (\S+)/, (m) => { if (cur) { cur.confirmed = true; cur.clientId ||= m[1]; } }],
  [/\[sidecar\] REJECT unknown client (\S+) \((\S*)\)/, (m) => { if (cur) cur.rejects.push({ id: m[1], identity: m[2] }); }],
  [/\[sidecar\] handshake reject: (.+)$/, (m) => { if (cur) cur.rejects.push({ reason: m[1].trim() }); }],
  [/\[sidecar\] handshake confirm FAILED for (\S+)/, (m) => { if (cur) cur.rejects.push({ id: m[1], reason: 'confirm failed' }); }],
  [/\[sidecar\] webrtc answer sent opusPT=(\d+)/, (m) => {
    if (!cur) return;
    cur.opusPT = Number(m[1]);
    cur.stack = STACKS[cur.opusPT] || `unrecognised stack (opus PT ${cur.opusPT})`;
  }],
  [/\[sidecar\] webrtc st (\S+)/, (m) => { if (cur && cur.iceStates.at(-1) !== m[1]) cur.iceStates.push(m[1]); }],
  /* The sidecar's explicit give-up line. Worth surfacing on its own: a session that handshakes
   * and then silently serves voice over the WS fallback looks healthy in every other field. */
  [/\[sidecar\] webrtc ICE FAILED \(never reached connected\) — (.+)$/, (m) => {
    const t = cur || sessions.at(-1);
    if (t) t.iceFailed = m[1].trim();
  }],
  /* The trailing "[cut short after i/n frames: why]" is the sidecar recording a truncated
   * playback (barge-in, app backgrounded, ICE drop). Keep it: a reply that only half-arrived
   * is a materially different observation from a clean one, and it used to log nothing. */
  [/\[sidecar\] → phone pcm (\d+)b -> (\d+) opus packets via (\w+)([^[]*)(?:\[(.+)\])?/, (m) => {
    /* Attribute to the session that has just ENDED when there is no open one: a playback cut
     * short by a disconnect is logged after 'phone disconnected', because the disconnect is
     * what truncated it. Dropping those would discard the transport record for precisely the
     * cases this instrumentation was added to capture. */
    const t = cur || sessions.at(-1);
    if (t) t.downlink.push({ pcm: +m[1], packets: +m[2], via: m[3],
      truncated: m[5] ? m[5].trim() : null });
  }],
  [/\[sidecar\] phone disconnected/, (m, ts) => { if (cur) { cur.end = ts; cur = null; } }],
];

const TS = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

function feed(line) {
  if (!line.includes('agentmob')) return;
  const ts = (line.match(TS) || [])[1] || null;
  for (const [re, fn] of RX) {
    const m = line.match(re);
    if (m) { fn(m, ts); return true; }
  }
  return false;
}

/* ---- replay the history the log already holds ------------------------------------------- */
/* utf8, NOT latin1: the downlink line contains '→'. Reading latin1 mangles it and the
 * transport (WebRTC vs the silent WS fallback) silently stops being recorded. Node's utf8
 * decoder substitutes bad bytes rather than throwing, so there is nothing to guard against. */
for (const line of readFileSync(LOG, 'utf8').split('\n')) feed(line);
const historyCount = sessions.length;

const verdict = (s) => {
  if (!s.confirmed && s.rejects.length) return 'REJECTED';
  if (!s.confirmed) return 'INCOMPLETE (no handshake confirm)';
  if (s.iceFailed) return 'ICE FAILED — voice fell back to WS/UDP';
  if (s.opusPT === 111) return 'REAL DEVICE — Android libwebrtc';
  if (s.opusPT === 96) return 'harness (werift fake phone)';
  if (s.opusPT == null) return 'connected, no WebRTC negotiated (WS/UDP path only)';
  return s.stack;
};

function render(list, heading) {
  console.log(`\n=== ${heading} (${list.length}) ===`);
  for (const s of list) {
    const via = [...new Set(s.downlink.map((d) => d.via))].join(',') || '-';
    const pkts = s.downlink.reduce((a, d) => a + d.packets, 0);
    console.log(`  ${s.start || '?'}  ${verdict(s)}`);
    console.log(`     client=${s.clientId || '?'} identity=${s.identity || '?'}`);
    console.log(`     opusPT=${s.opusPT ?? '-'}  ice=[${s.iceStates.join('>') || '-'}]  downlink via ${via} (${pkts} pkts)`);
    if (s.iceFailed) console.log(`     ICE FAILED: ${s.iceFailed}`);
    if (s.rejects.length) console.log(`     rejects: ${JSON.stringify(s.rejects)}`);
  }
}

const real = () => sessions.filter((s) => s.opusPT === 111);

render(sessions.slice(-8), 'handshakes already in the log (most recent 8)');
if (real().length) {
  console.log(`\n*** ${real().length} REAL-DEVICE session(s) found in history ***`);
  for (const s of real()) {
    console.log(`  live phone identity: client_id=${s.clientId} identity=${s.identity}`);
    console.log(`  -> to pin: AGENTMOB_ALLOWED_CLIENTS=${s.clientId}`);
  }
} else {
  console.log('\nNo real-device session in the log yet (nothing with opus PT 111).');
}

const save = () => {
  const real111 = real();
  writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(), log: LOG,
    totalSessions: sessions.length, historyCount,
    realDeviceSessions: real111.length,
    livePhoneIdentity: real111.length ? { clientId: real111.at(-1).clientId, identity: real111.at(-1).identity } : null,
    sessions,
  }, null, 2));
  console.log(`\nreport -> ${OUT}`);
};

if (historyOnly) { save(); process.exit(real().length ? 0 : 1); }

/* ---- follow, so opening the app on the phone is enough ---------------------------------- */
console.log(`\n--- following ${LOG} for up to ${timeoutSec}s — open the app on the Pixel now ---`);
const before = sessions.length;
/* -F, not -f: the gateway ROTATES this log on every restart, and -f follows the inode, so
 * an armed watcher goes silently deaf the moment the gateway is kicked — which is exactly
 * when a phone is most likely to reconnect. -F re-opens by name across rotation and
 * truncation. Observed: a watcher armed before two restarts reported none of the
 * handshakes that happened after them. */
const tail = spawn('tail', ['-0F', LOG]);
let buf = '';
tail.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) {
    if (feed(l)) {
      const s = sessions.at(-1);
      if (s) console.log(`  [${s.start || 'now'}] ${verdict(s)}  client=${s.clientId || '?'} opusPT=${s.opusPT ?? '-'}`);
    }
  }
});

const stop = (code) => { try { tail.kill(); } catch {} render(sessions.slice(before), 'new handshakes seen while following'); save(); process.exit(code); };
setTimeout(() => { console.log('\ntimeout reached'); stop(real().length ? 0 : 1); }, timeoutSec * 1000);
process.on('SIGINT', () => stop(real().length ? 0 : 1));
