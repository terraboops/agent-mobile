/**
 * device-acceptance — what the handset still has to prove, written down so it cannot drift.
 *
 * The risk this exists to stop is not that a stage FAILS. It is that a stage quietly stops being
 * counted as unproven: someone reads a green suite, assumes the device leg is covered, and ships
 * on it. Everything below has never executed a line against hardware. The repo has 900+ passing
 * assertions and NONE of them touched a phone.
 *
 * Each entry says what the claim is, why the host cannot settle it, and what HAS been proved here
 * instead — because "unproven on device" and "nothing is known" are different, and conflating
 * them is how work gets repeated or skipped.
 *
 * `hostProof` must name a real suite or say NONE. device-stages asserts that every stage
 * device-verify can report appears here, so a new stage cannot be added without a decision about
 * what it needs.
 */

/** Acceptance items, most load-bearing first. */
export const DEVICE_ACCEPTANCE = [
  {
    id: 'native-mic-toggle',
    issue: 1,
    claim: 'Tapping the NATIVE mic button actually silences the microphone on the device, and the '
         + 'badge reflects real audio state rather than an assumption.',
    whyDeviceOnly:
      'Narrowed to ONE syscall. AudioManager.setMicrophoneMute() has no host equivalent — whether '
      + 'it silences the hardware is a fact about the phone.\n\n'
      + 'BUT NOT TO ONE FILE. That sentence used to cover the whole native side, and it was '
      + 'too generous: mic-mute drives a STUBBED bridge in a browser, so nothing looked at '
      + 'what the Java does with the boolean it is handed. Write setMicrophoneMute(!muted) '
      + 'and every host assertion still passes — micMuted is set correctly, so the ring '
      + 'reads MUTED, the interrupt is still suppressed, the reply still plays — and only '
      + 'the microphone stays live, which is issue #1 itself. A one-character bug with no '
      + 'host-side detector. java-mic reads the call site from source: the argument is '
      + 'passed through unnegated, the tracked field takes the same value, the web layer is '
      + 'notified, the toggle flips rather than setting a constant, and a failure is '
      + 'logged. Each with a fixture carrying the exact bug it names, and the reader proven '
      + 'not to mistake a comment or a string for a call.\n\n'
      + 'What is left really is the syscall. ',
    hostProof: 'mute-webrtc (the FALSIFIABLE one: on the paced WebRTC downlink the sidecar '
             + 'checks the cancel token before every frame, so dropping the VAD threshold makes '
             + 'a muted mic read as speech onset, barge-in truncates the reply, and the sidecar '
             + 'records "cut short ... superseded or interrupted" — mutation CAUGHT); '
             + 'mute-midreply (the same claim end to end over the WS downlink, where it holds by '
             + 'construction because that path is burst-sent); mic-mute (20 assertions, no '
             + 'device: muting does not stop the reply, sends no interrupt, flatlines the meter, '
             + 'unmutes again, survives a reconnect — reverting __ensureMicOn fails it; Stop '
             + 'interrupts the reply and leaves the mic alone; a double tap causes exactly one '
             + 'native transition); android-lint + @RequiresPermission (the callers are verified '
             + 'to hold RECORD_AUDIO); apk-installable (MODIFY_AUDIO_SETTINGS is in the built '
             + 'APK, without which the mute silently no-ops); ctrlbar-geometry (the button is '
             + '48dp+ at every width and cannot collide with Stop)',
    stages: ['the trigger phrase speaks for long enough to tap mid-sentence',
             'mute mid-sentence (issue #1)',
             'mute mid-sentence: the device reports the mic muted (issue #1)',
             'mute mid-sentence: the reply KEPT playing (muting the mic must not stop it)',
             'tapped the native mic mid-sentence',
             'mic tap point from MainActivity constants'],
  },
  {
    id: 'android-webrtc',
    issue: null,
    claim: "Android's libwebrtc completes ICE/DTLS with the sidecar and media flows both ways.",
    whyDeviceOnly:
      'Every WebRTC test here drives werift. Payload-type handling was settled host-side (opus '
      + 'PT 111 negotiates and carries end to end), but werift is not libwebrtc: its jitter '
      + 'buffer, DTLS stack, AEC and ICE behaviour are all different implementations.',
    hostProof: 'webrtc-pt + e2e-webrtc-pt111 (the sidecar follows the offerer\'s payload type, '
             + 'and the full path works at 111 — the number Android uses)',
    stages: ['WebRTC negotiated', 'WebRTC negotiated by Android libwebrtc'],
  },
  {
    id: 'tailnet-only-egress',
    issue: 2,
    claim: 'A phone whose ONLY route to this Mac is the tailnet completes an ICE pair.',
    whyDeviceOnly:
      'Both peers run on THIS host, and the route to this host\'s own tailnet address is a LOCAL '
      + 'host route — route -n get reports flags <UP,HOST,DONE,LOCAL>, against a plain '
      + '100.64.0.0/10 tunnel route for a remote peer. The kernel short-circuits it, so not one '
      + 'byte crosses WireGuard or DERP. No arrangement of two processes on one machine fixes '
      + 'that; it needs a second host, and standing one up means deploying. ice-tailnet now pins '
      + 'the LOCAL flag as an assertion so the limitation is stated, not remembered.',
    hostProof:
      'ice-tailnet (both ends are genuinely ON the tailnet address — our socket binding and the '
      + 'sidecar\'s advertised host candidate, with the answer filtered down to that candidate '
      + 'alone so no other pair can form) + ice-path (which PAIR carried the media, and now what '
      + 'kind of tailnet path is underneath it).\n\n'
      + 'NARROWED. The item used to say only that a second host is needed. One host can settle '
      + 'more than that: whether the remote path was exercised AT ALL. Tailscale sets up a '
      + 'DIRECT path to a LAN-local endpoint when both machines are on the same network, and '
      + 'then 100.x traffic never leaves the subnet — measured here 2026-09-29, '
      + '`direct 192.168.10.53:38864`. A device run in that state reports "ICE over the '
      + 'Tailscale TUN" truthfully and proves nothing about reaching this Mac from elsewhere, '
      + 'which is the same overclaim the ICE stage exists to prevent, one layer down. '
      + 'device-verify now reports the path KIND alongside the pair and refuses to call a '
      + 'direct-LAN path the remote case; relay and direct-public both count, because in either '
      + 'the packets leave this network.\n\n'
      + 'RESIDUE: that a phone on a DIFFERENT network completes the path. The cheap version '
      + 'needs no second machine — put the Pixel on mobile data, where Tailscale must relay or '
      + 'punch, and the stage flips to verified on its own. The expensive version, a second '
      + 'host, is not needed for that and would mean deploying.',
    stages: ['ICE path (tailnet vs LAN)', 'tailnet path exercises the REMOTE case'],
  },
  {
    id: 'webview-render',
    issue: null,
    claim: 'The surface renders correctly in the Pixel\'s Android System WebView.',
    whyDeviceOnly:
      'ux-audit drives desktop Chromium at a Pixel 7 viewport. That is not the WebView, and this '
      + 'line used to name three reasons: version, font stack, inset behaviour. Two are settled '
      + 'and the third is narrowed to something a host genuinely cannot reach.\n\n'
      + 'VERSION: settled by webview-baseline — the surface uses nothing newer than the floor '
      + 'the declared minSdk guarantees, so the WebView version cannot change the answer.\n'
      + 'INSETS: settled by ctrlbar-geometry — clearance across 320/360/412dp and font scales '
      + '1.0-1.6, constants read from MainActivity rather than assumed.\n'
      + 'FONT STACK: the stack was `-apple-system, system-ui, "Segoe UI", sans-serif`, which '
      + 'resolves to -apple-system on the audit host and system-ui on the Pixel. The audit was '
      + 'taking a DIFFERENT BRANCH of the list, not merely rendering the same branch differently '
      + '— and nothing said so. It is now `system-ui, sans-serif`, so every platform picks the '
      + 'same entry; font-stack pins that, with a control asserting the old stack reads as '
      + 'divergent.\n\n'
      + 'RESIDUE: the same keyword still yields SF Pro here and Roboto there, and closing that '
      + 'would mean shipping a font binary into an egress-free webview. The metric difference is '
      + 'single-digit percent of advance width, inside the 1.0-1.6x range the geometry claims '
      + 'already hold across — font-stack asserts that range has not narrowed, so the argument '
      + 'cannot rot silently. What is left needs eyes: whether Roboto at these sizes and '
      + 'letter-spacings LOOKS right on the handset. That is appearance, not layout.',
    hostProof: 'ux-audit (21 rendered states, objective a11y/geometry checks) + its '
             + 'webview-baseline gate (the surface uses no CSS or JS newer than the minSdk '
             + 'floor, so WebView VERSION no longer changes the answer)',
    stages: ['screenshot: boot', 'screenshot: connected control bar', 'screenshot: speaking pill',
             'screenshot: widget tiles / theme tokens', 'WebView version read from the device'],
  },
  {
    id: 'narration-playback-order',
    issue: null,
    claim: 'The handset PLAYS a render-turn narration, in order, after the render envelope.',
    whyDeviceOnly:
      'e2e-voice-render proves the frames were SENT in that order. Android buffers audio and the '
      + 'WebView paints on its own schedule, so send order is not play order.',
    hostProof: 'e2e-voice-render (a render-only reply is narrated, and speech arrives after the '
             + 'render envelope on the host side)',
    stages: ['speaking pill', 'trigger a spoken reply (typed turn over AEAD)'],
  },
  {
    id: 'stop-control',
    issue: null,
    claim: 'Tapping Stop mid-sentence actually stops playback on the device.',
    whyDeviceOnly:
      'Narrowed to the buffer, and then READ — which changed what this item is.\n\n'
      + 'The host proves the downlink stops, stays stopped and resumes for a later turn. What '
      + 'remains is the audio already on the phone, and inspecting the Java says there is no '
      + 'path that would flush it. Stop sends {"cmd":"interrupt"} through '
      + 'AgentChannelPlugin.send(), which treats the payload as opaque and forwards it to the '
      + 'sidecar; nothing clears playQueue or replyQueue and nothing calls AudioTrack.flush(). '
      + 'The queues are deliberately UNBOUNDED (a fixed one silently dropped every reply longer '
      + 'than its capacity), so what survives a Stop depends on the transport:\n\n'
      + '  WebRTC downlink: the sidecar paces at 20ms/frame, so the local queue stays about one '
      + 'frame deep. Residue is the 160ms pre-roll plus the AudioTrack buffer — the "hundreds of '
      + 'ms" this note always claimed, and probably acceptable.\n'
      + '  WS fallback: the sidecar BURSTS the reply (a setImmediate yield every 128 frames), so '
      + 'the whole remaining reply can be sitting in replyQueue when Stop is pressed. Stop would '
      + 'appear not to work, for seconds.\n\n'
      + 'So this is no longer "unverified until the handset" — it is a known gap with a named '
      + 'cause and a measured asymmetry. The device run negotiates WebRTC (opus PT 111), so it '
      + 'would likely PASS and leave the WS case unexercised, which is worth knowing before '
      + 'anyone spends the phone\'s time on it.\n\n'
      + 'FIXED 2026-09-29. AgentChannelPlugin.flushPlayback() clears playQueue and replyQueue '
      + 'and flushes BOTH AudioTracks — emptying the queues alone leaves the hardware buffer to '
      + 'play out, which is the fraction of a second someone notices. bridge.js calls it FIRST '
      + 'and does not await it: the interrupt is a round trip to the host, and the buffered '
      + 'audio would keep playing for its duration. stop-flush (24 assertions, 5 mutation '
      + 'entries) pins the queue semantics, the pause/flush/play order that AudioTrack requires, '
      + 'the null-track race with the reply thread, and the pre-roll stamp being re-armed so the '
      + 'reply AFTER a Stop does not start under-primed and clip — the bug this project already '
      + 'fixed once, which a careless fix here would have reintroduced.\n\n'
      + 'THE LIMIT, PLAINLY: those assertions read source. They do not hear anything. That the '
      + 'audio actually stops, and that the next reply starts cleanly rather than clipped, is a '
      + 'fact about the handset — this item stays open until the device pass, and the WS '
      + 'fallback case needs a run where WebRTC does NOT negotiate, since the paced downlink '
      + 'hides the failure the fix was for. The touch-to-bridge leg is covered by mic-mute.',
    hostProof: 'e2e-interrupt (13 assertions: the downlink stops, the sidecar records the '
             + 'playback as CUT SHORT with a reason naming the interrupt, no packet arrives '
             + 'after it, AND — the half that was missing — a NEW reply plays afterwards on the '
             + 'same surviving WebRTC peer, so Stop does not wedge the pipeline); mic-mute '
             + '(Stop sends an interrupt and does not touch the mic)',
    stages: ['WS fallback forced for this run',
             'tapped Stop mid-sentence', 'Stop actually stopped the audio'],
  },
  {
    id: 'identity-pinning',
    issue: null,
    claim: 'The installed app presents client_id 42c55608, so allowed_clients can be pinned.',
    whyDeviceOnly:
      'Narrowed to the VALUE. The mechanism is proven (see hostProof); what no host can supply '
      + 'is which id this phone actually holds — it comes from the IdentityStore keypair in '
      + 'app-private storage, and only a connection from the installed app reveals it. Until '
      + 'then 42c55608 is a number from the archives, and pinning an unconfirmed value is the '
      + 'one way to lock the handset out of its own gateway.',
    hostProof: 'identity-pin (the allowlist MECHANISM, proven on the scoped gateway against live '
             + 'AEAD handshakes in three directions: a wrong id is rejected specifically with '
             + 'unknown_client rather than a hang or a generic failure, the pinned id is '
             + 'admitted, and removing the allowlist lets the previously-rejected client in — so '
             + 'the rejection came from the gate and not from unrelated breakage); '
             + 'apk-installable (debug-keystore signed, so `adb install -r` replaces in place and '
             + 'does NOT rotate the identity — an uninstall would); pairing (proto.js allow gate)',
    stages: ['live client identity', 'identity matches the archived id (42c55608)',
             'AEAD handshake'],
  },
  {
    id: 'install-and-launch',
    issue: null,
    claim: 'The APK installs on the Pixel and the app launches.',
    whyDeviceOnly:
      'Installation exercises the device package manager against this signer and this '
      + 'minSdk/targetSdk pair, and launch exercises the Capacitor runtime under the real '
      + 'WebView. Both can fail for reasons no host check sees: a signature conflict with an '
      + 'already-installed build, insufficient storage, or a crash on first paint.',
    hostProof: 'apk-installable (valid v2 signature, one signer, arm64-v8a, and every bundled '
             + 'web asset byte-matches www/ — an APK can install cleanly and still carry a '
             + 'stale surface.\n\n'
             + 'It also settles whether `am start` can REACH the launcher, which was the last '
             + 'blind spot here: the component is read out of the SHIPPED manifest — not the '
             + 'source, which is one input to a merge — and checked for android:exported. An '
             + 'activity that exists but is not exported installs perfectly and then refuses '
             + 'the start with a SecurityException, so the app never runs and nothing of ours '
             + 'reaches logcat. Asserted both ways, the negative against the real dump with '
             + 'exported flipped to false.\n\n'
             + 'And the launch VERDICT itself: device-verify keeps what am start printed and '
             + 'names a refusal rather than letting it fall through to "no process", and reads '
             + 'logcat for a crash ATTRIBUTED to this package — Android restarts an app that '
             + 'throws in onCreate, so a pid alone was reporting a crash loop as a launch.\n\n'
             + 'The install FAILURE shape is named rather than dumped. `-r` was asserted as a '
             + 'flag in the argv, which says the right command runs and nothing about what '
             + 'happens when it does not. One failure matters more than the rest: a signer '
             + 'mismatch cannot be replaced in place, the documented fix is `adb uninstall`, and '
             + 'app-private storage holds the IdentityStore keypair the allowlist pins — so the '
             + 'fix rotates the identity and the gateway refuses the phone as an unknown client. '
             + 'That case now gets its own verdict saying DO NOT UNINSTALL and why, a flag the '
             + 'run raises a second stage from, and both directions asserted against real adb '
             + 'output. Both staged APKs are also checked to share one signer, since alternating '
             + 'between the debug and release builds is how someone following device-leg.md '
             + 'would trigger that failure in the first place.\n\n'
             + 'STILL DEVICE-ONLY: whether `-r` actually PRESERVES the keypair. Everything above '
             + 'establishes that it can replace in place; that the data survives is a fact about '
             + 'the phone.)',
    stages: ['APK present', 'install APK', 'install APK (-r, keeps IdentityStore)',
             'DO NOT UNINSTALL to recover from this',
             'app launched', 'adb present', 'device authorised',
             'wireless-debugging endpoint discovered',
             /* Local preflight — these need NO handset and now run BEFORE the device gate, so a
              * blocked run still establishes them. They are listed here because they belong to
              * this acceptance item, not because they are still unproven. */
             'APK declares its SDK levels',
             'APK minSdk matches the project declaration',
             'bundled web assets match www/'],
  },
];

