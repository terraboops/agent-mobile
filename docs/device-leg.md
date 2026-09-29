# The device leg — what is blocked, and the one step that unblocks it

Everything on the agent-mobile acceptance list that does not need the handset is proved
host-side. What is left needs the Pixel to accept an adb connection, and it currently does not.

## The measurement, not the assumption

Taken 2026-09-28 20:30 PDT, by direct TCP connect with no adb server involved:

    192.168.10.53:5555    ECONNREFUSED     <- LAN; the host ANSWERED
    192.168.10.53:38864   ECONNREFUSED     <- the port a previous session used
    100.112.255.69:5555   timeout          <- tailnet; says nothing either way

`tailscale status` at the same moment:

    100.112.255.69   pixel-7   terra@   android   active; direct 192.168.10.53:38864

A **refusal** is the informative answer and a timeout is not. Refused means the phone is up,
reachable on this LAN, and answering on its own behalf — there is simply nothing bound to that
port. That rules out the whole class of "network / Tailscale / firewall" explanations that a
timeout would leave open, and it is why more polling cannot help: `adbd` is not running, and
nothing this Mac does can start it.

`adb mdns services` returns an empty list, which is expected and not a second symptom: mDNS is
link-local multicast and the path to the phone here is the Tailscale direct one.

## The step

**Settings → System → Developer options → Wireless debugging → ON.**

No pairing code should be needed: this Mac already holds a pairing for the device in
`~/.android/adb_known_hosts.pb` (`adb-33250DLH2000CB-3DAvRt`, written 2026-08-24), and that
pairing survives the toggle. The exception is if the phone's **Wireless debugging → Paired
devices** list no longer shows this Mac — after a "Revoke USB debugging authorizations", a
reset, or a rebuild of the phone — in which case use **Pair device with pairing code** on that
same screen and run, from this repo:

    adb -P 5039 pair 192.168.10.53:<pair-port> <6-digit-code>

(there is deliberately no npm wrapper for this — it is a one-off that needs a code read off the
phone screen, and `-P 5039` keeps it on the isolated adb server like everything else here)

USB works just as well and skips all of the above: plug the phone in and accept the
"Allow USB debugging?" prompt.

## After the toggle

The port Android binds for wireless debugging is **random and changes every time the toggle is
cycled**, so a hand-copied number goes stale immediately. `npm run device-verify` discovers it:
mDNS first, then a bounded TCP sweep of both the LAN and tailnet addresses. If the phone screen
is already showing an "IP address & Port" it can be passed directly instead:

    npm run device-verify -- --device 192.168.10.53:<port>

Everything it drives runs against its **own adb server on port 5039** (`adb -P 5039`), so it
never touches the default server on 5037 or whatever is attached to it.

## Staged and ready to fire

Built and verified 2026-09-28 21:36 PDT, waiting on the toggle:

    android/app/build/outputs/apk/release/app-release.apk     57 MB

It is a RELEASE build signed with the debug keystore (see the comment in
`android/app/build.gradle` for why — in short, a new key cannot replace what is on the phone
without an uninstall, and an uninstall destroys the IdentityStore keypair the sidecar has
pinned). It passes all 24 `apk-installable` assertions, including the signer check and the
byte-for-byte comparison of its bundled `www/` against the working tree.

`AGENTMOB_APK` selects which APK the tooling means — one constant, read by the installability
gate and by the installer, so the artifact that was verified is the artifact that gets
installed. The debug build remains the default.

The moment wireless debugging is ON, one command does the whole run:

    AGENTMOB_APK=android/app/build/outputs/apk/release/app-release.apk npm run device-verify

