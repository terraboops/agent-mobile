/**
 * mutation — does each new suite actually test its feature, or only its own scaffolding?
 *
 * Twelve suites were added in one day, each reviewed by the same person who wrote it. The
 * outbound-queue episode showed what that can produce: four green commits over a feature that
 * did not work, because every test told the code what it wanted to hear.
 *
 * The check is blunt and therefore hard to fool — DELETE THE FEATURE and confirm the suite
 * notices. A suite that still passes with its feature removed is asserting on scaffolding.
 *
 * SAFETY. These mutations edit the LIVE plugin (adapter.py, the sidecar). Every target is
 * backed up before the edit, restored in a finally, restored again on SIGINT/SIGTERM/uncaught,
 * and verified by hash at the end. If the hash check fails the run says so loudly rather than
 * leaving a mutated plugin behind.
 *
 * Run: npm run mutation            (all)
 *      npm run mutation -- stt     (one, by substring)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const AD = join(homedir(), '.hermes/plugins/agentmob/adapter.py');
const SC = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
const DV = join(REPO, 'test/device-verify.mjs');
const VF = join(REPO, 'test/lib/vendor-files.mjs');
const AS = join(REPO, 'test/lib/adb-state.mjs');
const ADIS = join(REPO, 'test/lib/adb-discover.mjs');
const PROTO = join(REPO, 'proto.js');
const SCORE = join(REPO, 'www/surface-core.js');
const SHOST = join(REPO, 'www/surface-host.js');
const INDEX = join(REPO, 'www/index.html');
const DWATCH = join(REPO, 'test/device-watch.mjs');
const WSF = join(REPO, 'transport/wsframes.js');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Reload the gateway so a mutated sidecar/adapter is the one actually running. */
function restartGateway() {
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.hermes.gateway`],
      { stdio: 'ignore' });
  } catch { /* not running under launchd here */ }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = spawnSync('lsof', ['-nP', '-iTCP:8123', '-sTCP:LISTEN'], { encoding: 'utf8' });
    if ((r.stdout || '').includes('LISTEN')) { spawnSync('sleep', ['6']); return true; }
    spawnSync('sleep', ['2']);
  }
  return false;
}

/** suite -> the one edit that removes the behaviour it claims to test.
 *
 * The first batch covered the suites written during this sweep. The second covers the ones that
 * PREDATE it — written weeks earlier, under less scrutiny, and never mutation-checked. Three of
 * twelve fresh suites turned out to be asserting on scaffolding, so assuming the older ones are
 * sound because they are older is exactly backwards. */
const MUTANTS = [
  { suite: 'adb-state', file: AS, why: 'distinct blocked messages',
    from: 'return `device ${c.unauthorized[0]} is UNAUTHORIZED${waited}',
    to: 'return `something went wrong${waited}' },

  { suite: 'adb-discover', file: ADIS, why: 'mDNS + scan discovery',
    from: '  if (picks.length) {', to: '  if (false) {' },

  { suite: 'port-in-use', file: SC, why: 'the ws EADDRINUSE guard',
    from: "wss.on('error', (e) => {", to: "wss.on('__disabled__', (e) => {" },

  { suite: 'orphan-reap', file: AD, why: 'process-group reaping',
    from: '                    start_new_session=True,\n', to: '' },

  { suite: 'respawn-escalation', file: AD, why: 'flap detection',
    from: '                    if flapping and not cancelled:',
    to: '                    if False and not cancelled:' },

  { suite: 'plugin-drift-soundness', file: join(REPO, 'test/plugin-drift.test.mjs'),
    why: 'the syntax check',
    from: '  const r = await syntaxCheck(vendored);', to: '  const r = { ok: true, error: null };' },

  { suite: 'bridge-recovery', file: AD, why: 'bridge reconnection',
    from: '            except Exception as e:\n                # Was a silent `return`.',
    to: '            except Exception as e:\n                return\n                # Was a silent `return`.' },

  { suite: 'inbound-resilience', file: AD, why: 'handler errors not closing the socket',
    from: '                handler_errors += 1', to: '                handler_errors += 1\n                break' },

  { suite: 'dispatch-delivery', file: AD, why: 'the delivery boundary',
    from: '            delivery_uncertain = True\n            await self.handle_message(event)',
    to: '            await self.handle_message(event)' },

  { suite: 'transcribe-capture', file: AD, why: 'capture cleanup + STT retry',
    from: '        for attempt in range(1, _STT_ATTEMPTS + 1):',
    to: '        for attempt in range(1, 2):' },

  { suite: 'stt-failfast', file: AD, why: 'permanent-vs-transient STT',
    from: '            except _STT_PERMANENT_ERRORS as e:', to: '            except _NeverRaised as e:' },

  { suite: 'tts-failfast', file: AD, why: 'permanent-vs-transient TTS',
    from: '                except _TTS_PERMANENT_ERRORS as e:', to: '                except _NeverRaised as e:' },

  { suite: 'outbound-queue', file: AD, why: 'the outbound queue',
    from: '            if kind in _OUTBOUND_DURABLE:\n                self._outbound_q.append((time.monotonic(), payload))\n                logger.warning("agentmob: bridge closed — queued',
    to: '            if False:\n                self._outbound_q.append((time.monotonic(), payload))\n                logger.warning("agentmob: bridge closed — queued' },

  { suite: 'sidecar-wire', file: SC, why: 'reporting failed sends to the phone',
    from: "  return sendFrame(conn, frame, `status", to: "  return _noSend(conn, frame, `status" },

  { suite: 'sidecar-inbound', file: SC, why: 'naming unknown frame types',
    from: '          log(`rx: unknown frame type ${type}', to: '          void 0 && log(`rx: unknown frame type ${type}' },

  { suite: 'adapter-fields', file: AD, why: 'parity with the real constructor',
    from: '        self._undelivered: list = []',
    to: '        self._undelivered: list = []\n        self._mutation_probe_field = None' },

  { suite: 'device-stages', file: DV, why: 'the reviewed device-stage fixes',
    // Removes the BEHAVIOUR. An earlier version appended a comment to the declaration, which
    // changed nothing and made the suite look weak when the mutation was the weak part.
    from: "    lastShotError = (r.stderr && r.stderr.toString().trim().slice(0, 120))",
    to: "    const _unused = (r.stderr && r.stderr.toString().trim().slice(0, 120))" },

  { suite: 'aead-trigger', file: DV, why: 'the working trigger',
    from: 'const trig = await typedTurn({ text: TRIGGER });',
    to: 'const trig = { ok: true, error: null }; void typedTurn;' },

  /* ---- the four that sat outside the table ------------------------------------------------
   * ux-audit gates 21 rendered states; the e2e harnesses need a live gateway, which makes them
   * awkward to mutate, not exempt from it. */

  { suite: 'ux-audit', file: INDEX, why: 'noticing that the page rendered nothing',
    from: '</head>',
    to: '<style>#ui,#surface,#badge,#ctrlbar{visibility:hidden!important}</style>\n</head>' },

  { suite: 'e2e-webrtc', file: SC, restart: true, why: 'answering the phone\'s WebRTC offer',
    from: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });",
    to: "      ack({ webrtc: { rtype: 'answer' } });" },

  { suite: 'e2e-interrupt', file: SC, restart: true, why: 'cutting the reply short on interrupt',
    from: '        if (tok.cancelled || !target.webrtc || !target.webrtc.connected) {',
    to: '        if (false) {' },

  { suite: 'e2e-voice', file: AD, restart: true, why: 'dispatching the transcript to the agent',
    from: '            await self.dispatch_text(text)',
    to: '            pass  # dispatch removed' },

  /* ---- suites that predate this sweep ---------------------------------------------------- */

  { suite: 'handshake', file: PROTO, why: 'the client confirm MAC is verified',
    from: 'export function verifyConfirm(expectedConfirm, msg) {\n  try {',
    to: 'export function verifyConfirm(expectedConfirm, msg) {\n  if (true) return true;\n  try {' },

  { suite: 'pairing', file: PROTO, why: 'the client allowlist gate',
    from: "  if (allow && !allow(clientIdentity, clientId)) throw new Error('unknown_client');",
    to: '  // allowlist gate removed' },

  /* frames tests frame packing/unpacking and UDP junk-resilience. It does NOT test replay —
   * my first mutation here disabled the replay window and frames sailed through, which said
   * nothing about frames. (Anti-replay IS covered: disabling it fails 4 assertions in
   * handshake. Checked, because the alternative was reporting a security coverage gap that
   * does not exist.) */
  { suite: 'frames', file: WSF, why: 'rejecting frames too short to be a sealed box',
    from: "  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) throw new RangeError('frame too short');",
    to: '  if (false) throw new RangeError(\'frame too short\');' },

  { suite: 'surface-core', file: SCORE, why: 'the storage cap',
    from: '          if ((usage - replacing + bytes) > capacity) {',
    to: '          if (false) {' },

  /* surface-assets tests USAGE ACCOUNTING (counting, replacing, freeing). Poisoning belongs to
   * surface-chunks, which catches it. Mutating the wrong feature made a sound suite look weak. */
  { suite: 'surface-assets', file: SCORE, why: 'freeing the replaced asset\'s bytes',
    from: '          if (replacing) { usage -= replacing;', to: '          if (false) { usage -= replacing;' },

  { suite: 'surface-chunks', file: SCORE, why: 'chunk sequence checking',
    from: '            if (seq !== want) { abort(', to: '            if (false) { abort(' },

  { suite: 'surface-live', file: SHOST, why: 'the per-frame message queue',
    from: '    if (!v.ready) { v.queue.push(msg); return; }', to: '    if (false) { v.queue.push(msg); return; }' },

  { suite: 'surface-protocol', file: SHOST, why: 'the per-frame message queue',
    from: '      v.ready = true;', to: '      v.ready = true; v.queue.length = 0;' },

  { suite: 'surface-integration', file: SCORE, why: 'register_widget_type acknowledgement',
    from: "      case 'register_widget_type': {", to: "      case 'register_widget_type_DISABLED': {" },

  { suite: 'containment', file: INDEX, why: 'the egress-blocking CSP',
    from: '<meta http-equiv="Content-Security-Policy"', to: '<meta http-equiv="X-Disabled-CSP"' },

  { suite: 'ctrlbar-geometry', file: INDEX, why: 'the reserved mic band',
    from: 'calc(50% + 48px)', to: '108px' },

  /* The classifier is the opus-PT comparison, not the STACKS label; mutating the label alone
   * left realDeviceSessions untouched and the suite rightly did not care. */
  { suite: 'device-watch-test', file: DWATCH, why: 'telling a real device from the harness',
    from: 'const real = () => sessions.filter((s) => s.opusPT === 111);',
    to: 'const real = () => sessions.filter((s) => s.opusPT === 999);' },

  { suite: 'ice-config', file: SC, why: 'inline TURN credential parsing',
    from: '    const m = u.match(/^(turns?):([^:@/]+):([^@]*)@(.+)$/i);',
    to: '    const m = null && u.match(/^(turns?):([^:@/]+):([^@]*)@(.+)$/i);' },
];

