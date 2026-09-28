/**
 * mutants — the mutation table, in its own module so it can be READ without being RUN.
 *
 * test/mutation.mjs executes mutations the moment it loads, so anything wanting to inspect the
 * table (the coverage gate, for one) cannot simply import that file. Keeping the data separate
 * is what lets a check diff it against the npm scripts.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AD = join(homedir(), '.hermes/plugins/agentmob/adapter.py');
const SC = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
const WRTC = join(homedir(), '.hermes/plugins/agentmob/sidecar/webrtc-media.mjs');
const DV = join(REPO, 'test/device-verify.mjs');
const VF = join(REPO, 'test/lib/vendor-files.mjs');
const AS = join(REPO, 'test/lib/adb-state.mjs');
const ADIS = join(REPO, 'test/lib/adb-discover.mjs');
const PROTO = join(REPO, 'proto.js');
const SCORE = join(REPO, 'www/surface-core.js');
const SHOST = join(REPO, 'www/surface-host.js');
const BRIDGE = join(REPO, 'www/bridge.js');
const INDEX = join(REPO, 'www/index.html');
const DWATCH = join(REPO, 'test/device-watch.mjs');
const WSF = join(REPO, 'transport/wsframes.js');
const GS = join(REPO, 'test/lib/gateway-scope.mjs');
const GRADLE_VARS = join(REPO, 'android/variables.gradle');
/* The adapter inside the SCOPED profile, not the live plugin. These two entries edit a throwaway
 * instance's own copy, so the production adapter is never modified and never needs restoring. */
const SCOPED_AD = join(homedir(), '.hermes/profiles/agentmobtest/plugins/agentmob/adapter.py');

/** suite -> the one edit that removes the behaviour it claims to test.
 *
 * The first batch covered the suites written during this sweep. The second covers the ones that
 * PREDATE it — written weeks earlier, under less scrutiny, and never mutation-checked. Three of
 * twelve fresh suites turned out to be asserting on scaffolding, so assuming the older ones are
 * sound because they are older is exactly backwards. */