/** Every device-verify stage name that the list accounts for. */
export function coveredStages() {
  return new Set(DEVICE_ACCEPTANCE.flatMap((a) => a.stages));
}

/** The one thing currently blocking all of it, kept in one place so it is stated once. */
export const BLOCKER =
  'Wireless debugging is OFF on the Pixel. The handset is up and reachable — tailscale ping '
  + 'returns a pong, and the LAN address answers CONNECTION REFUSED rather than timing out, '
  + 'which is the phone\'s own TCP stack saying nothing is listening. Settings > System > '
  + 'Developer options > Wireless debugging. The port is discovered automatically and the '
  + 'pairing key is already in ~/.android/adb_known_hosts.pb, so that toggle is the only step.';

/**
 * How many acceptance items rest on HOST-SIDE EVIDENCE ALONE — nothing on the Pixel touched.
 *
 * WHY IT IS COMPUTED AND NOT WRITTEN DOWN. Every item carries a `hostProof` paragraph, and the
 * temptation all night has been to read those and conclude the item has moved. They describe
 * what a Mac established; none of them is evidence that the phone did anything. The only thing
 * that moves an item is a device stage coming back verified in a report that actually reached
 * the device.
 *
 * REPORTS THAT NEVER REACHED THE PHONE DO NOT COUNT, and this is the trap the first version of
 * this fell into: a dry-run report has stages marked `verified` — "APK present", "the trigger
 * phrase speaks for long enough" — and counting those said two items had device evidence. They
 * are host-side preflight. A report only carries device evidence if its gate stage passed.
 *
 * @param {object|null} report the parsed device-verify.json, or null when none exists
 * @returns {{onHostOnly: string[], moved: string[], usable: boolean, why: string}}
 */
export function acceptanceCoverage(report) {
  const rows = (report && Array.isArray(report.report)) ? report.report : [];
  const gate = rows.find((r) => r && r.name === 'device authorised');
  const reached = !!report && report.dryRun !== true && !!gate && gate.status === 'verified';
  if (!reached) {
    return {
      onHostOnly: DEVICE_ACCEPTANCE.map((a) => a.id),
      moved: [],
      usable: false,
      why: !report ? 'no device report exists at all'
        : report.dryRun ? 'the only report is a DRY RUN — no device was touched, and its '
                        + '"verified" rows are host-side preflight'
        : !gate ? 'the report has no device gate row, so it never attempted the phone'
        : `the device gate is ${gate.status} — the run never reached the phone`,
    };
  }
  const byName = new Map(rows.map((r) => [r.name, r.status]));
  const moved = DEVICE_ACCEPTANCE.filter((a) => (a.stages || [])
    .some((s) => ['verified', 'built'].includes(byName.get(s)))).map((a) => a.id);
  return {
    onHostOnly: DEVICE_ACCEPTANCE.filter((a) => !moved.includes(a.id)).map((a) => a.id),
    moved,
    usable: true,
    why: `${rows.length} stage(s) in a report that reached the device`,
  };
}