It discovers the endpoint itself, installs with `-r` (keeping app data, so the pinned identity
survives), launches, and then drives — in order — the boot screenshot, the AEAD handshake and
live client identity, WebRTC negotiation (opus **PT 111** proves it is the real device and not
the werift harness), **which ICE path the media actually took**, the connected control bar and
widget-tile screenshots, a spoken reply, the **speaking pill**, a native mic tap **mid-sentence**
with `dumpsys` evidence that the mic muted and the reply kept playing (issue #1), and a Stop tap
that must actually stop the audio. Rehearsed dry (`-- --dry`); everything that does not need the
handset passes.

### If something fails part-way

The pass is about ten minutes and the install is the slowest phase, so a failure in the mute
phase should not cost another install to look at again:

    npm run device-verify -- --from mute     # discovery, then mute and stop
    npm run device-verify -- --only surface  # discovery, then just the screenshots

Phases, in order: `discover install launch handshake surface speak mute stop`. Discovery always
runs — every later phase needs a serial. `speak` is implied by `mute` and `stop`, because neither
is observable without a reply in flight. A phase name it does not recognise is REFUSED with a
suggestion and a non-zero exit, never quietly turned into a full pass. Skipped phases are printed
as SKIPPED and the run ends with a PARTIAL PASS line, so a report that never attempted the mute
stages cannot be mistaken tomorrow for one where they passed.

### One thing to know before running it

`ICE over the Tailscale TUN` will report **blocked, not verified**, if the Pixel is on the same
Wi-Fi as this Mac — the LAN candidate pair wins on priority and the media never touches the
tailnet. That is not a failure, and it is also not the claim: reaching this Mac from anywhere is
what the tailnet path is for, and a run done on the sofa cannot exercise it. To prove that one,
put the Pixel on mobile data (Tailscale stays up) and run it again. The stage names which of the
two happened rather than reporting "ICE connected" for both.

## Status of the phone pass — BLOCKED ON THE DEVICE, not on this Mac

As of 2026-09-29 05:40 PDT, no device pass has ever run. Nothing here is a partial verification:
every report on disk is a dry run and says so in the file.

Measured, not assumed:

    tailscale status   idle; offline, last seen 13m ago
    tailscale ping     pong via direct 192.168.10.53:38864 in 81ms
    adb devices        (empty — no serial attached)
    192.168.10.53:5555 Connection refused      <- the phone's stack ANSWERED
    100.112.255.69:5555 Operation timed out

The status row and the ping disagree, and the ping is the stronger evidence: a pong over a
direct path means packets reached the handset just now, while `idle; offline` describes the
control-plane session, which Android drops when the screen has been off a while. Refused on the
LAN address means the same thing at the TCP layer — the host answered and nothing is bound.

The cold seam — discovery through to verdict with no device present — has been rehearsed for
real, not with `--dry`. That matters because `--dry` short-circuits every adb call, so the
discovery walk, the tailnet probe, the connect attempts, the sweep and the blocked verdict had
never actually executed in one pass. The rehearsal found one defect on its first run: the report
classified itself as a FULL pass (`full: 5 stage(s) attempted`) because "full" meant "no skipped
rows", and a cold run skips nothing — it just never gets past the gate. Four host-side preflight
stages and a blocked device gate now read as `not-reached`, which is what they are.

### To resume, the phone needs exactly one thing

**Settings → System → Developer options → Wireless debugging → ON.**

Not a re-pair: `~/.android/adb_known_hosts.pb` still holds `adb-33250DLH2000CB-3DAvRt` from
2026-08-24, and that pairing survives the toggle. Not a serial supplied by hand: the port is
randomised per toggle and discovered here. Not a permission: the "Allow wireless debugging?"
prompt only appears if the pairing is gone, and `device-verify` names that case separately if it
happens.

Then one command, which will not need this document again:

    AGENTMOB_APK=android/app/build/outputs/apk/release/app-release.apk npm run device-verify

If a phase fails, resume at it rather than repeating the install — see the section above.

**And for the tailnet claim specifically**: put the Pixel on mobile data for the run. On this
Wi-Fi the Tailscale path is `direct 192.168.10.53`, so the packets never leave the subnet and
the `tailnet path exercises the REMOTE case` stage will report blocked — correctly.

## What is waiting on this

* the APK install, launch and screenshots (including issue #2's `screenshot: connected control
  bar`, the single item keeping that issue open)
* the native mic toggle and `dumpsys audio` / `media.audio_flinger` evidence
* Android libwebrtc ICE over the tailnet, and opus at **PT 111** against the real client
  (werift negotiates 96, so the sidecar's inbound path at 111 is only covered by a mutation
  here, not by a handset)
* the render-turn narration actually playing on the device, in order with the render envelope

None of these have a host-side substitute. Everything that did has one, and it is proved.
