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
const WVB = join(REPO, 'test/lib/webview-baseline.mjs');
const DWATCH = join(REPO, 'test/device-watch.mjs');
const WSF = join(REPO, 'transport/wsframes.js');
const GS = join(REPO, 'test/lib/gateway-scope.mjs');
const GRADLE_VARS = join(REPO, 'android/variables.gradle');
/* The adapter inside the SCOPED profile, not the live plugin. These two entries edit a throwaway
 * instance's own copy, so the production adapter is never modified and never needs restoring. */
const SCOPED_AD = join(homedir(), '.hermes/profiles/agentmobtest/plugins/agentmob/adapter.py');
const SCOPED_SC = join(homedir(),
  '.hermes/profiles/agentmobtest/plugins/agentmob/sidecar/index.mjs');

/** suite -> the one edit that removes the behaviour it claims to test.
 *
 * The first batch covered the suites written during this sweep. The second covers the ones that
 * PREDATE it — written weeks earlier, under less scrutiny, and never mutation-checked. Three of
 * twelve fresh suites turned out to be asserting on scaffolding, so assuming the older ones are
 * sound because they are older is exactly backwards. */
export const MUTANTS = [
  { suite: 'adb-state', file: AS, why: 'distinct blocked messages',
    breaks: 'unauthorized message names the on-phone prompt',
    from: 'return `device ${c.unauthorized[0]} is UNAUTHORIZED${waited}',
    to: 'return `something went wrong${waited}' },

  { suite: 'adb-discover', file: ADIS, why: 'mDNS + scan discovery',
    breaks: 'discover: uses the mDNS endpoint',
    from: '  if (picks.length) {', to: '  if (false) {' },

  { suite: 'port-in-use', file: SC, why: 'the ws EADDRINUSE guard',
    breaks: 'ws port in use: it does NOT die with a raw unhandled error',
    from: "wss.on('error', (e) => {", to: "wss.on('__disabled__', (e) => {" },

  { suite: 'orphan-reap', file: AD, why: 'process-group reaping',
    breaks: '_run_sidecar puts it in its OWN process group (pgid ==',
    from: '                    start_new_session=True,\n', to: '' },

  { suite: 'respawn-escalation', file: AD, why: 'flap detection',
    breaks: 'stay-up loop: it IS escalated as FLAPPING',
    from: '                    if flapping and not cancelled:',
    to: '                    if False and not cancelled:' },

  { suite: 'plugin-drift-soundness', file: join(REPO, 'test/plugin-drift.test.mjs'),
    why: 'the syntax check',
    breaks: 'CORRUPT-BUT-IDENTICAL: the drift check FAILS',
    from: '  const r = await syntaxCheck(vendored);', to: '  const r = { ok: true, error: null };' },

  { suite: 'bridge-recovery', file: AD, why: 'bridge reconnection',
    breaks: 'an UNEXPECTED exception is not terminal for the bridge',
    from: '            except Exception as e:\n                # Was a silent `return`.',
    to: '            except Exception as e:\n                return\n                # Was a silent `return`.' },

  { suite: 'inbound-resilience', file: AD, why: 'handler errors not closing the socket',
    breaks: 'the connection was NOT torn down by the handler failures',
    from: '                handler_errors += 1', to: '                handler_errors += 1\n                break' },

  { suite: 'dispatch-delivery', file: AD, why: 'the delivery boundary',
    breaks: 'uncertain: handle_message was entered exactly once (NO',
    from: '            delivery_uncertain = True\n            await self.handle_message(event)',
    to: '            await self.handle_message(event)' },

  { suite: 'transcribe-capture', file: AD, why: 'capture cleanup + STT retry',
    breaks: 'transient: STT was attempted TWICE',
    from: '        for attempt in range(1, _STT_ATTEMPTS + 1):',
    to: '        for attempt in range(1, 2):' },

  { suite: 'stt-failfast', file: AD, why: 'permanent-vs-transient STT',
    breaks: 'permanent: logged with its own name, not as a generic STT',
    from: '            except _STT_PERMANENT_ERRORS as e:', to: '            except _NeverRaised as e:' },

  { suite: 'tts-failfast', file: AD, why: 'permanent-vs-transient TTS',
    breaks: 'permanent: each engine tried exactly ONCE',
    from: '                except _TTS_PERMANENT_ERRORS as e:', to: '                except _NeverRaised as e:' },

  { suite: 'outbound-queue', file: AD, why: 'the outbound queue',
    breaks: 'down: a user-facing reply is held',
    from: '            if kind in _OUTBOUND_DURABLE:\n                self._outbound_q.append((time.monotonic(), payload))\n                logger.warning("agentmob: bridge closed — queued',
    to: '            if False:\n                self._outbound_q.append((time.monotonic(), payload))\n                logger.warning("agentmob: bridge closed — queued' },

  { suite: 'sidecar-wire', file: SC, why: 'reporting failed sends to the phone',
    breaks: 'pushStatus routes through it',
    from: "  return sendFrame(conn, frame, `status", to: "  return _noSend(conn, frame, `status" },

  { suite: 'sidecar-inbound', file: SC, why: 'naming unknown frame types',
    breaks: 'unknown type: it is LOGGED, not silently dropped',
    from: '          log(`rx: unknown frame type ${type}', to: '          void 0 && log(`rx: unknown frame type ${type}' },

  { suite: 'adapter-fields', file: AD, why: 'parity with the real constructor',
    breaks: 'bridge-recovery.test.py: carries the state fields it does',
    from: '        self._undelivered: list = []',
    to: '        self._undelivered: list = []\n        self._mutation_probe_field = None' },

  { suite: 'device-stages', file: DV, why: 'the reviewed device-stage fixes',
    breaks: 'a failed screenshot records WHY',
    // Removes the BEHAVIOUR. An earlier version appended a comment to the declaration, which
    // changed nothing and made the suite look weak when the mutation was the weak part.
    from: "    lastShotError = (r.stderr && r.stderr.toString().trim().slice(0, 120))",
    to: "    const _unused = (r.stderr && r.stderr.toString().trim().slice(0, 120))" },

  { suite: 'aead-trigger', file: DV, why: 'the working trigger',
    breaks: 'device-verify calls it',
    from: 'const trig = await typedTurn({ text: TRIGGER });',
    to: 'const trig = { ok: true, error: null }; void typedTurn;' },

  { suite: 'ice-tailnet', file: SC, restart: true, why: 'gathering the tailnet address as a host candidate',
    breaks: 'the answer contains a tailnet candidate (100.125.53.51)',
    from: 'const ICE_HOST_ADDRS = tailnetAddresses();',
    to: 'const ICE_HOST_ADDRS = [];' },

  /* ---- found by the coverage gate: suites that had no entry at all ----------------------- */

  /* Elegant case: the mutation IS drift. Change the installed sidecar and plugin-drift must
   * notice it no longer matches what the repo vendored. */
  { suite: 'plugin-drift', file: SC, why: 'detecting that the installed plugin has drifted',
    breaks: 'sidecar/index.mjs: installed matches vendored',
    from: "function log(m) { console.error('[sidecar] ' + m); }",
    to: "function log(m) { console.error('[sidecar]  ' + m); }" },

  { suite: 'flush-live', file: AD, why: 'queueing when the bridge is down but the socket has not noticed',
    breaks: 'the send during the outage was QUEUED, not dropped',
    from: '        if not self._connected or self._writer is None or self._writer.is_closing():',
    to: '        if self._writer is None or self._writer.is_closing():' },

  { suite: 'apk-installable', file: DV, why: 'the APK matching what device-verify installs',
    breaks: 'it is the package device-verify installs and launches',
    from: "const PKG = 'com.agentmobile.agent';", to: "const PKG = 'com.example.wrong';" },

  /* ---- the four that sat outside the table ------------------------------------------------
   * ux-audit gates 21 rendered states; the e2e harnesses need a live gateway, which makes them
   * awkward to mutate, not exempt from it. */

  { suite: 'ux-audit', file: INDEX, why: 'noticing that the page rendered nothing',
    breaks: ': 20 issue(s), 0 unexpected page error(s)',
    from: '</head>',
    to: '<style>#ui,#surface,#badge,#ctrlbar{visibility:hidden!important}</style>\n</head>' },

  { suite: 'e2e-webrtc', file: SC, restart: true, why: 'answering the phone\'s WebRTC offer',
    breaks: 'sidecar returned an SDP answer over the encrypted cmd',
    from: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });",
    to: "      ack({ webrtc: { rtype: 'answer' } });" },

  { suite: 'e2e-interrupt', file: SC, restart: true, why: 'cutting the reply short on interrupt',
    breaks: 'downlink stopped after the interrupt (61 -> 177 -> 271)',
    from: '        if (tok.cancelled || !target.webrtc || !target.webrtc.connected) {',
    to: '        if (false) {' },

  /* Deliberately NARROW. Removing dispatch_text kills the whole pipeline, which only proves
   * the suite notices a dead one — a script with no assertions at all would catch that too,
   * and this one had none until it was given some. Removing the `heard` status leaves the
   * pipeline fully working (text replies, TTS, speaking indicator all fine) and breaks exactly
   * one of e2e-voice's stated claims. */
  { suite: 'e2e-voice', file: SCOPED_AD, scope: 'gateway',
    why: 'reporting that the utterance was heard',
    breaks: 'the sidecar reported hearing the utterance (status.heard)',
    from: '        self._push_status(heard=True)',
    to: '        pass  # heard status removed' },

  /* The narration itself. e2e-voice's entry above kills the HEARD status, which is a different
   * feature — before this entry existed, deleting the one line that speaks over a render broke
   * nothing in the table. That is the exact shape of a coverage hole: a feature added with a
   * suite, and a table that still points somewhere else. */
  { suite: 'e2e-voice-render', file: SCOPED_AD, scope: 'gateway',
    why: 'the one spoken line over a purely visual reply',
    breaks: 'the reply was spoken (TTS audio frames arrived)',
    from: '        if self._tts_voice:\n            await self._schedule_speak(self._narrate_components([c for c in comp_types if c]))',
    to: '        pass  # narration removed' },

  /* The guard that stands between this harness and the production gateway. If the live-label
     refusal stops firing, every restart-marked mutation is free to kickstart ai.hermes.gateway
     again — the exact regression that cost fourteen production bounces in one night. */
  { suite: 'gateway-scope', file: GS, why: 'the refusal to kickstart the live gateway label',
    breaks: 'refuses "ai.hermes.gateway" even with',
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
    breaks: 'agent TTS arrived as RTP on the WebRTC downlink (0 pkts,',
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
    breaks: 'a double tap causes exactly ONE native transition',
    from: '      if (self._busy) return Promise.resolve(false);',
    to: '      // guard removed' },

  /* The sweep must be able to say DETECTED, or every "nothing open" it prints is unfalsifiable.
     Making scanPorts never report an open port is the honest inverse. */
  /* The private adb server. Dropping -P puts device-verify back on the shared default server,
     where any listener on the machine enters its device list and gets described to the operator
     as their phone — which is exactly what happened during the 2-hour armed wait. */
  /* The allowlist gate, at the sidecar end of the chain. Forcing clientAllow to null puts the
     sidecar into pairing mode regardless of configuration — so a pinned gateway would silently
     accept ANY client, which is the failure that makes pinning worthless while looking fine.
     proto.js's `allow` callback itself is covered separately by the pairing suite. */
  /* THE falsifiable version of issue #1, and the reason this suite exists alongside
     mute-midreply. Drop the VAD threshold and digital silence from a muted mic reads as speech
     onset; maybeBargeIn() then cancels the in-flight reply. On the PACED WebRTC downlink the
     sidecar re-checks that cancel token before every frame, so the reply is genuinely truncated
     and the truncation is recorded — "cut short after i/n frames: superseded or interrupted".
     The same mutation MISSED against mute-midreply, because the WS downlink is burst-sent and
     there is no pacing left to cancel. Same bug, same mutation, and only this path can see it. */
  /* The floor comparison IS the gate. Break it and nothing above the floor is ever flagged,
     which looks exactly like a clean surface — the failure mode this gate already had once, when
     it printed a finding and still reported ALL PASS. The suite's positive control (a fixture of
     known-modern features that must be flagged) is what notices. */
  { suite: 'webview-baseline', file: WVB,
    why: 'flagging a feature that needs a newer WebView than minSdk guarantees',
    breaks: 'the CSS scanner flags known-modern features',
    from: '    if (chrome > floor && re.test(code)) found.push({ file: name, feature: feat, chrome });',
    to: '    if (false) found.push({ file: name, feature: feat, chrome });' },

  { suite: 'mute-webrtc', file: SCOPED_SC, scope: 'gateway',
    why: 'the VAD threshold that stops a muted mic being heard as speech onset',
    breaks: 'the reply KEPT PLAYING while the mic streamed silence',
    /* Names the assertion this MUST take down. Without it, an entry that merely breaks a
       precondition reads as coverage — which is exactly what mute-midreply's SILENCE_MS entry
       did before it was removed. */
    breaks: 'KEPT PLAYING',
    from: 'const SPEECH_RMS = 700;',
    to: 'const SPEECH_RMS = -1;' },

  { suite: 'identity-pin', file: SCOPED_SC, scope: 'gateway',
    why: 'the sidecar honouring AGENTMOB_ALLOWED_CLIENTS at all',
    breaks: 'a client not on the allowlist is REJECTED',
    from: 'const clientAllow = _allowSet.size',
    to: 'const clientAllow = 0 && _allowSet.size' },

  { suite: 'adb-isolation', file: DV,
    why: 'device-verify using its OWN adb server rather than the shared default one',
    breaks: 'the isolated run never mentioned the stub',
    from: "  const r = spawnSync(ADB, ['-P', String(ADB_PORT), ...args],",
    to: '  const r = spawnSync(ADB, [...args],' },

  { suite: 'discover-live', file: ADIS,
    why: 'the port sweep actually reporting a listener it found',
    breaks: 'the real discovery path DETECTED the listener',
    from: '      if (hit) open.push(port);',
    to: '      if (false) open.push(port);' },

  { suite: 'android-lint', file: GRADLE_VARS,
    why: 'minSdkVersion matching the API level the Java actually requires',
    breaks: 'no Java code calls an API above minSdk (NewApi)',
    from: '    minSdkVersion = 33',
    to: '    minSdkVersion = 24' },

  { suite: 'webrtc-pt', file: SC, restart: true,
    why: 'returning the answer SDP unmodified, with the offerer\'s payload types intact',
    breaks: 'the answer echoes the offered payload type (111)',
    from: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });",
    to: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp.replace(/a=rtpmap:\\d+ opus/gi, 'a=rtpmap:96 opus') } });" },

  /* SECOND entries, now that the table allows them. One entry per suite proved only that a suite
     is not entirely scaffolding; these target a DIFFERENT claim in the two suites carrying the
     most assertions behind a single mutation (56 and 42). */

  /* surface-live #2 — the sandbox realm strip. Its first entry covers the per-frame message
     queue; this covers the security claim: widget code must not be able to reach WebRTC, which
     is the one API CSP cannot close. Leave the list empty and RTCPeerConnection is defined
     inside the frame. */
  { suite: 'surface-live', file: BRIDGE,
    why: 'stripping WebRTC from the widget sandbox realm',
    breaks: 'sandbox: RTCPeerConnection is not available to widget code',
    from: "    + 'var N=[\"RTCPeerConnection\",",
    to: "    + 'var N=[\"__NothingStripped\",\"RTCPeerConnection_disabled\"," },

  /* surface-live #3 — the egress block, which takes TWO edits because it is defence in depth.
     The widget frame is subject to the page's CSP (inherited through srcdoc) AND the sandbox
     preamble's meta CSP, and the most restrictive wins. Measured with a probe widget, changing
     only the CSP: preamble only -> 0 canary hits, page only -> 0, BOTH -> 2. In every one of
     those runs the widget's own fetch reported "Failed to fetch", because its opaque origin
     blocks the RESPONSE even when the request was sent and arrived — which is exactly why the
     canary counts bytes and the widget's verdict is ignored.
     A single-edit entry MISSED here, and the wrong lesson would have been "unguardable". */
  { suite: 'surface-live',
    why: 'the two CSPs that together stop widget code reaching the network',
    breaks: 'NO egress: the canary received 0 requests from the surface',
    edits: [
      { file: BRIDGE, from: "connect-src \\'none\\'", to: 'connect-src *' },
      { file: INDEX,
        from: "               connect-src 'none'; webrtc 'block';",
        to: "               connect-src *; webrtc 'block';" },
    ] },

  /* adb-discover #2 — its first entry covers mDNS + scan discovery; this covers reading the
     peer's LAN address out of tailscale status, which is what stopped a reachable handset being
     reported as "powered off" when our own sweep drowned the probe. */
  { suite: 'adb-discover', file: ADIS,
    why: 'extracting the peer LAN address from a tailscale status row',
    breaks: 'the direct LAN address is extracted',
    from: "    const direct = /\\bdirect\\s+(\\d{1,3}(?:\\.\\d{1,3}){3}):(\\d+)/.exec(line);",
    to: '    const direct = null;' },

  /* ---- suites that predate this sweep ---------------------------------------------------- */

  { suite: 'handshake', file: PROTO, why: 'the client confirm MAC is verified',
    breaks: 'impostor client confirm rejected',
    from: 'export function verifyConfirm(expectedConfirm, msg) {\n  try {',
    to: 'export function verifyConfirm(expectedConfirm, msg) {\n  if (true) return true;\n  try {' },

  { suite: 'pairing', file: PROTO, why: 'the client allowlist gate',
    breaks: 'pinned by short id: a stranger is rejected as',
    from: "  if (allow && !allow(clientIdentity, clientId)) throw new Error('unknown_client');",
    to: '  // allowlist gate removed' },

  /* frames tests frame packing/unpacking and UDP junk-resilience. It does NOT test replay —
   * my first mutation here disabled the replay window and frames sailed through, which said
   * nothing about frames. (Anti-replay IS covered: disabling it fails 4 assertions in
   * handshake. Checked, because the alternative was reporting a security coverage gap that
   * does not exist.) */
  { suite: 'frames', file: WSF, why: 'rejecting frames too short to be a sealed box',
    breaks: 'unpack(short) throws RangeError for caller to drop',
    from: "  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) throw new RangeError('frame too short');",
    to: '  if (false) throw new RangeError(\'frame too short\');' },

  { suite: 'surface-core', file: SCORE, why: 'the storage cap',
    breaks: ': storage cap enforced with feedback',
    from: '          if ((usage - replacing + bytes) > capacity) {',
    to: '          if (false) {' },

  /* surface-assets tests USAGE ACCOUNTING (counting, replacing, freeing). Poisoning belongs to
   * surface-chunks, which catches it. Mutating the wrong feature made a sound suite look weak. */
  { suite: 'surface-assets', file: SCORE, why: 'freeing the replaced asset\'s bytes',
    breaks: 'replacing an asset frees the old bytes first (400, not',
    from: '          if (replacing) { usage -= replacing;', to: '          if (false) { usage -= replacing;' },

  { suite: 'surface-chunks', file: SCORE, why: 'chunk sequence checking',
    breaks: 'out-of-order chunk (seq 2 after 0) is rejected with a seq',
    from: '            if (seq !== want) { abort(', to: '            if (false) { abort(' },

  { suite: 'surface-live', file: SHOST, why: 'the per-frame message queue',
    breaks: 'throwing widget reports ok:false',
    from: '    if (!v.ready) { v.queue.push(msg); return; }', to: '    if (false) { v.queue.push(msg); return; }' },

  { suite: 'surface-protocol', file: SHOST, why: 'the per-frame message queue (protocol view)',
    breaks: 'throwing widget reports ok:false',
    from: '      v.ready = true;', to: '      v.ready = true; v.queue.length = 0;' },

  { suite: 'surface-integration', file: SCORE, why: 'register_widget_type acknowledgement',
    breaks: ': register_widget_type -> type_ready',
    from: "      case 'register_widget_type': {", to: "      case 'register_widget_type_DISABLED': {" },

  { suite: 'containment', file: INDEX, why: 'the egress-blocking CSP',
    breaks: 'NO egress: the reachable canary received 0 requests (CSP',
    from: '<meta http-equiv="Content-Security-Policy"', to: '<meta http-equiv="X-Disabled-CSP"' },

  { suite: 'ctrlbar-geometry', file: INDEX, why: 'the reserved mic band',
    breaks: '320dp @ font x1.3: Stop clears the mic by >= 8dp',
    from: 'calc(50% + 48px)', to: '108px' },

  /* The classifier is the opus-PT comparison, not the STACKS label; mutating the label alone
   * left realDeviceSessions untouched and the suite rightly did not care. */
  { suite: 'device-watch-test', file: DWATCH, why: 'telling a real device from the harness',
    breaks: 'android: classified as a REAL device',
    from: 'const real = () => sessions.filter((s) => s.opusPT === 111);',
    to: 'const real = () => sessions.filter((s) => s.opusPT === 999);' },

  { suite: 'ice-config', file: SC, why: 'inline TURN credential parsing',
    breaks: 'turn: the relay url is kept',
    from: '    const m = u.match(/^(turns?):([^:@/]+):([^@]*)@(.+)$/i);',
    to: '    const m = null && u.match(/^(turns?):([^:@/]+):([^@]*)@(.+)$/i);' },
];

