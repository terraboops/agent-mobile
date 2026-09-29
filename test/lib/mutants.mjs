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