const only = process.argv[2];
const chosen = only ? MUTANTS.filter((m) => m.suite.includes(only)) : MUTANTS;

const touched = [...new Set(chosen.map((m) => m.file))];
const backups = new Map();
for (const f of touched) {
  if (!existsSync(f)) continue;
  const b = `${f}.mutation-backup`;
  copyFileSync(f, b);
  backups.set(f, { backup: b, hash: sha(f) });
}
let restored = false;
const restoreAll = () => {
  if (restored) return;
  restored = true;
  for (const [f, { backup }] of backups) { try { copyFileSync(backup, f); } catch {} }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(70); });

const results = [];
try {
  for (const m of chosen) {
    if (!existsSync(m.file)) { results.push({ ...m, verdict: 'skip', note: 'file missing' }); continue; }
    const original = readFileSync(m.file, 'utf8');
    if (!original.includes(m.from)) {
      results.push({ ...m, verdict: 'STALE', note: 'the mutation target no longer exists' });
      continue;
    }
    writeFileSync(m.file, original.replace(m.from, m.to));
    /* Purge the bytecode cache. Python will happily load a __pycache__ .pyc compiled from the
     * UNMUTATED source, so the mutation silently does nothing and the suite is recorded as
     * MISSED — which is what happened to tts-failfast: it was CAUGHT when run alone and MISSED
     * in sequence, because an earlier iteration had left a cached adapter behind. A mutation
     * harness that cannot guarantee the mutation took effect is worse than none, since its
     * false MISSES send you auditing tests that are fine. */
    try { rmSync(join(dirname(m.file), '__pycache__'), { recursive: true, force: true }); } catch {}
    /* The sidecar and adapter are RUNNING processes. Editing their source changes nothing until
     * the gateway reloads them, so an e2e mutation without this restart would test the
     * unmutated code and record a false MISS — the live-process equivalent of stale bytecode. */
    if (m.restart) restartGateway();
    const r = spawnSync('npm', ['run', '-s', m.suite],
      { cwd: REPO, encoding: 'utf8', timeout: 900000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    writeFileSync(m.file, original);
    if (m.restart) restartGateway();
    const failed = r.status !== 0;
    const n = (r.stdout || '').match(/(\d+) (?:passed|failed)/g) || [];
    results.push({ ...m, verdict: failed ? 'CAUGHT' : 'MISSED', note: n.join(' ') });
    console.log(`  ${failed ? 'CAUGHT ' : 'MISSED '} ${m.suite.padEnd(24)} (${m.why})`);
  }
} finally {
  restoreAll();
}

/* Prove every file is exactly as we found it, then remove the backups.
 *
 * They used to be left behind: ten .mutation-backup files sitting in the tree and in the live
 * plugin directory, which git then reported as untracked. A harness that tidies up only when
 * you remember to is one more thing to remember. They are deleted ONLY after the hash check
 * passes — if a restore failed they are the recovery path and must survive. */
let clean = true;
for (const [f, { hash }] of backups) {
  const now = sha(f);
  if (now !== hash) { clean = false; console.log(`  !! ${f} NOT RESTORED (${hash.slice(0, 8)} -> ${now.slice(0, 8)})`); }
}
console.log(`\nrestore verified: ${clean ? 'every mutated file is byte-identical to before' : 'FAILED — see above'}`);
if (clean) {
  for (const [, { backup }] of backups) { try { rmSync(backup, { force: true }); } catch {} }
} else {
  console.log('backups KEPT for recovery: ' + [...backups.values()].map((b) => b.backup).join(', '));
}

const missed = results.filter((r) => r.verdict === 'MISSED');
const stale = results.filter((r) => r.verdict === 'STALE');
const caught = results.filter((r) => r.verdict === 'CAUGHT');
console.log(`\n${caught.length} caught, ${missed.length} MISSED, ${stale.length} stale, of ${results.length}`);
for (const r of missed) console.log(`  MISSED: ${r.suite} — passed with "${r.why}" deleted; it is asserting on scaffolding`);
for (const r of stale) console.log(`  STALE : ${r.suite} — ${r.note}`);
process.exit(!clean || missed.length || stale.length ? 1 : 0);
