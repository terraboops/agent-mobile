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

    npm run device-pair -- <ip>:<pair-port> <6-digit-code>    # if present, else:
    adb -P 5039 pair 192.168.10.53:<pair-port> <6-digit-code>

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

## What is waiting on this

* the APK install, launch and screenshots (including issue #2's `screenshot: connected control
  bar`, the single item keeping that issue open)
* the native mic toggle and `dumpsys audio` / `media.audio_flinger` evidence
* Android libwebrtc ICE over the tailnet, and opus at **PT 111** against the real client
  (werift negotiates 96, so the sidecar's inbound path at 111 is only covered by a mutation
  here, not by a handset)
* the render-turn narration actually playing on the device, in order with the render envelope

None of these have a host-side substitute. Everything that did has one, and it is proved.
