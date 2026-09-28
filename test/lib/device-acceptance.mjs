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
      'Narrowed to ONE mechanism. AudioManager.setMicrophoneMute() has no host equivalent, and '
      + 'the call site sets the micMuted field BEFORE the call and wraps it in catch { Log.w }, '
      + 'so a permission or OEM restriction makes the mute a no-op while the badge still renders '
      + 'muted. Only `adb shell dumpsys audio` can say whether the hardware actually went quiet. '
      + 'The STATE MACHINE around it no longer needs the phone — see hostProof.',
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
    stages: ['mute mid-sentence (issue #1)',
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
    hostProof: 'ice-tailnet (both ends are genuinely ON the tailnet address — our socket binding '
             + 'is verified against lsof and the offer advertises the address it is really bound '
             + 'to, not werift\'s default-interface guess — and ICE completes with no LAN or '
             + 'srflx path available)',
    stages: [],
  },
  {
    id: 'webview-render',
    issue: null,
    claim: 'The surface renders correctly in the Pixel\'s Android System WebView.',
    whyDeviceOnly:
      'ux-audit drives desktop Chromium at a Pixel 7 viewport. That is not the WebView: '
      + 'different version, different font stack, different inset behaviour under edge-to-edge.',
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
      'Narrowed to the buffer. The host now proves the downlink stops, stays stopped, and '
      + 'RESUMES for a later turn. What remains is that the AudioTrack already holding buffered '
      + 'PCM is flushed: audio can keep playing for hundreds of ms after the send path goes '
      + 'quiet, and only the handset shows that. The touch-to-bridge leg is covered by mic-mute.',
    hostProof: 'e2e-interrupt (13 assertions: the downlink stops, the sidecar records the '
             + 'playback as CUT SHORT with a reason naming the interrupt, no packet arrives '
             + 'after it, AND — the half that was missing — a NEW reply plays afterwards on the '
             + 'same surviving WebRTC peer, so Stop does not wedge the pipeline); mic-mute '
             + '(Stop sends an interrupt and does not touch the mic)',
    stages: ['tapped Stop mid-sentence', 'Stop actually stopped the audio'],
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
             + 'stale surface)',
    stages: ['APK present', 'install APK', 'install APK (-r, keeps IdentityStore)',
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