export const MUTANTS = [
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

  { suite: 'ice-tailnet', file: SC, restart: true, why: 'gathering the tailnet address as a host candidate',
    from: 'const ICE_HOST_ADDRS = tailnetAddresses();',
    to: 'const ICE_HOST_ADDRS = [];' },

  /* ---- found by the coverage gate: suites that had no entry at all ----------------------- */

  /* Elegant case: the mutation IS drift. Change the installed sidecar and plugin-drift must
   * notice it no longer matches what the repo vendored. */
  { suite: 'plugin-drift', file: SC, why: 'detecting that the installed plugin has drifted',
    from: "function log(m) { console.error('[sidecar] ' + m); }",
    to: "function log(m) { console.error('[sidecar]  ' + m); }" },

  { suite: 'flush-live', file: AD, why: 'queueing when the bridge is down but the socket has not noticed',
    from: '        if not self._connected or self._writer is None or self._writer.is_closing():',
    to: '        if self._writer is None or self._writer.is_closing():' },

  { suite: 'apk-installable', file: DV, why: 'the APK matching what device-verify installs',
    from: "const PKG = 'com.agentmobile.agent';", to: "const PKG = 'com.example.wrong';" },

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

  /* Deliberately NARROW. Removing dispatch_text kills the whole pipeline, which only proves
   * the suite notices a dead one — a script with no assertions at all would catch that too,
   * and this one had none until it was given some. Removing the `heard` status leaves the
   * pipeline fully working (text replies, TTS, speaking indicator all fine) and breaks exactly
   * one of e2e-voice's stated claims. */
  { suite: 'e2e-voice', file: SCOPED_AD, scope: 'gateway',
    why: 'reporting that the utterance was heard',
    from: '        self._push_status(heard=True)',
    to: '        pass  # heard status removed' },

  /* The narration itself. e2e-voice's entry above kills the HEARD status, which is a different
   * feature — before this entry existed, deleting the one line that speaks over a render broke
   * nothing in the table. That is the exact shape of a coverage hole: a feature added with a
   * suite, and a table that still points somewhere else. */
  { suite: 'e2e-voice-render', file: SCOPED_AD, scope: 'gateway',
    why: 'the one spoken line over a purely visual reply',
    from: '        if self._tts_voice:\n            await self._schedule_speak(self._narrate_components([c for c in comp_types if c]))',
    to: '        pass  # narration removed' },

  /* The guard that stands between this harness and the production gateway. If the live-label
     refusal stops firing, every restart-marked mutation is free to kickstart ai.hermes.gateway
     again — the exact regression that cost fourteen production bounces in one night. */
  { suite: 'gateway-scope', file: GS, why: 'the refusal to kickstart the live gateway label',
    from: '  if (label.includes(LIVE_LABEL)) {',
    to: '  if (false) {' },

  /* MEASURED, not assumed. My first entry here forced the downlink stamp to a hardcoded 96,
     expecting it to be fatal at PT 111. It came back MISSED, so I ran it by hand: with
     `const pt = 96` in place, the wire still carried PT 111. werift's sender RE-STAMPS the
     payload type from the negotiated codec, so the RtpHeader payloadType the sidecar passes is
     inert. The only live effect of that `pt` value is the `if (!pt) return false` guard — i.e.
     whether a frame is sent at all, not what number it carries.
     
     Consequence worth stating: the sidecar has NO payload-type-specific logic, so no mutation
     can be caught at 111 and missed at 96. The 111 suite earns its place by exercising the whole
     path (negotiate -> SRTP uplink -> whisper -> agent -> TTS -> RTP downlink) at the number
     Android actually uses, which nothing had ever done — not by isolating PT-specific code that
     does not exist.
     
     So this entry targets what the media path really guarantees: TTS leaves over SRTP rather
     than falling back to the WebSocket. `ready` false sends every reply down the fallback, which
     the suite fails on twice (no downlink RTP, and ws frames > 0). */
  { suite: 'e2e-webrtc-pt111', file: WRTC, restart: true,
    why: 'the RTP downlink being used at all instead of the WebSocket fallback',
    from: '    get ready() { return this.connected && !!this.opusPT; }',
    to: '    get ready() { return false; }' },

  /* The answer must carry the offerer's payload-type mapping back unchanged. Renumbering it —
     here by rewriting opus to 96 on the way out — leaves a well-formed answer that negotiates a
     codec the phone never offered. */
  /* The Java version floor. Dropping minSdk back to 24 reinstates 24 NewApi violations — the
     deepest being Arrays.compareUnsigned (API 33) in the AEAD handshake path, which throws
     rather than degrades. If android-lint does not notice that, it is not gating anything.
     Note this mutates the DECLARED floor rather than adding a bad call: it is the honest
     inverse of the fix, and it exercises the gate's own minSdk resolution too. */
  /* Issue #1's state machine. The re-entrancy guard in audioToggle is what stopped the control
     wedging: without it a double tap flips twice and the label drifts off the hardware, which is
     the original symptom. Deleting it must make the suite notice. */
  { suite: 'mic-mute', file: BRIDGE,
    why: 'the re-entrancy guard that stops a double tap double-flipping the mic',
    from: '      if (self._busy) return Promise.resolve(false);',
    to: '      // guard removed' },

  /* The sweep must be able to say DETECTED, or every "nothing open" it prints is unfalsifiable.
     Making scanPorts never report an open port is the honest inverse. */
  /* The private adb server. Dropping -P puts device-verify back on the shared default server,
     where any listener on the machine enters its device list and gets described to the operator
     as their phone — which is exactly what happened during the 2-hour armed wait. */
  { suite: 'adb-isolation', file: DV,
    why: 'device-verify using its OWN adb server rather than the shared default one',
    from: "  const r = spawnSync(ADB, ['-P', String(ADB_PORT), ...args],",
    to: '  const r = spawnSync(ADB, [...args],' },

  { suite: 'discover-live', file: ADIS,
    why: 'the port sweep actually reporting a listener it found',
    from: '      if (hit) open.push(port);',
    to: '      if (false) open.push(port);' },

  { suite: 'android-lint', file: GRADLE_VARS,
    why: 'minSdkVersion matching the API level the Java actually requires',
    from: '    minSdkVersion = 33',
    to: '    minSdkVersion = 24' },

  { suite: 'webrtc-pt', file: SC, restart: true,
    why: 'returning the answer SDP unmodified, with the offerer\'s payload types intact',
    from: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });",
    to: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp.replace(/a=rtpmap:\\d+ opus/gi, 'a=rtpmap:96 opus') } });" },

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

