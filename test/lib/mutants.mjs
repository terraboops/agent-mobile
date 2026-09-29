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
const WIRE = join(homedir(), '.hermes/plugins/agentmob/sidecar/wire.mjs');
const MAIN = join(REPO, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');
const APKFACTS = join(REPO, 'test/lib/apk-facts.mjs');
const GRADLE_APP = join(REPO, 'android/app/build.gradle');
const GS = join(REPO, 'test/lib/gateway-scope.mjs');
const SCOPEDGW = join(REPO, 'test/lib/scoped-gateway.mjs');
const GRADLE_VARS = join(REPO, 'android/variables.gradle');
const AEADTRIG = join(REPO, 'test/lib/aead-trigger.mjs');
const ICEPATH = join(REPO, 'test/lib/ice-path.mjs');
const LINTRPT = join(REPO, 'test/lib/lint-report.mjs');
const DPROBE = join(REPO, 'test/lib/device-probe.mjs');
const FSTACK = join(REPO, 'test/lib/font-stack.mjs');
const MFACTS = join(REPO, 'test/lib/manifest-facts.mjs');
const JFACTS = join(REPO, 'test/lib/java-facts.mjs');
const SSEL = join(REPO, 'test/lib/stage-select.mjs');
const RFACTS = join(REPO, 'test/lib/run-facts.mjs');
const DACC = join(REPO, 'test/lib/device-acceptance.mjs');
const PLUGINJ = join(REPO,
  'android/app/src/main/java/com/agentmobile/agent/AgentChannelPlugin.java');
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
    breaks: 'the answer contains a tailnet candidate',
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
    breaks: 'unexpected page error(s)',
    from: '</head>',
    to: '<style>#ui,#surface,#badge,#ctrlbar{visibility:hidden!important}</style>\n</head>' },

  { suite: 'e2e-webrtc', file: SC, restart: true, why: 'answering the phone\'s WebRTC offer',
    breaks: 'sidecar returned an SDP answer over the encrypted cmd',
    from: "      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });",
    to: "      ack({ webrtc: { rtype: 'answer' } });" },

  { suite: 'e2e-interrupt', file: SC, restart: true, why: 'cutting the reply short on interrupt',
    breaks: 'downlink stopped after the interrupt',
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
    breaks: 'speech arrived AFTER the render envelope',
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
    breaks: 'arrived as RTP on the WebRTC downlink',
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
    breaks: 'the answer echoes the offered payload type',
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

  /* ---- SECOND entries for the heaviest suites (gap 3) -------------------------------------
     Each targets a different claim from the suite's first entry, and each names the assertion it
     must take down so a precondition-breaker cannot pass as coverage. */

  /* gateway-scope #2 — the .env ALLOWLIST. Its first entry covers the live-label refusal.
     I first named this as breaking the TELEGRAM_BOT_TOKEN assertion, and the harness returned
     WRONG-CLAIM: with the allowlist bypassed, TELEGRAM is STILL filtered, because ENV_FORBID
     catches it independently. That is defence in depth working, demonstrated rather than
     assumed — and it means the allowlist's unique contribution is the key nobody anticipated,
     which no denylist can name in advance. SOME_OTHER_SECRET is exactly that key. */
  { suite: 'gateway-scope', file: SCOPEDGW,
    why: 'the .env allowlist that keeps UNANTICIPATED credentials out of the scoped instance',
    breaks: 'does NOT carry SOME_OTHER_SECRET',
    from: '    if (!ENV_ALLOW.includes(k)) continue;',
    to: '    if (false) continue;' },

  /* adb-state #2 — the OFFLINE classification. First entry covers the unauthorized message.
     Fold offline into ready and a device adb can see but cannot talk to is reported as usable,
     which sends the whole verify down a path the phone cannot follow. */
  { suite: 'adb-state', file: AS,
    why: 'keeping OFFLINE distinct from a ready device',
    breaks: 'offline: bucketed as offline',
    from: "  offline: 'offline',",
    to: "  offline: 'ready'," },

  /* device-stages #2 — the local preflight running BEFORE the device gate. First entry covers
     screenshot failure reporting. Move the preflight behind the gate and it never executes,
     because a run with no device finishes first — which is how a stale APK stayed discoverable
     only after a handset was connected. */
  { suite: 'device-stages', file: DV,
    why: 'the local preflight running before the device gate',
    breaks: 'runs BEFORE the device gate',
    from: 'for (const p of localApkPreflight()) stage(p.name, p.status, p.detail);',
    to: '/* preflight moved behind the gate */' },

  /* handshake #2 — the SERVER identity pin. First entry covers the client confirm MAC. Drop the
     pin comparison and a client accepts any server key: the phone would complete a handshake
     with an impostor gateway and never know. */
  { suite: 'handshake', file: PROTO,
    why: 'the client checking the server identity against its pin',
    breaks: 'identity',
    from: '    if (pin.length !== serverIdentity.length || !timingSafeEqual(pin, serverIdentity)) throw new Error(\'identity_mismatch\');',
    to: '    if (false) throw new Error(\'identity_mismatch\');' },

  /* sidecar-wire #2 — reporting WHICH socket state lost the frame. First entry covers routing
     pushStatus through sendFrame. Blank the state and an undelivered frame is reported without
     saying whether the socket was closing, closed or never opened — the difference between a
     reconnect and a bug. */
  { suite: 'sidecar-wire', file: WIRE,
    why: 'naming the socket state that lost the frame',
    breaks: 'the log names the state',
    from: 'log(`→ phone ${what} NOT SENT: socket is ${wsState(ws)}`',
    to: 'log(`→ phone ${what} NOT SENT: socket is unknown`' },

  /* sidecar-inbound #2 — the WEDGE ESCALATION. Its first entry covers naming an unknown frame
     type; this covers the alarm that fires when frames keep failing. Without it the sidecar
     drops every frame quietly and the phone looks connected while nothing it sends gets
     through — a handler bug wearing a link problem's clothes.
     My first attempt here made the handler rethrow and named "the channel is untouched"; the
     harness returned WRONG-CLAIM, because the channel survives a rethrow anyway (the outer
     layer catches) and what actually broke was the wedge counting. The code was fine; the claim
     I wrote was wrong. */
  { suite: 'sidecar-inbound', file: SC, restart: true,
    why: 'the wedge alarm that fires when frames keep failing to process',
    breaks: 'RX HANDLER WEDGED fired at the SHIPPED threshold',
    from: '        if (conn.rxFails === RX_FAIL_ESCALATE) {',
    to: '        if (false) {' },

  /* ctrlbar-geometry #2 — the INSET LISTENER, not the reserved band (entry #1). targetSdk 36
     forces edge-to-edge, so android.R.id.content spans the navigation bar; without honouring the
     systemBars inset the native mic parks its lower third inside the gesture strip, where a
     swipe-up belongs to the system and the tap never arrives — and it drifts off Stop, which
     DOES honour env(safe-area-inset-bottom). Both sides must read the same inset.
     Targets the inset ARITHMETIC, not the listener registration: my first attempt wrapped the
     listener in `if (false)`, which left the method name in the source — and the assertion greps
     the Java for it, so the mutation changed behaviour while the test still matched. MISSED. */
  { suite: 'ctrlbar-geometry', file: MAIN,
    why: 'the native mic honouring the systemBars inset under edge-to-edge',
    breaks: 'native mic margin is inset-aware',
    from: '                int want = dp(MIC_BOTTOM_GAP_DP) + navBottom;',
    to: '                int want = dp(MIC_BOTTOM_GAP_DP);' },

  /* apk-installable #2 — the bundled-asset comparison, not package identity (entry #1).
     My first version here flipped `===` to `!==` in the suite's OWN assertion. It went CAUGHT,
     but it proved nothing about the product: mutating the judge is not testing the judged.
     mutation-coverage now refuses that shape. This targets apk-facts, the library doing the
     comparing — the check that caught an APK built BEFORE the issue #2 fix, which would have
     installed cleanly and behaved exactly like the bug it was meant to fix. */
  { suite: 'apk-installable', file: APKFACTS,
    why: 'comparing bundled web assets against www/ byte for byte',
    breaks: 'DETECTS a file that differs',
    from: '      if (sha(inApk) !== sha(join(wwwDir, f))) mismatched.push(f);',
    to: '      if (false) mismatched.push(f);' },

  /* ice-config #2 — the TAILNET host candidate, not TURN parsing (entry #1). Neither side
     enumerates the Tailscale utun on its own (ICE skips point-to-point interfaces, and Android
     libwebrtc has the same blind spot), so a remote phone otherwise sees only a LAN candidate it
     cannot route to. Stop advertising it and ICE stalls at `connecting` with the downlink
     silently falling back to the WebSocket. */
  { suite: 'ice-config', file: SC, restart: true,
    why: 'advertising this host tailnet address as an extra ICE host candidate',
    breaks: 'advertises the tailnet host candidate',
    from: "  if (/^(1|true|yes)$/i.test(process.env.AGENTMOB_NO_TAILNET_ICE || '')) return [];",
    to: '  if (true) return [];' },

  /* mic-mute #2 — issue #1's CORE claim, not the re-entrancy guard (entry #1). Uplink and
     downlink are separate directions; muting yourself must not silence the agent. Make the mute
     path clear the speaking widget and the surface stops indicating a reply the moment you mute,
     which is the bug users actually hit. */
  { suite: 'mic-mute', file: BRIDGE,
    why: 'muting the mic leaving the agent-speaking indicator alone',
    breaks: 'reply KEPT PLAYING',
    from: "      if (!running) ring.classList.remove('pulse');",
    to: "      if (!running) { ring.classList.remove('pulse'); var _b = document.getElementById('agentSpeech'); if (_b) _b.classList.remove('show'); }" },

  /* webview-baseline #2 — COMMENT STRIPPING, not the floor comparison (entry #1). The prose
     explaining this gate names the very features it scans for, so a scanner that reads comments
     flags the explanation and the gate cries wolf until someone turns it off. */
  { suite: 'webview-baseline', file: WVB,
    why: 'scanning code with comments stripped, so prose is not flagged',
    breaks: 'named only in a JS comment',
    from: "    ? codeOnly(raw, 'js')",
    to: '    ? raw' },

  /* discover-live #2 — the SKIPPED/SWEPT distinction, not detection (entry #1). device-verify
     sweeps on a slower cadence than it polls mDNS, so most passes send nothing. Collapse the
     skip sentinel into an empty result and a pass that never ran is reported as a measurement
     that found nothing — a negative nobody took.
     Targets the didScan flag rather than the skip BRANCH: removing the branch makes the suite
     crash instead of assert, which the harness reports as a claimless failure. */
  { suite: 'discover-live', file: ADIS,
    why: 'telling a skipped sweep apart from one that found nothing',
    breaks: 'still records that it really swept',
    from: '    didScan = true;',
    to: '    didScan = false;' },

  /* android-lint #2 — the XML REPORT the gate reads, not the minSdk floor (entry #1).
     My first attempt here mutated the suite's OWN assertion to `true`, which by construction
     cannot fail that suite — a category error the harness returned as MISSED. A mutation must
     change code UNDER TEST, never the test's own condition; mutation-coverage now refuses an
     entry that edits its suite's own file. Without the report there is nothing to parse, and a
     gate that cannot read its input must say so rather than pass. */
  { suite: 'android-lint', file: GRADLE_APP,
    why: 'lint writing its XML report where the gate reads it',
    breaks: 'lint wrote its report',
    from: '        xmlOutput = file("$projectDir/build/reports/agentmob-lint.xml")',
    to: '        xmlOutput = file("$projectDir/build/reports/elsewhere.xml")' },

  /* pairing #2 — pinning by SPKI, not by short id (entry #1 covers the gate itself). The
     allowlist accepts either form; drop the base64 branch and an operator who pinned the full
     public key locks the phone out of its own gateway while the config looks correct. */
  { suite: 'pairing', file: SC, restart: true,
    why: 'accepting a client pinned by full SPKI as well as by short id',
    breaks: 'mirrored allowlist matches the shipped one',
    from: "  ? (pub, id) => _allowSet.has(id) || _allowSet.has(Buffer.from(pub).toString('base64'))",
    to: '  ? (pub, id) => _allowSet.has(id)' },

  /* frames #2 — the CATCH-ALL that makes a malformed frame null rather than an exception.
     Entry #1 covers unpack's length guard, in a different file.
     Two earlier attempts here went MISSED, and the reason is worth recording: every recvBytes
     assertion in that suite is "returns null, no throw", and the outer try/catch satisfies all
     of them however many individual guards are removed. Removing a guard changes nothing the
     suite can see. It takes a MULTI-EDIT to show it: drop the null-frame guard AND make the
     catch rethrow, and recvBytes(null) finally throws instead of returning null. Defence in
     depth again — the same shape as surface-live's two CSPs, and the same reason single-edit
     entries kept reporting MISSED on a property that is perfectly falsifiable.
     My first attempt removed the nonce-length check in recvBytes and went MISSED: a 5-byte
     nonce fails decryption anyway, so that guard is redundant for the input the suite feeds.
     Defence in depth again — the guard is real, but not what makes THAT assertion pass. */
  { suite: 'frames',
    why: 'turning a malformed frame into null instead of an exception',
    breaks: 'no throw',
    edits: [
      { file: PROTO, from: '      if (!frame || !frame.nonce) return null;', to: '' },
      { file: PROTO, from: '    } catch { return null; }', to: '    } catch (e) { throw e; }' },
    ] },

  /* surface-core #2 — the DEPENDENCY gate, not the storage cap (entry #1). A widget type whose
     assets are not present must not register: the agent has to ship and test its deps first,
     rather than register a type that renders a blank frame on the phone.
     My first attempt here targeted chunk sequencing, which belongs to surface-chunks — this
     suite never exercises it, so the mutation went MISSED. Guessing at a suite's claim instead
     of reading it costs a full run each time. */
  { suite: 'surface-core', file: SCORE,
    why: 'refusing to register a widget type whose asset deps are missing',
    breaks: 'widget type registered when dep present',
    from: '          const missing = (deps || []).find(d => !assets[d]);',
    to: '          const missing = true;' },

  /* e2e-webrtc #2 — choosing the WEBRTC downlink over the WS fallback, not the SDP answer
     (entry #1). `viaW` is the whole decision: force it false and every reply goes out over the
     WebSocket while ICE sits connected, which is the silent demotion this suite exists to catch
     (it reads as working audio with none of WebRTC's pacing or AEC). */
  { suite: 'e2e-webrtc', file: SC, restart: true,
    why: 'choosing the WebRTC downlink when the peer is ready',
    breaks: 'did NOT fall back to the WebSocket',
    from: '    const viaW = !!(target.webrtc && target.webrtc.ready);',
    to: '    const viaW = false;' },

  /* e2e-voice #2 — CLEARING the speaking indicator, where entry #1 covers raising the heard
     one. A pill that never clears reads as "still talking" for ever.

     TWO EDITS, because the property has two independent guarantees and a single-edit mutation
     cannot falsify it. _clear_speaking_after() clears on the estimated duration; the barge-in /
     turn-teardown path clears again. Deleting either alone left the suite green — MISSED — and
     the obvious reading of that verdict ("the assertion is weak") was wrong twice over:

       1. the assertion WAS weak, separately. It was two unordered `some()` calls, so a
          speaking=False pushed BEFORE the reply satisfied the "and then cleared" half. That is
          fixed in the suite now: it looks for a clear at a later index than the last raise.
       2. with that fixed it still MISSED, because the other clear still fires.

     So the mutation removes both. Recorded because "MISSED" on a defence-in-depth property
     looks exactly like "MISSED" on a scaffolding test, and the two want opposite responses. */
  { suite: 'e2e-voice', file: SCOPED_AD, scope: 'gateway',
    why: 'clearing the speaking indicator when the reply finishes',
    breaks: 'speaking indicator was raised and then cleared',
    edits: [
      /* the timed clear, driven off the estimated speech duration */
      { file: SCOPED_AD,
        from: '        except asyncio.CancelledError:\n            pass\n'
            + '        self._push_status(speaking=False)',
        to:   '        except asyncio.CancelledError:\n            pass' },
      /* and the teardown clear, which covers for it */
      { file: SCOPED_AD,
        from: '        self._pending_speak = None\n        self._push_status(speaking=False)',
        to:   '        self._pending_speak = None' },
    ] },

  /* e2e-interrupt #2 — the LEDGER entry for a truncated reply, not the truncation itself
     (entry #1 stops the frames). `finish(note)` is the only record of whether a reply ran to
     completion; drop the note and the log line is byte-identical to a clean send, so a
     barge-in becomes invisible after the fact — which is the state this suite was written in
     response to. */
  { suite: 'e2e-interrupt', file: SC, restart: true,
    why: 'recording that a truncated reply was truncated',
    breaks: 'recorded the playback as CUT SHORT',
    from: "          return finish(`cut short after ${i}/${n} frames: `\n"
        + "            + (tok.cancelled ? 'superseded or interrupted' : 'peer gone (ICE drop/disconnect)'));",
    to:   '          return finish();' },

  /* e2e-voice-render #2 — the turn being SPOKEN AT ALL, where entry #1 covers its ordering.
     Two claims live in the render branch and they need different edits: removing the narration
     call leaves the turn's other speech in place, so only the ordering assertion moves. To
     reach "narrated at all" the whole speech path has to go.

     WHY THIS ENTRY EXISTS IN THIS SHAPE. The obvious second mutation — moving the narration
     ABOVE the render push — was written first and came back MISSED. _schedule_speak COALESCES:
     it accumulates text and synthesises once at the end of the turn, so calling it earlier
     changes nothing on the wire and the ordering assertion cannot see the difference. The call
     site's position is not what makes narration arrive after the render, and an entry pointed
     at it would have been testing a line that does not carry the property. */
  { suite: 'e2e-voice-render', file: SCOPED_AD, scope: 'gateway',
    why: 'the render turn producing any speech at all',
    breaks: 'a render-only reply was narrated at all',
    from: '        text = (text or "").strip()\n        if not text:\n            return',
    to:   '        return' },

  /* e2e-webrtc-pt111 #2 — the reason this variant exists at all. werift negotiates opus at 96;
     a real Android libwebrtc client sends 111. Any payload-type assumption on the INBOUND path
     is therefore invisible to e2e-webrtc and fatal on the handset: the phone's mic audio is
     dropped while ICE, DTLS and the control channel all read healthy. This mutation plants
     exactly that assumption, and it must be CAUGHT here and MISSED at 96 — the asymmetry is
     the coverage. */
  { suite: 'e2e-webrtc-pt111', file: WRTC, restart: true,
    why: 'accepting mic RTP at whatever payload type was negotiated, not a hardcoded one',
    breaks: 'transcribed the SRTP mic audio',
    from: '          if (this.handler.onUtterance) this.handler.onUtterance(pkt.payload);',
    to:   '          if (this.handler.onUtterance && pkt.header.payloadType === 96) this.handler.onUtterance(pkt.payload);' },

  /* port-in-use #2 — the ctl port is OPTIONAL and the ws port is not. Entry #1 proves the fatal
     side; this proves the degrading side, which is the one that regressed: a ctl EADDRINUSE
     used to take the whole sidecar down, so a stray second copy on 8124 killed the phone
     channel over a side channel nobody needs. */
  { suite: 'port-in-use', file: SC,
    why: 'surviving a ctl-port conflict instead of dying with it',
    breaks: 'ctl port in use: the sidecar KEEPS RUNNING',
    from: "    log(`ctl port ${CTL_PORT} in use — continuing WITHOUT the ctl channel `\n"
        + "      + `(another sidecar may be running; set AGENTMOB_SIDECAR_PORT to change it)`);",
    to:   '    process.exit(69);' },

  /* orphan-reap #2 — the SIDECAR's own half of the contract. Entry #1 mutates the spawn side
     (its process group); this is the watchdog that makes a SIGKILLed host survivable, where no
     signal is ever delivered and the only thing left to notice is the reparent to init. */
  { suite: 'orphan-reap', file: SC,
    why: 'the sidecar exiting when its parent is gone',
    breaks: 'SIGKILL of the host still frees the port',
    from: '    if (ppid === 1 || (startPpid !== 1 && ppid !== startPpid)) {',
    to:   '    if (false) {' },

  /* respawn-escalation #2 — the BACKOFF, not the escalation (entry #1). Pinned at the base
     delay the supervisor hammers a wedged sidecar every 3s for ever; the logs look supervised
     and the machine is not. */
  { suite: 'respawn-escalation', file: AD,
    why: 'backing off between respawns instead of retrying at a fixed interval',
    breaks: 'the delay BACKS OFF instead of pinning at the base',
    from: '                        delay = min(_RESPAWN_BASE_S * (2 ** (self._sidecar_fails - 1)),\n'
        + '                                    _RESPAWN_MAX_S)',
    to:   '                        delay = _RESPAWN_BASE_S' },

  /* bridge-recovery #2 — the LOOP, not the logging of the loss (entry #1). Return instead of
     going round again and the bridge dies silently on its first drop: the sidecar is up, the
     adapter is up, and nothing carries messages between them. */
  { suite: 'bridge-recovery', file: AD,
    why: 'reconnecting after the bridge drops',
    breaks: 'the adapter RECONNECTED on its own',
    from: '                logger.warning("agentmob: loopback bridge lost while the sidecar is running "\n'
        + '                               "— reconnecting")',
    to:   '                return' },

  /* inbound-resilience #2 — the escalation being ONCE, not the counting (entry #1). `==` is
     load-bearing: `>=` re-escalates on every subsequent event, and an ERROR per inbound message
     is how the log stops being read at all. */
  { suite: 'inbound-resilience', file: AD,
    why: 'escalating once rather than on every event after the threshold',
    breaks: 'it does not escalate once per event',
    from: '                if handler_errors == _INBOUND_ERROR_ESCALATE:',
    to:   '                if handler_errors >= _INBOUND_ERROR_ESCALATE:' },

  /* dispatch-delivery #2 — the PRE-delivery retry, where entry #1 covers the uncertain side.
     The whole point of the boundary is that the two sides behave differently; if the retry
     never happens, an utterance the agent provably never saw is dropped as if it might have
     been answered. */
  { suite: 'dispatch-delivery', file: AD,
    why: 'retrying an utterance that provably never reached the agent',
    breaks: 'pre-delivery: the utterance was RETRIED and delivered',
    from: '                    await self.dispatch_text(text, message_id, force=True)',
    to:   '                    pass' },

  /* transcribe-capture #2 — the DIRECTORY, not the retry loop (entry #1). This is the defect
     the suite was written for: unlinking the wav and leaving the mkdtemp directory behind, 14
     of which had piled up before anyone looked. */
  { suite: 'transcribe-capture', file: AD,
    why: 'removing the capture DIRECTORY, not just the wav inside it',
    breaks: 'the temp DIRECTORY is gone too',
    from: '                parent.rmdir()',
    to:   '                pass' },

  /* stt-failfast #2 — a MISSING capture, where entry #1 covers a broken backend. Both are
     permanent and neither is retryable, but they arrive as different exceptions: drop this
     branch and a vanished file burns the full retry budget re-reading a path that will not
     come back. */
  { suite: 'stt-failfast', file: AD,
    why: 'not retrying a capture file that is gone',
    breaks: 'missing capture: not retried',
    from: '                raise SttUnavailable(\n'
        + '                    f"the capture is missing ({e}); nothing to transcribe.") from e',
    to:   '                last = e' },

  /* tts-failfast #2 — REMEMBERING a dead engine, where entry #1 covers recognising one. The
     memory is what makes it fail fast on the NEXT reply; without it every reply re-discovers
     the same ImportError, loses a step of the fallback chain, and buries the real cause. */
  { suite: 'tts-failfast', file: AD,
    why: 'skipping an engine already proven unavailable',
    breaks: 'a known-dead engine is not tried on the next reply',
    from: '            if name in self._tts_dead:',
    to:   '            if False:' },

  /* outbound-queue #2 — the ORDER of the flush, not the decision to hold (entry #1). Replies
     delivered backwards are worse than delayed ones: the phone shows the answer before the
     question it answers. */
  { suite: 'outbound-queue', file: AD,
    why: 'flushing held messages in the order they were queued',
    breaks: 'flush: they arrive in order',
    from: '        for when, payload in held:',
    to:   '        for when, payload in reversed(held):' },

  /* adapter-fields #2 — deliberately a DIFFERENT field from entry #1, to prove the check scans
     rather than being pinned to one name.

     WHAT IT FOUND. It came back MISSED, and the reason was worse than a weak assertion: the two
     checks it should have failed were `REQUIRED <= REAL` and `REQUIRED == (REAL - OMIT)`, both
     true BY CONSTRUCTION, since REQUIRED is assigned `REAL - OMIT` one line above. Removing a
     field from the real constructor removes it from REAL and therefore from REQUIRED, and set
     algebra stays satisfied — `ok(true, ...)` wearing a disguise. They are replaced by a check
     that the constructor SCAN still finds the adapter's core state fields, which is the thing
     that would actually rot (REAL is parsed out of __init__ by pattern). */
  { suite: 'adapter-fields', file: AD,
    why: 'deriving the required fields from the constructor, for every field',
    breaks: "the constructor scan found the adapter's core state fields",
    from: '        self._outbound_q = _new_outbound_queue()',
    to:   '        pass' },

  /* flush-live #2 — the flush being CALLED on reconnect, where entry #1 covers the queueing
     decision. Held and never delivered is the same outcome as dropped, and it is the harder
     failure to see: the queue log says the reply was kept. */
  { suite: 'flush-live', file: AD,
    why: 'flushing the held queue when the bridge comes back',
    breaks: 'REACHED the new sidecar after reconnect',
    from: '                self._flush_outbound()',
    to:   '                pass' },

  /* aead-trigger #2 — the LIVE turn, where entry #1 only checks device-verify still imports
     this helper. Send nothing and the trigger reports ok with no turn behind it, which is the
     exact shape the old `adb shell input text` trigger had: a green step that moved no audio. */
  { suite: 'aead-trigger', file: AEADTRIG,
    why: 'actually sending the typed turn over the AEAD channel',
    breaks: 'the sidecar logged the reply audio',
    from: '    s.cmd(String(text)).catch(() => {});',
    to:   '    /* no turn sent */' },

  /* adb-isolation #2 — the PORT, where entry #1 covers the flag. The isolation is only as good
     as the number: point it back at 5037 and every `-P` in the file is still there, still
     correct, and still talking to the operator's own adb server. That is the regression this
     suite exists to prevent, and it is invisible to a flag-shaped check. */
  { suite: 'adb-isolation', file: DV,
    why: 'the isolated adb server being a DIFFERENT server, not just a flag',
    breaks: 'the isolated run reported NO device of any state',
    from: "const ADB_PORT = Number(flag('--adb-port', process.env.AGENTMOB_ADB_PORT || 5039));",
    to:   'const ADB_PORT = 5037;' },

  /* containment #2 — the TRUST BOUNDARY, where entry #1 covers egress. The webview is agent-
     controlled content; a padlock or a "PINNED" drawn inside it is drawn by the thing it claims
     to vouch for. The real badge is the native overlay. This plants exactly the forgery the
     rule forbids, in the header, where it would look most convincing. */
  { suite: 'containment', file: INDEX,
    why: 'keeping every trust claim out of agent-controlled markup',
    breaks: 'NO trust claim',
    from: '  <header id="badge" title="tap to change theme">agent terminal<i class="cursor"></i>',
    to:   '  <header id="badge" title="tap to change theme">agent terminal ✓ PINNED<i class="cursor"></i>' },

  /* device-watch-test #2 — capturing the identity and NOTHING ELSE, where entry #1 covers
     classifying the session. The pairing line is `identity=<key> — add to AGENTMOB_ALLOWED_
     CLIENTS to pin`, and the operator pins whatever this captures; capture the prose too and
     the pinned string never matches, which locks the phone out of its own gateway.

     WHAT THIS ENTRY FOUND ON THE WAY. It was first pointed at the `.replace(/\s*—.*$/, '')`
     that looks like the thing doing the stripping, and came back MISSED — because that replace
     is DEAD CODE. The capture is `(\S+)`, which stops at the space before the em dash, so
     there has never been anything for it to strip. The guarantee lives in the character class,
     and a line that reads as the guarantee while doing nothing is worse than no line at all.
     The replace is gone; the entry now points at what actually carries the property. */
  { suite: 'device-watch-test', file: DWATCH,
    why: 'capturing the identity alone, not the prose after it',
    breaks: 'the trailing prose is stripped off the identity',
    from: '  [/\\[sidecar\\] PAIRING: client (\\S+) identity=(\\S+)/, (m) => {',
    to:   '  [/\\[sidecar\\] PAIRING: client (\\S+) identity=(.+)/, (m) => {' },

  /* ice-tailnet #2 — the SUBTLE version of entry #1. That one removes tailnet ICE entirely;
     this narrows the CGNAT range by one octet, which is the shape a real edit produces and the
     shape a green suite would happily carry. 100.64.0.0/10 runs to 100.127, and this host sits
     at 100.125 — an off-by-one here and a remote phone has no routable pair at all. */
  { suite: 'ice-tailnet', file: SC, restart: true,
    why: 'the full CGNAT range Tailscale allocates from, not part of it',
    breaks: 'ICE reached connected over the tailnet address alone',
    from: '        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) out.push(a.address);',
    to:   '        if (o[0] === 100 && o[1] >= 64 && o[1] <= 100) out.push(a.address);' },

  /* identity-pin #2 — the REASON, where entry #1 covers the gate. A rejection that reads as a
     generic failure is indistinguishable from a crypto fault or the gateway being down, and the
     first thing anyone does with one of those is start disabling things.

     POINTED AT proto.js, NOT THE SIDECAR LOG. The first version of this entry changed the
     sidecar's `REJECT unknown client ...` log line and came back MISSED, correctly: the suite
     asserts on `rejected.error`, the reason that crosses the WIRE to the phone, which is the
     only one a handset can act on. The log line is for whoever is reading the host. Two
     different audiences, and only one of them is what the claim is about. */
  { suite: 'identity-pin', file: PROTO, scope: 'gateway',
    why: 'the refusal reason that reaches the phone naming the allowlist',
    breaks: 'names unknown_client',
    from: "  if (allow && !allow(clientIdentity, clientId)) throw new Error('unknown_client');",
    to:   "  if (allow && !allow(clientIdentity, clientId)) throw new Error('handshake_failed');" },

  /* mute-webrtc #2 — barge-in opened from the SILENCE path, where entry #1 lowers the RMS
     threshold. Same defect (issue #1: a muted mic cutting the agent off mid-reply) reached by a
     different route, and the route matters: a suite that only watches the threshold would pass a
     rewrite that counts quiet frames instead. */
  { suite: 'mute-webrtc', file: SCOPED_SC, scope: 'gateway',
    why: 'silence never opening an utterance, by any counter',
    breaks: 'recorded NO truncation',
    from: '  } else {\n    conn.speechStreak = 0;',
    to:   '  } else {\n    if ((conn.speechStreak = (conn.speechStreak || 0) + 1) >= MIN_SPEECH_FRAMES) '
        + '{ maybeBargeIn(conn); conn.speechStreak = 0; }' },

  /* plugin-drift #2 — what must NEVER be vendored, where entry #1 covers what must match. The
     sidecar's .identity.json holds the PRIVATE key the phone pins; vendoring it commits the
     server's identity to a repo. The forbidden list is the only thing standing between a
     refresh and that commit.

     WHAT IT FOUND. It came back MISSED: deleting the private-key pattern from FORBIDDEN changed
     nothing, because nothing asked the classifier about a file it should refuse. The manifest
     loop iterates files that have never included a secret, and the `existsSync` check is about
     a file that has never been written — both pass trivially either way. A guard nothing tests,
     standing in front of a private key. The suite now puts the question to isForbidden
     directly, in both directions, and this entry names that positive control. */
  { suite: 'plugin-drift', file: VF,
    why: 'refusing to vendor the sidecar identity keypair',
    breaks: 'isForbidden REFUSES the identity keypair',
    from: 'export const FORBIDDEN = [/(^|\\/)\\.identity\\.json$/, /(^|\\/)node_modules(\\/|$)/, /\\.env$/];',
    to:   'export const FORBIDDEN = [/(^|\\/)node_modules(\\/|$)/, /\\.env$/];' },

  /* plugin-drift-soundness #2 — the PYTHON branch, where entry #1 exercises the JS one. They are
     separate implementations (node --check vs py_compile under the gateway's own interpreter),
     so proving one works says nothing about the other — and adapter.py is the larger half of
     what a restore-from-vendored would reinstall. */
  { suite: 'plugin-drift-soundness', file: VF,
    why: 'the python half of the syntax check being a real check',
    breaks: 'py: broken module fails',
    from: "    try { await run(py, ['-m', 'py_compile', absPath]); return { ok: true, error: null }; }\n"
        + '    catch (e) { return { ok: false, error: firstLine(e.stderr || e.message) }; }',
    to:   '    return { ok: true, error: null };' },

  /* surface-assets #2 — GIVING BYTES BACK, where entry #1 covers freeing them on replacement.
     The cap itself already has an entry under surface-core, and duplicating it here would be a
     second tick for the same edit. Unregister is the other half of the accounting and the one
     with no natural pressure to be right: nothing visibly breaks when freed bytes are not
     returned, the surface just fills up over a long session and stops accepting assets. */
  { suite: 'surface-assets', file: SCORE,
    why: 'returning an unregistered asset’s bytes to the cap',
    breaks: 'unregister_asset removes a complete asset and frees its bytes',
    from: '          if (assets[name]) { freed += assets[name].size || 0; delete assets[name]; }',
    to:   '          if (assets[name]) { delete assets[name]; }' },

  /* surface-chunks #2 — the EMPTY payload, where entry #1 covers sequence order. A zero-byte
     register_asset used to be accepted silently, which registers a name with no source behind
     it: every widget type that depends on it then fails to mount for a reason nothing reports. */
  { suite: 'surface-chunks', file: SCORE,
    why: 'reporting a register_asset with no payload',
    breaks: 'register_asset without b64 is reported',
    from: '          if (!bytes) { abort(`register_asset ${name}: empty payload (b64 missing)`); break; }',
    to:   '          if (false) { abort(`register_asset ${name}: empty payload (b64 missing)`); break; }' },

  /* surface-integration #2 — publish reaching a LIVE widget, where entry #1 covers registering a
     type. This is the in-place data path the whole surface exists for: the tile stays mounted
     and its data changes. Break it and every chart on the phone freezes at its first value
     while the agent believes it is streaming. */
  { suite: 'surface-integration', file: SCORE,
    why: 'delivering published data to a mounted widget',
    breaks: 'publish -> data',
    from: "          emit({ event: 'data', key: op.key, data: op.data });",
    to:   '          break;' },

  /* surface-protocol #2 — the UNKNOWN-KEY report, where entry #1 covers a type becoming ready.
     This is the defect the suite was written for: an op against a key that was never added used
     to vanish, so the agent believed it had rendered while the screen stayed blank, and the
     register -> test -> build feedback loop never fired. */
  { suite: 'surface-protocol', file: SCORE,
    why: 'telling the agent that a publish went to a key that does not exist',
    breaks: 'publish to unknown key reports ok:false',
    from: "          if (!widgets[op.key]) { emit({ event: 'render_result', ok: false, key: op.key,\n"
        + '            error: `publish: no widget with key "${op.key}" (add_widget first)` }); break; }',
    to:   '          if (!widgets[op.key]) { break; }' },

  /* ux-audit #2 — an ACCESSIBILITY regression, where entry #1 covers a blank render. Disabling
     pinch-zoom is one attribute, passes every functional test, and is exactly the kind of thing
     that gets added to stop a layout wobbling. On a voice-first surface the people most likely
     to need the zoom are the ones least likely to file a bug about it. */
  { suite: 'ux-audit', file: INDEX,
    why: 'the audit noticing an accessibility regression, not only a blank page',
    breaks: 'unexpected page error(s)',
    from: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    to:   '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">' },

  /* webrtc-pt #2 — the sidecar not REWRITING the offered payload type, where entry #1 covers it
     answering at all. werift negotiates opus at 96 and a real Android client offers 111, so the
     tempting "fix" is to normalise the offer on the way in. Do that and the answer echoes a
     number the phone never proposed: it decodes nothing and every state still reads healthy. */
  { suite: 'webrtc-pt', file: WRTC, restart: true,
    why: 'answering at the payload type the client offered, unmodified',
    breaks: 'the answer echoes the offered payload type',
    from: "      await this.pc.setRemoteDescription({ type: 'offer', sdp });",
    to:   "      await this.pc.setRemoteDescription({ type: 'offer', sdp: String(sdp).replace(/\\b111\\b/g, '96') });" },

  /* ice-tailnet #3 — the last step of the tailnet-ICE PIPELINE: gather the address (#1), accept
     the whole CGNAT range (#2), then hand the list to werift. This breaks the handing-over while
     leaving the other two intact, so the three together say the path fails if ANY step does.

     IT NAMES THE SAME CLAIM AS #1, DELIBERATELY, AND THAT IS THE FINDING. It was first written
     against "the nominated pair's REMOTE candidate is the tailnet address" and came back
     WRONG-CLAIM: the failures were the gathering ones instead. That is not a mis-aimed mutation,
     it is a property of the suite. ice-tailnet FILTERS the answer down to candidates containing
     the tailnet address before applying it, so no other pair can form — and the nominated-pair
     assertion sits inside `if (connected)`. Break the advertising and nothing connects, so that
     assertion never runs; leave the advertising alone and the only pair that CAN be nominated is
     the tailnet one. There is no sidecar edit that produces "connected, over something else".

     So the nominated-pair assertion is not independently falsifiable here, and it is not
     pretending to be: it is a regression guard on the ACCESSOR, which is the thing that was
     actually broken (`nominated?.[0]` on an object). It fails if werift stops exposing the pair
     or the path changes shape. That is recorded next to the assertion too, so nobody reads a
     green tick there as mutation-covered. */
  { suite: 'ice-tailnet', file: SC, restart: true,
    why: 'advertising the gathered tailnet address to the peer',
    breaks: 'the answer contains a tailnet candidate',
    from: '        iceAdditionalHostAddresses: ICE_HOST_ADDRS.length ? ICE_HOST_ADDRS : undefined }',
    to:   '        iceAdditionalHostAddresses: undefined }' },

  /* ice-path #1 — the TOP of the CGNAT range. 100.64.0.0/10 ends at 100.127, and this host sits
     at 100.125: stop the range one short of 126 and real tailnet traffic is reported as a LAN
     run, so the device stage says "not exercised" for the exact case it was built to confirm.
     The boundary is the entire content of the predicate, which is why it is what gets mutated. */
  { suite: 'ice-path', file: ICEPATH,
    why: 'the CGNAT range reaching 100.127, not stopping short of this host',
    breaks: 'is tailnet (the last)',
    from: '  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;',
    to:   '  return o[0] === 100 && o[1] >= 64 && o[1] <= 124;' },

  /* ice-path #2 — UNKNOWN is not LAN. A pair that was never logged and a pair that was logged
     as a LAN address are different answers: one is a measurement, the other is its absence.
     Collapse them and device-verify reports "ICE connected, but over the LAN" for a run where
     ICE state was never observed at all — a verdict nobody took, which is the failure this
     whole project keeps finding in its own tooling. */
  { suite: 'ice-path', file: ICEPATH,
    why: 'telling "no pair was observed" apart from "the pair was a LAN one"',
    breaks: 'nothing logged is unknown, not lan',
    from: "  if (!raw) return { via: 'unknown', host: null, note: 'no nominated pair was logged' };",
    to:   "  if (!raw) return { via: 'lan', host: null, note: 'no nominated pair was logged' };" },

  /* ice-path #3 — the two halves of the device stage still agreeing. The sidecar WRITES the
     pair line and device-verify READS it with a regex; neither half runs without a handset, so
     a rename on either side would surface as "ICE path: blocked" during the ten minutes someone
     is standing over the phone — and blocked is exactly what the honest no-pair case looks
     like. This renames the writer's half. */
  { suite: 'ice-path', file: SC, restart: true,
    why: 'the sidecar still writing the line device-verify reads',
    breaks: 'the sidecar still WRITES that line',
    from: '            log(np ? `webrtc ICE pair remote=${np.remote} local=${np.local || \'n/a\'}`',
    to:   '            log(np ? `webrtc selected ${np.remote} <- ${np.local || \'n/a\'}`' },

  /* adb-discover #3 — REFUSED vs TIMEOUT, the distinction this whole device track turned on.
     A refusal means the host answered and nothing is bound: the phone is up and adbd is off, so
     the next move is a toggle. A timeout means nothing answered and proves nothing at all.
     Conflate them and every diagnosis becomes "maybe the network" — which is how a watcher
     polled for 3.4 hours printing a generic line while the LAN was answering ECONNREFUSED the
     entire time. */
  { suite: 'adb-discover', file: ADIS,
    why: 'a refusal and a timeout being different answers',
    breaks: 'refused and timeout are not conflated',
    from: "  if (/refused/i.test(t)) return 'refused';",
    to:   "  if (/refused/i.test(t)) return 'timeout';" },

  /* adb-discover #4 — the IPv6 split. An address is cut at the LAST colon because an IPv6 host
     carries its own; cut at the first and `[fd7a::1]:41641` becomes host `[fd7a` with a port
     that does not parse, so a tailnet-only phone is invisible to discovery while the mDNS
     record it needs is sitting right there. */
  { suite: 'adb-discover', file: ADIS,
    why: 'splitting host from port at the LAST colon, so IPv6 survives',
    breaks: 'an IPv6 address is not mangled',
    from: "    const cut = addr.lastIndexOf(':');",
    to:   "    const cut = addr.indexOf(':');" },

  /* adb-discover #5 — SKIPPED is not EMPTY, the same defect class as an assertion that cannot
     fail. device-verify sweeps on a slower cadence than it polls mDNS, so most passes send no
     packet; report those as "nothing open" and the log fills with a measurement nobody took,
     which is exactly the shape that let a blind watcher look busy. */
  { suite: 'adb-discover', file: ADIS,
    why: 'a pass that swept nothing reporting nothing, not emptiness',
    breaks: 'a measurement nobody took',
    /* Aimed at the LOG, not the branch. Removing the branch made the suite throw on `null.length`
       instead of asserting false, so the harness reported a failure with "(none named)" — caught
       by a stack trace, which is not the same as caught by a claim. This says the untrue thing
       instead of crashing, which is what the real regression would look like. */
    from: "      log(`sweep of ${h} skipped this pass (slower cadence — mDNS is still being polled)`);",
    to:   '      log(`nothing open on ${h}`);' },

  /* adb-discover #6 — keeping the PAIRING record out. Android advertises both; adb connects to
     only one, and reaching for the pairing port fails in a way that reads like the phone
     refusing this host rather than the wrong record having been picked.

     TWO LAYERS, AND THE CLAIM NAMES THE ONE THIS EDIT REACHES. "The connect service is chosen,
     not the pairing one" is guaranteed twice over: the filter drops the pairing record, and the
     comparator would demote it even if it survived. So no single edit falsifies that sentence —
     loosening the filter alone still yields connect first, which is why this came back
     WRONG-CLAIM rather than CAUGHT.

     Rather than a two-edit entry that deletes the whole defence at once, the suite now asserts
     each layer separately and each entry names its own: this one, that pairing never enters the
     list at all; #7, that the comparator ranks TLS-connect above the plain _adb._tcp it would
     actually be compared against. Getting here took two wrong aims — the comparator with the
     fixture listing connect first (a stable sort proves nothing), then the same with it
     reversed — both MISSED, and both worth recording because the obvious reading of a MISSED is
     "weak assertion" when it can equally mean "you found the second guarantee". */
  { suite: 'adb-discover', file: ADIS,
    why: 'the pairing record never reaching the endpoint list',
    breaks: 'filtered out entirely, not merely outranked',
    from: "  const usable = services.filter((s) => /_adb(-tls-connect)?\\._tcp/.test(s.type));",
    to:   "  const usable = services.filter((s) => /_adb/.test(s.type));" },

  /* adb-discover #7 — and the tie-break itself, on the comparison it really makes: the TLS
     record against the plain _adb._tcp that `adb tcpip` would create. Both pass the filter, so
     this is the one place the sort order decides the outcome. */
  { suite: 'adb-discover', file: ADIS,
    why: 'ranking the TLS-connect record above the plain one',
    breaks: 'the TLS-connect record outranks the plain one',
    from: "  scored.sort((a, b) => a.score - b.score\n"
        + "    || (/_adb-tls-connect/.test(b.type) ? 1 : 0) - (/_adb-tls-connect/.test(a.type) ? 1 : 0));",
    to:   '  scored.sort((a, b) => a.score - b.score);' },

  /* outbound-queue #3 — classifying on the INNER envelope. _push_status sends
     {"type":"push","d":{"type":"status"}}, so reading the outer type alone queues stale status
     indicators for replay after a reconnect — a blinking light from thirty seconds ago,
     reported as current. The outer type is a transport frame; the inner one says what the
     message IS, and the whole selectivity of this queue rests on the difference. */
  { suite: 'outbound-queue', file: AD,
    why: 'reading the message kind from the inner envelope, not the transport frame',
    breaks: "a status push is NOT queued despite its outer type being 'push'",
    from: '    if inner in _OUTBOUND_EPHEMERAL_INNER:\n        return inner\n    return outer',
    to:   '    return outer' },

  /* outbound-queue #4 — the AGE limit. A reply held past it is not delivered late, it is
     confessed: send() already told the agent the message was on its way, so a queue that
     eventually flushes a minute-old answer makes the phone contradict the conversation. */
  { suite: 'outbound-queue', file: AD,
    why: 'refusing to deliver a message that waited past the age limit',
    breaks: 'a message older than the limit is NOT delivered',
    from: '            if now - when > _OUTBOUND_MAX_AGE_S:',
    to:   '            if False:' },

  /* outbound-queue #5 — the queue being BOUNDED. maxlen is what stops an outage turning into
     unbounded growth on a phone with no swap, and a deque's maxlen also decides WHICH end is
     discarded: the newest are worth keeping, because the oldest have already aged past the
     limit above.

     IT TOOK THREE COPIES TO FIND. The cap was written out in the constructor AND in
     _flush_outbound, which replaces the deque wholesale — so removing one left the other. The
     two-edit version then STILL came back MISSED, because the suite's own make_adapter() built
     a third capped deque by hand, and the assertion was measuring the fixture. There is one
     copy now, `_new_outbound_queue()`, called by both sites and by the test, so a single edit
     falsifies it. Deduplicating was the fix; the entry is what made the duplication visible. */
  { suite: 'outbound-queue', file: AD,
    why: 'the held queue having a cap at all',
    breaks: 'the queue never exceeds its cap',
    from: '    return collections.deque(maxlen=_OUTBOUND_QUEUE_MAX)',
    to:   '    return collections.deque()' },

  /* respawn-escalation #3 — the ESCALATION firing once and then only periodically. `first or
     fails % EVERY == 0` is two decisions in one line: say it at all, and do not say it every
     attempt. An ERROR every few seconds is how a log stops being read, which is the same
     outcome as silence and harder to argue with. */
  { suite: 'respawn-escalation', file: AD,
    why: 'escalating once, then periodically — not on every failed start',
    breaks: 'it does NOT spam an ERROR on every single attempt',
    from: '                            if first or self._sidecar_fails % _RESPAWN_ESCALATE_EVERY == 0:',
    to:   '                            if True:' },

  /* respawn-escalation #4 — the escalation carrying the sidecar's OWN last output. Without it
     the alarm says the phone cannot connect but not why, and the stderr that would have named
     the cause — a bad port, a missing module, a syntax error from a half-finished edit — has
     already scrolled past in a stream nobody was watching. WHY, not just THAT. */
  { suite: 'respawn-escalation', file: AD,
    why: 'the wedge alarm quoting the sidecar’s last output',
    breaks: "the sidecar's own last output",
    /* TWO EDITS: there are two alarms — WEDGED and FLAPPING — and both quote the same stderr.
       A fast-failing sidecar trips both, so blanking one alarm's tail left the other still
       carrying the canary text and the entry came back MISSED. Two alarms sharing a diagnostic
       is right; a mutation that removes only one of them is not a test of it. */
    edits: [
      { file: AD,
        from: '                                tail = " | ".join(self._sidecar_stderr) or "(no stderr captured)"',
        to:   '                                tail = "(no stderr captured)"' },
      { file: AD,
        from: '                            tail = " | ".join(self._sidecar_stderr) or "(no stderr captured)"',
        to:   '                            tail = "(no stderr captured)"' },
    ] },

  /* respawn-escalation #5 — healthy uptime CLEARING the counter. A sidecar that ran for hours
     and then died is an ordinary restart, not a wedge; without the reset the failure count
     accumulates across unrelated incidents until a perfectly healthy machine raises an alarm
     that says the phone cannot connect. A false wedge is worse than none: it is the alarm that
     teaches people the alarm is wrong. */
  { suite: 'respawn-escalation', file: AD,
    why: 'a long healthy run clearing the consecutive-failure count',
    breaks: 'a healthy run CLEARS the consecutive-failure count',
    from: '                        self._sidecar_fails = 0\n                        self._sidecar_wedged = False',
    to:   '                        self._sidecar_wedged = False' },

  /* android-lint #3 — the PARSER, which until tonight had no claim on it that could fail. The
     assertion read `issues.length >= 0 && xml.includes('<issues')`: a length is never negative,
     so the whole thing reduced to "the file contains that string" and the regex could have
     matched nothing at all. A gate that reports zero violations because it stopped parsing is
     indistinguishable from a clean build, which is the worst shape a gate can take.

     The first version of this entry pointed at the suite's own file, and the self-edit gate
     refused it — correctly, and the justification I had written for the exception was a
     rationalisation. The parser moved to test/lib/lint-report.mjs instead, where it is ordinary
     code: breaking the <issue> pattern makes the parse come back empty while the document still
     looks like a report, which is exactly the silent-blindness case, and the suite now carries
     fixtures whose answers are known — including an EMPTY report, so a clean build can never
     read the same as a broken parser. */
  { suite: 'android-lint', file: LINTRPT,
    why: 'the issue parser still extracting records from the report',
    breaks: 'every <issue> in the report parsed into a record with an id',
    from: "  return [...String(xml || '').matchAll(/<issue\\s+([^>]*?)>/gs)].map((m) => {",
    to:   "  return [...String(xml || '').matchAll(/<issueXX\\s+([^>]*?)>/gs)].map((m) => {" },

  /* respawn-escalation #6 — the FLAP report being periodic, the twin of #3's wedge report.
     Both alarms answer the same question ("is this still happening?") and both have to answer
     it without filling the log; #3 covers one, this covers the other. The class sweep found the
     assertion behind this one written as `len(errors) < len(restarts)`, which escalating on all
     but one restart still satisfies — the second copy of a shape I had already fixed once. */
  { suite: 'respawn-escalation', file: AD,
    why: 'reporting a flap periodically rather than on every restart',
    breaks: 'does not spam an ERROR per restart',
    from: '                        if first or self._flap_reports % _RESPAWN_ESCALATE_EVERY == 0:',
    to:   '                        if True:' },

  /* device-probe #1 — the MUTE READING, which is the evidence for issue #1 and so the most
     expensive wrong answer in the device run. It used to be `/true/i` over three grepped lines:
     any neighbouring field containing the word made the mic read as muted, verifying the claim
     without measuring it. This makes the field match loose again in the same way. */
  { suite: 'device-probe', file: DPROBE,
    why: 'reading the mic-mute FIELD rather than the word true anywhere near it',
    breaks: 'a neighbouring "true" does not make it muted',
    /* The mutation has to be the ORIGINAL defect, not a near miss. A first attempt loosened
       the field match to `mMicMute[\s\S]*?(true|false)` and came back MISSED — non-greedy, so
       it still found the field's own value first. What the old code did was scan for the word
       anywhere, so that is what this plants. */
    from: '    /\\bmMicMute\\s*[:=]\\s*(true|false)\\b/i,',
    to:   '    /(true)\\b/i,' },

  /* device-probe #2 — SAID NOTHING is not SAID NO. A probe that returns false when the device
     reported no mic-mute field at all turns "this Android version spells it differently" into
     "the mute failed", and the two want opposite responses: rewrite the probe, or file the bug. */
  { suite: 'device-probe', file: DPROBE,
    why: 'distinguishing a device that said nothing from one that said no',
    breaks: 'nothing reported is NULL, not false',
    from: '  return null;\n}\n\n/** `dumpsys package <pkg>` → versionName, or null. */',
    to:   '  return false;\n}\n\n/** `dumpsys package <pkg>` → versionName, or null. */' },

  /* device-probe #3 — the TAP LANDING ON THE BUTTON. The mic sits gap + half a button above the
     nav inset; drop the inset and on a 3-button-nav phone the tap lands on the navigation bar
     instead. Nothing is pressed, nothing is reported, and the mute stage then says the mic is
     not muted — which reads as issue #1 reproducing when in fact the run never touched it. */
  { suite: 'device-probe', file: DPROBE,
    why: 'the mic tap accounting for the navigation-bar inset',
    breaks: 'a bigger nav bar moves the tap UP',
    from: '    y: Math.round(h - (navPx + (micGapDp + micSizeDp / 2) * dens)),',
    to:   '    y: Math.round(h - ((micGapDp + micSizeDp / 2) * dens)),' },

  /* font-stack #1 — the GENERIC TAIL. A list whose named families are all absent on a platform
     resolves to nothing, and the engine then falls back to its own default: a different answer
     on every device, and the one outcome nothing here could predict. The check has to notice a
     list that simply stops. */
  { suite: 'font-stack', file: FSTACK,
    why: 'noticing a font list with no generic to fall back to',
    breaks: 'control: a stack with no generic tail is REJECTED',
    from: '  return f.length > 0 && GENERICS.has(f[f.length - 1]);',
    to:   '  return f.length > 0;' },

  /* font-stack #2 — the PLATFORM TABLE being a table of facts, not a table of yeses. If every
     family reads as available everywhere, the divergence check can never fire and the whole
     suite becomes a green tick over an unexamined stack — which is what it was standing in for
     in the first place. */
  { suite: 'font-stack', file: FSTACK,
    why: 'knowing which platforms actually ship a named family',
    breaks: 'control: an Apple-only stack resolves to NOTHING on Android',
    from: "    if (where && where.includes(platform)) return f;",
    to:   '    if (where) return f;' },

  /* font-stack #3 — reading the stacks out of the stylesheet at all. A parser that returns
     nothing makes every per-stack assertion vacuous by having no stacks to loop over, which is
     why the suite also asserts that both --sans and --mono were found. */
  { suite: 'font-stack', file: FSTACK,
    why: 'finding the font custom properties in the stylesheet',
    breaks: 'both a sans and a mono stack are declared',
    from: "    if (!familiesOf(value).some((f) => GENERICS.has(f))) continue;",
    to:   '    continue;' },

  /* device-probe #4 — ATTRIBUTING a crash to our package. A real handset has other apps dying
     in the background all the time; fail the launch on those and the run is unusable within a
     week, which is the same end state as not checking at all. The attribution is the whole
     difference between a signal and a nuisance. */
  { suite: 'device-probe', file: DPROBE,
    why: 'only counting a crash that names the package under test',
    breaks: 'ANOTHER app crashing is not our failure',
    from: '    if (!window.includes(name)) continue;',
    to:   '    if (false) continue;' },

  /* device-probe #5 — a crash being found AT ALL. Without it the launch stage is `pidof`, which
     an app crash-looping in onCreate satisfies: Android restarts it, a pid exists, and the run
     reports the app launched over a crash it never mentioned. */
  { suite: 'device-probe', file: DPROBE,
    why: 'noticing a fatal exception in the launch log',
    breaks: 'a FATAL EXCEPTION for our package is found',
    from: "    if (!/\\bFATAL EXCEPTION\\b/.test(lines[i])) continue;",
    to:   '    continue;' },

  /* apk-installable #3 — EXPORTED, the last blind spot in the launch stage. An activity that is
     present but not exported installs perfectly and refuses `am start` with a SecurityException:
     the start fails, so the app never runs, nothing of ours reaches logcat, and the crash
     attribution added alongside this cannot help — there is no crash, because there was no
     process. Accepting any value for the attribute is the regression. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'refusing a launcher that is present but not exported',
    breaks: 'control: exported=false is REFUSED',
    from: '  if (byName.exported !== true) {',
    to:   '  if (false) {' },

  /* apk-installable #4 — reading the attribute at all. The namespace on an aapt2 attribute is a
     URL, so the name follows the LAST colon; a pattern that stops at the first one matches
     nothing and every activity comes back with null fields, which reads as "not exported" for a
     correct manifest and as nothing at all for a broken one. This entry exists because that is
     exactly what the first version of this parser did. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'parsing namespaced manifest attributes',
    breaks: 'the shipped manifest was parsed into activities',
    from: "    const attr = /^A: (?:.*:)?([\\w-]+)\\(0x[0-9a-fA-F]+\\)=(.*)$/.exec(t)\n"
        + "              || /^A: (?:.*:)?([\\w-]+)=(.*)$/.exec(t);",
    to:   "    const attr = /^A: [^:]*:([\\w-]+)\\([^)]*\\)=(.*)$/.exec(t);" },

  /* apk-installable #5 — telling a REFUSAL apart from an ordinary start. If every am start reads
     as refused the launch stage fails on a healthy app, which gets the check deleted within a
     week; if none does, the refusal falls through to "no process" and we are back where we
     started. Both directions are asserted, so this breaks the useful one. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'recognising the not-exported refusal in am start output',
    breaks: 'a not-exported SecurityException is recognised',
    from: "  if (/SecurityException[^\\n]*not exported/i.test(t)\n"
        + "      || /Permission Denial[^\\n]*not exported/i.test(t)) {",
    to:   '  if (false) {' },

  /* apk-installable #6 — the SIGNER MISMATCH keeping its own verdict. Every other install
     failure here is annoying; this one has an obvious next step that destroys something
     irreplaceable. `-r` cannot replace across certificates, the documented fix is `adb
     uninstall`, and app-private storage holds the IdentityStore keypair the sidecar's allowlist
     pins — so the fix rotates the phone's identity and the gateway then refuses it as an unknown
     client. Fold this case in with the rest and the run prints a generic line over the one error
     where the obvious move is the wrong one. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'the signer mismatch getting a verdict of its own',
    breaks: 'a signer mismatch is recognised',
    from: '  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_SHARED_USER_INCOMPATIBLE|signatures do not match/i.test(t)) {',
    to:   '  if (false) {' },

  /* apk-installable #7 — and the verdict being ACTIONABLE rather than merely alarming. The flag
     is what device-verify raises its second stage from; a warning only a human can parse cannot
     drive anything, and the stage that says DO NOT UNINSTALL in the report would silently stop
     appearing. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'flagging the destructive-fix case for the caller, not just in prose',
    breaks: 'it is flagged for the caller, not only for a human reader',
    from: "      doNotUninstall: true,",
    to:   '      doNotUninstall: false,' },

  /* apk-installable #8 — an UNRECOGNISED failure saying so. Guessing at an unknown error is how
     a run tells someone not to uninstall over a full disk, or stays quiet about one it has
     never seen; and dropping the raw text while calling it unknown is worse than dumping
     stderr, which at least carried the evidence. */
  { suite: 'apk-installable', file: MFACTS,
    why: 'reporting an unrecognised install error as unrecognised, with its text',
    breaks: 'an unrecognised error is reported as unrecognised',
    from: "  return { code: 'UNKNOWN', doNotUninstall: false,",
    to:   "  return { code: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE', doNotUninstall: true," },

  /* adb-state #3 — the two network verdicts staying NON-INTERCHANGEABLE. "They differ" was all
     that was asserted, and a helper emitting both phrases in both branches satisfies that: the
     result tells someone to flip a toggle on a phone that is asleep, or to go and wake a phone
     that is sitting there with the toggle off. The advice is the payload, so each line must
     carry only its own. This gives the unreachable case the toggle advice as well. */
  { suite: 'adb-state', file: AS,
    why: 'the off-tailnet verdict not offering the toggle-off advice',
    breaks: 'does NOT tell you to flip the toggle',
    from: "        + `tailnet — adb cannot reach it until Tailscale on the phone is up again.`;",
    to:   "        + `tailnet — turn on Settings > System > Developer options > Wireless debugging. `\n"
        + "        + `That is the ONLY step needed.`;" },

  /* adb-state #4 — the CONNECT ERROR surviving into the verdict. Refused and timed out are the
     whole diagnostic: refused means the phone answered and adbd is not running, a timeout means
     nothing answered and proves nothing at all. Drop it and both read as "nothing is listening",
     which is the sentence that cost three and a half hours of polling. */
  { suite: 'adb-state', file: AS,
    why: 'the verdict carrying what the connect attempt actually said',
    breaks: 'carries the CONNECT ERROR verbatim',
    from: "        + (connectError ? ` (${connectError})` : '')",
    to:   "        + ''" },

  /* adb-discover #8 — the SUCCESS verdict distinguishing HOW the endpoint was found. mDNS means
     the phone answered a link-local query, so it is on this LAN; a sweep means the port came out
     of an ephemeral range and the phone may be anywhere on the tailnet. The two have different
     implications for the tailnet claim the ICE stage makes later, and collapsing them loses
     that at exactly the moment someone is reading the first line of a device run. */
  { suite: 'adb-discover', file: ADIS,
    why: 'the discovery verdict naming mDNS when that is how it was found',
    /* Note what this actually does: the ternary is a chain, so replacing the first test with
       `false` does not collapse the whole thing — mDNS falls through to the unknown-method
       branch and comes out as the bare word "mdns", while a sweep is unaffected. The two still
       differ, so it is the mDNS clause specifically that breaks. Named for what it does rather
       than for what I first assumed, which is how it came back WRONG-CLAIM. */
    breaks: 'says it was mDNS, and what that implies',
    from: "  const how = via === 'mdns'",
    to:   "  const how = false" },

  /* adb-discover #10 — and the collapse proper: make both methods take the sweep branch, so the
     verdict is the same sentence whichever way the endpoint was found. This is the one the
     same-endpoint comparison is for. */
  { suite: 'adb-discover', file: ADIS,
    why: 'the two discovery methods producing different wording at all',
    /* Collapsing this chain from the TOP does not work — the mDNS branch is first, so flipping
       the later test leaves it untouched (watched: that version came back WRONG-CLAIM). The way
       to make the two answers identical in one edit is to give mDNS the sweep's own sentence. */
    breaks: 'the two methods do not share wording',
    from: "    ? 'mDNS — the phone answered a link-local query, so it is on this LAN'",
    to:   "    ? `a bounded TCP sweep of ${host || 'the known addresses'} — mDNS did not answer, `\n"
        + "      + 'which is expected when the phone is remote'" },

  /* adb-discover #9 — no endpoint yielding NO verdict. An empty string prints as a blank stage
     detail, which reads as a success with no evidence behind it — the shape this whole project
     keeps finding in its own tooling. */
  { suite: 'adb-discover', file: ADIS,
    why: 'refusing to describe a discovery that did not happen',
    breaks: 'no endpoint yields NO verdict',
    from: '  if (!endpoint) return null;',
    to:   "  if (!endpoint) return '';" },

  /* ice-path #4 — a DIRECT-LAN tailnet path not counting as the remote case. Tailscale will set
     up a direct path to a LAN-local endpoint, and then 100.x traffic never leaves the subnet:
     the ICE stage reports "over the Tailscale TUN" truthfully while proving nothing about
     reaching this Mac from elsewhere. Measured while writing this — `direct 192.168.10.53`.
     Counting it as remote is how a run on the sofa closes an acceptance item it never touched. */
  { suite: 'ice-path', file: ICEPATH,
    why: 'a same-network direct path not passing as the remote case',
    breaks: 'a direct LAN path does NOT exercise the remote case',
    from: '      ? { kind: \'direct-lan\', via: p.lan, exercisesRemote: false,',
    to:   '      ? { kind: \'direct-lan\', via: p.lan, exercisesRemote: true,' },

  /* ice-path #5 — the private-address test the whole classification turns on. A tailnet address
     is NOT a LAN address; treat 100.64/10 as private and every path classifies as local, which
     fails the acceptance item forever and teaches people to ignore the stage. */
  { suite: 'ice-path', file: ICEPATH,
    why: 'knowing which addresses are private, and that 100.x is not one',
    breaks: 'a tailnet address is not a LAN address',
    from: '  if (o[0] === 10) return true;',
    to:   '  if (o[0] === 10 || o[0] === 100) return true;' },

  /* ice-path #6 — ABSENT is not REMOTE. A peer missing from tailscale status, or one that is
     offline, must not read as a path that was exercised: that is a claim about a measurement
     nobody took, which is the shape this project keeps finding in its own reporting. */
  { suite: 'ice-path', file: ICEPATH,
    why: 'an unobserved peer not counting as a remote path',
    breaks: 'a peer that is not in the status output is unknown, not remote',
    from: "    return { kind: 'unknown', via: null, exercisesRemote: false,\n"
        + "             note: 'the peer is not in tailscale status at all' };",
    to:   "    return { kind: 'direct-remote', via: null, exercisesRemote: true,\n"
        + "             note: 'assumed remote' };" },

  /* java-mic #1 — THE defect this suite exists for, planted in the real source: negate the
     argument to setMicrophoneMute. Every host assertion still passes — micMuted is set
     correctly so the ring reads MUTED, the interrupt is still suppressed, the reply still
     plays — and only the microphone stays live, which is issue #1 itself. One character, no
     host-side detector until now. */
  { suite: 'java-mic', file: PLUGINJ,
    why: 'the mute argument reaching AudioManager unnegated',
    breaks: 'it passes the parameter straight through, NOT negated',
    from: '            am.setMicrophoneMute(muted);',
    to:   '            am.setMicrophoneMute(!muted);' },

  /* java-mic #2 — the TOGGLE toggling. A constant here mutes and never unmutes: the button
     wedges, which is the other half of issue #1 and the half a screenshot cannot show. */
  { suite: 'java-mic', file: PLUGINJ,
    why: 'the native toggle flipping state rather than setting a constant',
    breaks: 'nativeToggleMic flips the current state',
    from: '    public void nativeToggleMic() { setMicMuted(!micMuted); }',
    to:   '    public void nativeToggleMic() { setMicMuted(true); }' },

  /* java-mic #3 — the reader not being fooled by prose. This suite's own header, and the
     comments around the call site, both spell out the negated form; a scanner that reads
     comments would find the bug in the explanation of the bug and report a permanent red. */
  { suite: 'java-mic', file: JFACTS,
    why: 'ignoring calls that appear only in comments or strings',
    breaks: 'a call named only in a COMMENT is not read as a call',
    from: "    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')",
    to:   "    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, (m) => m)" },

  /* stage-select #1 — REFUSING a phase name it does not know. Falling back to a full pass on a
     misspelling is the worst available outcome: the operator asked for a two-minute check,
     waited ten, and the report looks exactly like the one they wanted. Silence about a typo is
     how a selector becomes a lie. */
  { suite: 'stage-select', file: SSEL,
    why: 'refusing an unknown phase instead of running everything',
    breaks: 'an unknown phase runs NOTHING rather than everything',
    from: '      return { names: null,\n'
        + '               error: `unknown phase "${n}" for ${flagName}`',
    to:   '      return { names: PHASE_NAMES,\n'
        + '               error: null && `unknown phase "${n}" for ${flagName}`' },

  /* stage-select #2 — --from meaning "and everything after". Collapse it to a single phase and
     a resumed run stops one phase in, which reads as the rest having been skipped on purpose. */
  { suite: 'stage-select', file: SSEL,
    why: '--from running the phases that follow, not only the named one',
    breaks: '--from mute runs what comes AFTER it',
    from: '    const run = new Set(PHASE_NAMES.slice(at));',
    to:   '    const run = new Set([PHASE_NAMES[at]]);' },

  /* stage-select #3 — a partial pass SAYING so. Tomorrow the report is just a file: one whose
     mute stages passed and one that never attempted them must not read the same. */
  { suite: 'stage-select', file: SSEL,
    why: 'a partial selection describing itself as partial',
    breaks: 'a partial selection describes itself as partial',
    from: "  return `${sel.kind}: running ${[...sel.run].join(', ')}`\n"
        + "       + (skipped.length ? ` — SKIPPED ${skipped.join(', ')} (this is a PARTIAL pass)` : '');",
    to:   "  return `${sel.kind}: running ${[...sel.run].join(', ')}`;" },

  /* stage-select #4 — DISCOVERY surviving every selection. Every later phase needs a serial, so
     a selector that can drop it only creates a way to get a confusing failure at the point
     someone is trying to iterate quickly. */
  { suite: 'stage-select', file: SSEL,
    why: 'discovery running whatever else was selected',
    breaks: '--from still runs discovery',
    from: '    for (const p of PHASES) if (p.always) run.add(p.name);\n'
        + "    return { run, kind: 'from', error: null };",
    to:   "    return { run, kind: 'from', error: null };" },

  /* run-facts #1 — a BLANK screenshot not passing as evidence. `screencap -p` returns a
     well-formed PNG of a black screen when the device is asleep or the activity has not drawn,
     and the run wrote it and reported verified: four acceptance items resting on a rectangle
     nobody looked at. The threshold is measured (blank 0.0029 bytes/pixel, sparsest real
     capture 0.0428); dropping it back below the blank is the regression. */
  { suite: 'run-facts', file: RFACTS,
    why: 'a flat-colour capture being rejected as blank',
    breaks: 'a BLANK frame is rejected',
    from: '                                   minBytesPerPixel = 0.01 } = {}) {',
    to:   '                                   minBytesPerPixel = 0.0008 } = {}) {' },

  /* run-facts #2 — a TRUNCATED capture. exec-out over a flaky link cuts the stream mid-chunk
     and the header still looks fine, so without the IEND check half an image reads as a whole
     one — and half a screenshot of a control bar is exactly the shape that would be believed. */
  { suite: 'run-facts', file: RFACTS,
    why: 'noticing a capture that stopped arriving',
    breaks: 'a TRUNCATED capture is rejected',
    from: "  if (b.indexOf(Buffer.from('IEND')) < 0) {",
    to:   '  if (false) {' },

  /* run-facts #3 — the TRIGGER being long enough to tap mid-sentence. Too short and the reply
     is over before the mic is tapped: mute and stop come back blocked, and the phone is blamed
     for the phrase. This is the check that costs nothing and saves the eighth minute. */
  { suite: 'run-facts', file: RFACTS,
    why: 'rejecting a trigger phrase that would be over before the taps land',
    breaks: 'a short phrase is rejected',
    from: '    adequate: seconds >= needSec,',
    to:   '    adequate: true,' },

  /* run-facts #4 — a PARTIAL report not reading as a verification. The file outlives the
     terminal: a pass that never attempted the mute stages and one where they passed must not
     look the same tomorrow, and "no failures" is not the same claim as "everything ran". */
  { suite: 'run-facts', file: RFACTS,
    why: 'a report with skipped stages reading as partial, not full',
    breaks: 'REACHED the phone but skipped phases reads as partial',
    from: '  const skipped = rows.filter((r) => r && r.status === \'skipped\');\n'
        + '  if (skipped.length) {',
    to:   '  const skipped = rows.filter((r) => r && r.status === \'skipped\');\n'
        + '  if (false) {' },

  /* run-facts #5 — a REPEATED stage name. Two rows under one name means the later verdict
     silently replaces the earlier for anyone reading the file by name, which is how a failed
     stage disappears from a report that still contains it. */
  { suite: 'run-facts', file: RFACTS,
    why: 'catching two report rows that share a stage name',
    breaks: 'a REPEATED stage name is caught',
    from: '  const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);',
    to:   '  const dupes = [];' },

  /* run-facts #6 — NOT-REACHED not reading as a full pass, which is the verdict a real cold run
     actually produces and the one this got wrong. The first version defined "full" as "no
     skipped rows"; the first end-to-end cold run gave four host-side preflight stages verified,
     the device gate blocked, and no skipped rows anywhere — so the file classified itself
     `full: 5 stage(s) attempted` for a run that never touched the phone. Passing preflight is
     not a device pass however many rows it fills, and this is the file someone quotes. */
  { suite: 'run-facts', file: RFACTS,
    why: 'a run that never reached the phone not reading as a verification',
    breaks: 'does NOT read as full',
    from: "  if (!gateRow || gateRow.status === 'blocked' || gateRow.status === 'failed') {",
    to:   '  if (false) {' },

  /* device-stages #3 — a DRY report not counting as device evidence. This is the trap the first
     version of the coverage computation fell into and the reason it is computed at all: a dry
     run marks host-side preflight rows `verified` — "APK present", "the trigger phrase speaks
     for long enough" — and counting those said two acceptance items had device evidence when
     nothing had been touched. The gate, and only the gate, says the phone was reached. */
  { suite: 'device-stages', file: DACC,
    why: 'a report that never reached the phone contributing no device evidence',
    breaks: 'a DRY report contributes no device evidence',
    from: "  const reached = !!report && report.dryRun !== true && !!gate && gate.status === 'verified';",
    to:   '  const reached = true;' },

  /* device-stages #4 — and the counter not being stuck at zero. A computation that can never
     move is as useless as one that always moves: when a real pass finally lands it has to
     register, or the number stops being a measurement and becomes a slogan. */
  { suite: 'device-stages', file: DACC,
    why: 'a real device pass actually moving the items its stages name',
    breaks: 'moves the items its stages name',
    from: "  const moved = DEVICE_ACCEPTANCE.filter((a) => (a.stages || [])\n"
        + "    .some((s) => ['verified', 'built'].includes(byName.get(s)))).map((a) => a.id);",
    to:   '  const moved = [];' },

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
    breaks: 'rendered at all (the sandbox received its queued messages)',
    from: '    if (!v.ready) { v.queue.push(msg); return; }',
    to: '    if (false) { v.queue.push(msg); return; }' },

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
    breaks: 'Stop clears the mic by',
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

