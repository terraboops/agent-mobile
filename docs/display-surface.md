# Display surface design

The agent-mobile phone is a **surface** for the agent, not a chat log. The agent
communicates solely by **speaking** and by **displaying widget tiles** on a persistent
surface. This document defines the model, the wire protocol, and the trust boundary.

Inspired by the classic **Dashing/Smashing** dashboard pattern (persistent widget tiles
fed by event-keyed data), with one defining difference: **the agent can ship widget code
into the webview on demand.** Widget types are not a fixed primitive gallery — the agent
*defines* them by streaming code/assets through the channel.

## Mental model

| Dashing | agentmob |
|---|---|
| Dashboard = persistent grid of tiles | Display surface = persistent, additive grid of widgets |
| Widget = its own HTML + JS | Widget **type** = JS/CSS/HTML the agent ships over the channel and registers |
| Server jobs call `send_event('id', data)` | Agent processes data and publishes `data {key, payload}` over the channel |
| Updates hit a tile keyed by widget id | `publish` targets a widget by `key`, updating it **in place** |
| Jobs were hardcoded Ruby | **Agent ships new widget code on demand**, then instantiates + feeds it |

- Widgets **persist** across turns until removed or the session resets (Start-New).
- The webview is a **dumb but trusted-flexible host**: it executes code the agent shipped,
  on a surface the agent composes. This is the "wild west" — acceptable because the risk is
  bounded (see Trust boundary).

## Wire protocol

All ops ride the existing AEAD channel as structured messages. A permanent `surface`
message type carries ordered operations:

```
{ "type":"surface", "ops":[ <op>, ... ] }
```

### Ops

**Register an asset** (JS / CSS / image) so widget code can load it by name from the device.
```json
{ "op":"register_asset", "name":"lib/three.min.js", "mime":"text/javascript",
  "b64":"<base64>", "size":123456 }
```
Stored on-device under a **configurable max-storage cap** (app settings). If adding the asset
would exceed the cap, the app rejects it and reports back. `b64` may be split across multiple
`append` ops for large payloads.

**Define a widget type** — JS (and options) the app runs when a widget of this type renders.
Code may reference registered assets by name.
```json
{ "op":"register_widget_type", "name":"avatar", "code":"<js>", "assets":["lib/x.js"] }
```

**Instantiate / update a tile.**
```json
{ "op":"add_widget",    "key":"w1", "type":"avatar", "props":{...} }
{ "op":"update_widget", "key":"w1", "props":{...} }
{ "op":"remove_widget", "key":"w1" }
```

**Feed data into a tile** (in-place update, no repaint of other tiles).
```json
{ "op":"publish", "key":"w1", "data":{...} }
```

**Verify a shipped type works before depending on it** — the render-feedback loop.
```json
{ "op":"test_widget", "key":"probe_1", "type":"avatar", "props":{...} }
```

### Render feedback
For every `test_widget` (and any widget that fails), the app reports back over the
channel:
```
{ "type":"render_result", "key":"probe_1", "ok":true }                        // rendered
{ "type":"render_result", "key":"probe_1", "ok":false, "error":"<stack>" }    // failed
```
Errors are captured (window.onerror + try/catch around each tile's render) and routed back
so the agent can correct a broken widget type before building more widgets on it.

## Native chrome (the ONLY fixed UI)

Out of the webview, so agent code physically cannot reach them:

- **Mic button** — modern, round; animates while it hears the user speaking.
- **Stop button** — sends a stop command to the agent thread handling agentmob inputs
  (routed to `interrupt_session_activity`, the same hook as `/stop`).
- **Reply / speaking indicator** — a trusted visual cue when the agent is responding.

The rest of the screen is the webview (the agent's surface).

## Widget runtime contract

A widget type's `code` runs inside a fresh, opaque-origin sandboxed iframe
(`sandbox="allow-scripts"`, no same-origin): it can never reach the bridge, mic,
Stop, identity badge, or the network. The host talks to it only by `postMessage`.
The code defines two globals and draws into `#root`:

```js
(function () {
  var root = document.getElementById('root');
  window.render = function (props) { /* initial draw */ root.textContent = props.title; };
  window.onData = function (data)  { /* update in place — no re-render */ };
})();
```

- `add_widget` → the frame loads, then `render(props)`.
- `publish` → `onData(data)` on the same frame (no peer repaints).
- `update_widget` → `render(props)` again with the new props.
- `remove_widget` → the frame is torn down (any ApexCharts instance destroyed).
- `assets` named on `register_widget_type` are inlined into the frame ahead of the
  code as `<script>`/`<style>` — the sandbox is egress-free, so nothing can be
  fetched at runtime.

Ready-made types that follow this contract live in `widgets/`.

### Delivery guarantees (verified by `npm run surface-protocol` / `surface-chunks`)

- **Ordering within a batch.** Ops in one `__surface__` array apply in order, and
  messages to a widget's frame are queued until the frame has loaded, then
  flushed in order: initial `props` (→ `render`), then `data` (→ `onData`),
  then anything published meanwhile. `add_widget` + `publish` in one batch is
  the normal pattern and is guaranteed to land.
- **Chunked assets fail closed.** `register_asset` with `append:true` carries
  optional `seq` (0,1,2,…). A chunk that exceeds the cap, arrives out of order,
  duplicates a seq, or has an empty `b64` **aborts the whole upload**: its bytes
  are freed and the name is blocked until the agent restarts with `seq:0` or
  `unregister_asset`s it. Re-registering a complete asset is judged with the old
  bytes credited back and only replaces it once accepted.
- **Every failure is reported.** Unknown keys, unknown types, missing assets,
  throwing widget code, aborted uploads: each produces `render_result ok:false`
  with an actionable `error` naming the key. Nothing is dropped silently.

### What the frame receives from the host

- **Theme tokens** as CSS variables on `:root` — `--surface --ink --muted
  --accent --accent-2 --hairline --mono` — set at creation and updated live via a
  `vmtheme` message on every theme change. Widgets must draw from these, never a
  hard-coded palette (see `widgets/` for the pattern).
- **Content sizing.** A shared runner reports the root's content height to the
  host (`vmsize`) after each render/data and on DOM mutation; the host sizes the
  tile 64–640px. A widget that fills 100% height keeps the 320px default.

### Pinning the phone (leaving PAIRING MODE)

The sidecar ships with `AGENTMOB_ALLOWED_CLIENTS` unset, which is **pairing mode**:
`serverHandshake` gets no `allow` gate and accepts any client that can speak v2.
That is right for first pairing and wrong to leave running — anything that reaches
the port gets a live channel (mic uplink, surface ops).

To pin, take the id from the sidecar's own log line at first connect:

```
[sidecar] PAIRING: client 42c55608 identity=MCowBQYD...=  — add to AGENTMOB_ALLOWED_CLIENTS to pin
```

then set `AGENTMOB_ALLOWED_CLIENTS=42c55608` (short id or base64 SPKI, comma-separated
for several devices) and restart the gateway. The banner then reads `[allowlist 1]`
instead of `[PAIRING MODE — accepting any client]`, and an unpinned client is refused
with `unknown_client` before any reply or channel exists.

**Copy the id verbatim.** The gate is exact-match: a case change, a truncation or a
stray word does not disable the allowlist, it locks out the phone too. `npm run pairing`
covers each of those mistakes and asserts they fail closed.

### Voice media (H3) — verified without a device

`npm run e2e-webrtc` is a fake phone that negotiates **real WebRTC** with the running
sidecar and drives the media path both ways: it offers an audio m-line over the AEAD
cmd channel (`{cmd:'webrtc', sdp_type:'offer', sdp}`), applies the sidecar's answer,
waits for ICE/DTLS to reach `connected`, streams opus RTP on its mic track, and counts
the RTP the agent's TTS sends back on the downlink track.

This closes a real blind spot. `e2e-voice` never negotiates WebRTC at all, so the
sidecar has no peer, `webrtc.ready` stays false, and the downlink quietly falls back to
the WebSocket — which is why the media path went unexercised for so long. The WebRTC
harness asserts that fallback is **unused** (`ws audio frames: 0`) and the sidecar log
line reads `→ phone pcm … via WebRTC` rather than `via UDP (webrtc ready=false)`.

Note the opus payload type is **negotiated, not fixed**: Android libwebrtc offers 111,
werift offers 96. Anything that hard-codes a PT will work against one and not the other.

### H3 on the real device — it already worked (Aug 13–28)

Running `device-watch` over the archived logs settles what the harness could not. Between
**2026-08-13 and 2026-08-28 the real Pixel connected 57 times**, negotiating WebRTC with
**opus PT 111** (Android libwebrtc — werift offers 96, so these cannot be the harness). ICE
reached `connected` in the large majority, and the downlink logged **155 sends via WebRTC**
against 26 via UDP.

So Android libwebrtc, AudioTrack pacing and mic permissions are **not** unverified — the
August history is the evidence. What remains device-gated is much narrower: the bottom-bar
layout fix, widget tiles in the real WebView, and whether ICE still connects now that the
phone is **remote** (see below). The phone has not connected since 2026-08-28.

All 57 sessions carry **one** stable identity, `client_id=42c55608` — the persistent
`IdentityStore` keypair (app-private `SharedPreferences`, private key wrapped by
`AndroidKeyStore`). It survives an in-place update (`install -r`) and is regenerated only by
an uninstall/reinstall, which wipes both the prefs and the KeyStore alias. Run `device-watch`
for the full base64 SPKI.

### ICE reachability — `npm run ice-candidates`

`e2e-webrtc` connects over loopback, so it proves the media path and nothing about
reachability. This asks the live sidecar for an answer and reports what it offers to connect
on. Currently:

    host   udp  192.168.10.55    <- the Mac's LAN
    srflx  udp  129.222.139.201  <- public IP via STUN
    tailnet: NO      TURN relay: none configured

That LAN host candidate is almost certainly why August worked: the phone was on the same home
Wi-Fi. It does nothing for a **remote** phone, which can only reach this Mac at its tailnet
address — and the tailnet lives on a point-to-point `utun`, which ICE enumeration skips. With
no tailnet candidate and no TURN relay, a remote phone can only connect if the STUN srflx pair
is mutually reachable. When `tailscale ping` reports *"direct connection not established"* for
the phone, Tailscale has already failed to punch the same NAT, and WebRTC has no DERP to fall
back on.

Expected symptom: handshake fine, ICE never reaches `connected`, downlink silently falls back
to the WebSocket (`webrtc ready=false`).

**Fixed (host-side).** The sidecar now gathers the tailnet address as an additional host
candidate, so a remote phone gets a pair it can complete:

    agent id 2f087c6f ws://0.0.0.0:8123 ... ice=stun:stun.l.google.com:19302 tailnet-ice=100.125.53.51

    sidecar answer advertises 4 candidate(s):
      host   udp  100.125.53.51:56201   <- TAILNET (phone-routable)
      host   udp  192.168.10.55:58439
      srflx  udp  129.222.139.201:62296
      srflx  udp  129.222.139.201:11991

Neither side enumerates it unaided — the Tailscale interface is a point-to-point `utun`, which
ICE host enumeration skips, and Android libwebrtc has the same blind spot. But the phone CAN
route 100.x through its own Tailscale, so advertising it is enough. Addresses are detected from
100.64.0.0/10 (the CGNAT range Tailscale allocates from); `AGENTMOB_NO_TAILNET_ICE=1` opts out.

`AGENTMOB_ICE` also accepts a TURN entry with **inline credentials**
(`turn:user:pass@host:3478`), split into the `RTCIceServer` username/credential fields. The
credential never reaches a log line or the `ice` list handed to the phone. **STUN-only remains
the default and no relay is deployed** — adding one is a spend decision, not a code one.

`npm run ice-config` pins this contract down by booting the real sidecar on spare ports and
reading its startup line (19 assertions), including that the credential appears nowhere in
stderr. Note the ctl port var is `AGENTMOB_SIDECAR_PORT`, **not** `AGENTMOB_CTL_PORT`.

### The silent fallback now announces itself

When ICE does not come up, the sidecar used to say nothing: replies simply started carrying a
`via WS (webrtc ready=false)` suffix. Noticing that required reading the transport on every
reply line — which is exactly how H3 stayed broken unnoticed for weeks, and how a remote-ICE
failure would hide in the same way. The sidecar now logs, once per connection:

    webrtc ICE FAILED (never reached connected) — voice falls back to WS/UDP. ice=... tailnet-ice=...

It fires on a **deadline** (`AGENTMOB_ICE_DEADLINE_MS`, default 20s after the answer is sent),
not on an ICE state transition. That distinction was measured, not assumed: an offer carrying
only an unroutable candidate (192.0.2.1, RFC 5737) left the peer sitting at `connecting` for a
full 60 seconds with no further state at all. `failed` never arrives, and `closed` only lands
when the phone disconnects — by which time every reply has already gone out over the fallback.
A state-triggered warning would therefore have stayed silent for the entire broken session.

It reports on the DEADLINE only. An earlier version also reported on the ICE state reaching
`closed`/`failed`, which cries wolf: that transition is indistinguishable from an ordinary
disconnect — the phone backgrounding, or a diagnostic probe hanging up — so every run of
`ice-candidates` planted a false ICE FAILED in the log. An alert that fires on its own tooling
teaches everyone to ignore it. The deadline asks the honest question instead: *is ICE still not
up while the client is still here?* Only a real failure answers yes. The handler also skips any
connection that has already gone away, since it never had a chance to finish.

Verified in all three directions: it fires against a peer with only an unroutable candidate that
stays connected, a real `e2e-webrtc` run (ICE connected) produces zero such lines, and a run of
`ice-candidates` now leaves the count unchanged (4 before, 4 after). `device-watch` surfaces it as the
session verdict, since a session that handshakes and then quietly serves voice over WebSocket
looks healthy in every other field.

### Port conflicts — both listeners fail by name

Both of the sidecar's listeners once died on an unhandled `error` event with a raw stack, while
the adapter respawned them every 3 seconds — a log full of identical stack traces saying nothing
about the cause, at the worst possible moment.

The trigger was real, not hypothetical: stopping the gateway used to leave the node process
orphaned and still listening on 8123, so the next start collided with it. This was found by
doing exactly that.

**That source defect is now fixed** (see "The adapter reaps its sidecar" below), so the guard
below is the second line of defence rather than the only one.

The two ports get different treatment, because they mean different things:

| port | var | on conflict |
|---|---|---|
| ws 8123 | `AGENTMOB_PORT` | IS the service — cannot continue. Logs a named FATAL and exits **69** (EX_UNAVAILABLE); the adapter's respawn is the retry, so it self-heals the moment the orphan goes. Other socket errors exit **71**. |
| ctl 8790 | `AGENTMOB_SIDECAR_PORT` | OPTIONAL — keeps serving the phone without the ctl channel. |

To clear an orphan by hand:

    lsof -nP -iTCP:8123 -sTCP:LISTEN
    pkill -f agentmob/sidecar/index.mjs

`npm run port-in-use` holds each port with a real listener and starts the real sidecar against
it (13 assertions). It asserts on the ABSENCE of a raw unhandled error as well as the presence
of the named message — verified red without the guard: 5 assertions fail, including
`exit 1` instead of 69.

### The adapter reaps its sidecar

The adapter owns the sidecar, so it is responsible for taking it with it. It did not: any stop
that never reached `disconnect()` — `launchctl bootout`, a hard gateway kill — left a node
process orphaned and still holding :8123, blocking the next sidecar from binding at all.

Fixed on both sides, because no single side can cover every shutdown:

- **Adapter.** The sidecar is spawned with `start_new_session=True`, giving it its OWN process
  group, and is reaped through that group (SIGTERM, then SIGKILL). The group matters: the
  sidecar spawns ffmpeg and the STT/TTS helpers, and a bare `terminate()` reached only the node
  process. Every spawn is tracked, with an `atexit` + SIGTERM/SIGINT/SIGHUP backstop for the
  paths that skip `disconnect()`. Signalling is own-group only, so it can never reach the
  gateway or its siblings.
- **Sidecar.** A SIGKILL of the gateway cannot be intercepted by the adapter at all, so the
  sidecar also watches from its side: when its parent dies it is reparented to init, and on
  seeing `ppid === 1` it exits 0 rather than sit on the port. `AGENTMOB_NO_PARENT_WATCH=1`
  opts out when running it by hand from a shell you mean to close — this is called out in the
  README and in the sidecar's own file header, since it surprises you at the moment you run it,
  not at the moment you read the docs.

### The respawn loop escalates instead of wedging quietly

The adapter retried a dead sidecar every 3s forever, logging one identical line each time. A
sidecar that could never start — bad node binary, syntax error, permanently held port — produced
exactly the same log as a healthy supervisor doing its job, so a completely broken phone link
read as "supervised and healthy".

Now: consecutive FAST failures (dying in under `AGENTMOB_RESPAWN_HEALTHY_S`, default 10s) back
off exponentially from 3s to a 60s cap, each line naming the attempt number and the next delay.
After `AGENTMOB_RESPAWN_ESCALATE_AFTER` (default 5) it logs at ERROR with a greppable marker:

    AGENTMOB SIDECAR WEDGED: 5 consecutive failed starts, each dying in under 10s (last rc=1).
    The phone cannot connect and will not recover on its own. Retrying every 48s.
    Last sidecar output: [sidecar] FATAL: port 8123 is already in use ...

It carries the sidecar's own last output, so the log says WHY and not only THAT, and repeats
periodically rather than every attempt — silence hides it, and a line every few seconds trains
people to scroll past. A sidecar that ran a while and then died is an ordinary restart and never
trips it, and a cancellation (shutdown) is not counted as a failed start.

That counter only sees a sidecar that cannot **start**. One that starts, stays up past the
healthy threshold and then dies resets it every iteration — so an 11-second crash loop would
warn forever and never escalate. That shape is the likelier one (binds fine, dies on the first
real audio frame), so a second detector judges the **rate**, independent of uptime:
`AGENTMOB_RESPAWN_WINDOW_MAX` restarts (default 6) within `AGENTMOB_RESPAWN_WINDOW_S`
(default 600s) is flapping.

    AGENTMOB SIDECAR FLAPPING: 7 restarts in the last 600s (last ran 11.2s, rc=3). It starts
    but will not stay up, so the phone link keeps dropping. Backing off to 24s.
    Last sidecar output: ...

Backing off is the point: without it the loop keeps restarting at whatever period the crash
happens to have. The two alarms are deliberately distinct — WEDGED means "cannot start",
FLAPPING means "cannot stay up", and calling the second one WEDGED would be the wrong
diagnosis. The window is sized so one genuine crash, or a handful over days, never fires it.

There is a **slow tier** as well, because the fast window has a blind spot by construction: a
sidecar dying every ~2 minutes is 5 restarts per 600s — one under the threshold — so it would
never fire. `AGENTMOB_RESPAWN_SLOW_MAX` (12) over `AGENTMOB_RESPAWN_SLOW_WINDOW_S` (6h) catches
that tempo. One genuine crash a week is ~1 per 6h, nowhere near 12, so ordinary operation stays
quiet.

**Unsupervised tasks.** Every `asyncio.create_task` in the adapter was bare, which parks any
exception inside the task object and nowhere else. Two flavours of damage:

- `_connect_bridge` failing left the adapter holding a live sidecar it could not talk to, with
  an empty log.
- On the **speech path** (`flush_speak`, `dispatch_text`, `turn_timeout_watch`,
  `long_turn_ack`, `clear_speaking_after`) a swallowed exception is indistinguishable from the
  agent simply having nothing to say — the phone just goes quiet, and nothing anywhere
  disagrees.

`_supervise_task` attaches a done-callback logging `AGENTMOB TASK FAILED: <name> raised ...`.
Cancellation stays quiet: on the speech path a cancelled task is a barge-in superseding an older
reply, and logging that as an error would make the alarm meaningless.

`npm run respawn-escalation` covers all of it (51 assertions, timings compressed via
`AGENTMOB_RESPAWN_*`): the instant-death wedge, the stay-up-then-die flap, a failing bridge
task, the speech-path tasks driven through their REAL call site, the slow tier reloaded with
its own config so only it can fire, and the discrimination case — a single genuine crash must
fire NOTHING, or the rate window is just a wider net. Verified red without the changes:
11 assertions fail.

`npm run orphan-reap` drives the REAL adapter against a throwaway port (8871/8872 — never 8123,
and the live gateway is never touched) through all three shutdown paths: `disconnect()`, SIGTERM
to the host, and SIGKILL to the host. 10 assertions, including that the reaper leaves bystander
processes alone.

Both halves are load-bearing, verified by disabling each: without the watchdog the SIGKILL case
fails (2 assertions); without the adapter's tracking the SIGTERM case fails too (4).

### Drift: the plugin is gitignored, so it gets hashed instead

`~/.hermes/plugins/agentmob` is gitignored, so every fix made there lives on exactly one Mac.
A restore of that directory from a backup silently reverts all of it — the sidecar reaper, the
parent-death watchdog, both port guards, the ICE deadline, the downlink truncation logging, the
respawn escalation — and nothing would say so. It would present as the old bugs quietly coming
back, which is the hardest kind of regression to attribute.

`vendor/hermes-plugin/` holds a copy of the plugin source, and `npm run plugin-drift` hashes the
installed files against it, failing with a NAMED diff — which file, both hashes, and the first
differing lines:

    FAIL adapter.py: installed matches vendored
      DRIFT: installed 7f5225943bce != vendored f24256ab5ada (81741B vs 81832B)
        -340: start_new_session=True,
        +340: )

**Nothing is ever written into the plugin directory.** This is a comparison, not an installer;
whether to install from the vendored copies is a separate decision. `AGENTMOB_PLUGIN_DIR` points
the check at another tree, which is how the red test runs against a deliberately reverted COPY
without touching the real installation.

`npm run vendor-refresh` records an intentional plugin change (installed -> repo, one direction
only). Without a sanctioned way to update, the only way to silence the check would be to ignore
it, which is how a check stops meaning anything.

**`sidecar/.identity.json` is never vendored.** It holds the sidecar's persistent server
keypair, private key included, and the phone PINS that public key on first pairing — it is both
a secret and live state. The check asserts its absence from `vendor/` rather than relying on
the copy list being right.

### The loopback bridge heals itself

The adapter talks to the sidecar over a loopback control socket. If that socket dies while the
sidecar keeps running, the adapter is deaf and mute — no audio events in, no pushes out — and
the phone simply goes silent.

A closed socket was already survivable: `_consume_inbound` returns on EOF and the loop
reconnects (measured ~22ms even before this change). What was NOT survivable was an unexpected
exception: `except Exception: logger.debug(...); return` ended the bridge permanently, at debug
level so nothing visible said so, and only a sidecar RESPAWN would ever build a new one.
Supervising the task made that death visible — but visible and still broken is not recovery.

Now the bridge retries for as long as the sidecar is alive, with backoff
(`AGENTMOB_BRIDGE_BASE_S` 0.25s to `AGENTMOB_BRIDGE_MAX_S` 5s, reset on a successful connect),
logging losses at WARNING rather than debug and escalating after
`AGENTMOB_BRIDGE_ESCALATE_AFTER` (8):

    AGENTMOB BRIDGE DOWN: 8 failed reconnects to the sidecar ctl port 8790. The sidecar is
    running but the adapter cannot talk to it, so the phone gets no replies.

It still exits when the sidecar is gone, because `_run_sidecar` starts a fresh bridge with each
spawn and two bridges racing would be worse.

**A failing handler is not a broken socket.** `_consume_inbound` used to wrap the socket read
and the event handler in ONE try block and `break` at debug level, so an event the handler
choked on tore down a perfectly healthy connection: reconnect, read the same kind of event,
choke again — connect, read, throw, reconnect, forever, with the cause recorded only at debug.
The log showed bridge churn and nothing about why. The two are now separated: a socket error
ends the read loop (reconnecting, which is right), while a handler error is logged at WARNING
naming the event type and the loop CONTINUES to the next event. After
`AGENTMOB_INBOUND_ERROR_ESCALATE` (5) consecutive failures it escalates, and one success resets
the counter so an occasional bad event stays a warning:

    AGENTMOB INBOUND HANDLER FAILING: 5 consecutive events raised, the latest a 'audio'
    (KeyError: 'path'). Nothing from the phone is being processed. The bridge is healthy —
    this is a handler bug, not a connection problem.

`npm run inbound-resilience` drives the real `_consume_inbound` against a stand-in ctl server
(the real sidecar emits nothing without a phone) and counts ACCEPTED CONNECTIONS, which is what
separates the behaviours: 15 assertions. Verified red: the old code reconnected **6 times for 6
bad events** with zero warnings, i.e. the socket paying for a handler bug, invisibly.

**`_consume_inbound` also re-raises `CancelledError` instead of breaking.** Swallowing it hid the
cancellation from `_connect_bridge`, which treated it as an ordinary socket loss and reconnected
forever — the task could never be stopped and shutdown hung. That only became visible once the
bridge stopped giving up on errors.

`npm run bridge-recovery` runs a REAL sidecar on throwaway ports, breaks the bridge mid-run and
measures the recovery: ~110ms for a closed socket, ~219ms after an injected unexpected
exception, twice in a row, with the sidecar's pid unchanged throughout and traffic (write +
drain) resuming. 20 assertions. Verified red against the original bridge: 4 fail, the decisive
one being *"an UNEXPECTED exception is not terminal for the bridge — bridge died permanently"*.

### The delivery boundary: retry only what provably never arrived

`dispatch_text` carries the user's actual speech. Dropping it means they spoke, the phone heard
them, and nothing ever answered — worth retrying. But `handle_message()` hands the turn to
Hermes and returns immediately, so a failure raised from INSIDE it leaves delivery **uncertain**,
and retrying there risks the agent answering twice. A double answer is worse than a drop: the
user hears two replies to one question and cannot tell which is current.

The boundary is explicit in the code, not implied. `delivery_uncertain` flips on the last line
before the call:

- **False** — the failure happened while still preparing. Provably pre-delivery: retried once,
  logged at WARNING.
- **True** — delivery is unknown, and unknown is treated as delivered. Never retried, logged at
  ERROR with the lost utterance so it is not merely gone.

All preparation lives INSIDE the try for that reason. It used to sit above it, which made the
pre-delivery branch unreachable — anything raising there escaped `dispatch_text` entirely, so
the utterance was neither retried nor reported. The test caught that.

An unknown sidecar `event type` is also no longer dropped in silence: the adapter and sidecar
are versioned separately (the sidecar is not even in this repo), so a sidecar emitting something
new is a realistic way for the two to drift apart unnoticed.

`npm run dispatch-delivery` — 20 assertions, including that the two sides of the boundary behave
DIFFERENTLY (a version retrying both, or neither, would pass a sloppier test) and that
`_handle_sidecar_event` contains no try/except that could eat `_consume_inbound`'s warning.
Verified red: 9 fail, among them *"uncertain and pre-delivery were treated the same"*.

### Pinning the phone — one line, after a confirmed connection

Client pinning is config-driven via `~/.hermes/config.yaml`:

    platforms:
      agentmob:
        extra:
          # allowed_clients: "42c55608"
          # ice: "stun:...,turn:user:pass@relay.example:3478"

The adapter reads `extra.allowed_clients` (falling back to `AGENTMOB_ALLOWED_CLIENTS`) and
exports it to the sidecar **only when set**, so the default stays PAIRING MODE. It is left
UNPINNED on purpose: a stale id locks the phone out and the phone is the way back in. The
archives name `42c55608` across all 57 August sessions, but nothing has connected since
2026-08-28, so confirm it first — run `device-watch`, open the app, and it prints the exact
`AGENTMOB_ALLOWED_CLIENTS=<id>` to uncomment.

What still genuinely needs the device: AudioTrack behaviour under the new bottom-bar layout,
widget tiles in the real WebView, and a remote-network ICE run.

### Watching for the real device — `npm run device-watch`

adb needs Wireless debugging switched on at the phone, which needs Terra at the phone. The
handshake does not: the phone dials **out** to the sidecar, so a real connection leaves a
trail in `~/.hermes/logs/gateway.log` whether or not anyone is watching. Leave `device-watch`
running, open the app, and it writes `test/audit/out/device-watch.json`.

It tells a real device from the harness by the negotiated opus PT above — **111 means Android
libwebrtc, 96 means werift** — so it cannot mistake my own fake phone for on-device proof. It
also captures the `PAIRING: client <id> identity=<b64>` line, which is the **live** phone
identity and the only safe input to `AGENTMOB_ALLOWED_CLIENTS`. Pinning a stale id locks the
phone out, and the phone is the way back in.

`npm run device-watch-test` drives the classifier against synthetic logs before any of that is
trusted.

#### Local sidecar fix this depends on (NOT in this repo)

`~/.hermes/plugins/agentmob/sidecar/index.mjs` is gitignored, so this change lives only on the
host and is recorded here instead. In `handleBridgeMessage`, the reply-playback `finish()` logs
the one line that says which transport served the downlink:

    → phone pcm <bytes>b -> <n> opus packets via WebRTC|UDP|WS

Every early return skipped it. `sendW` bails out on `tok.cancelled || !webrtc.connected`, and
the raw path on `tok.cancelled`, so any playback cut short by a barge-in, the app backgrounding,
an ICE drop or a disconnect logged **nothing at all** — losing the transport record for exactly
the cases worth inspecting. `finish(note)` is now idempotent (a `logged` flag) and is called on
those paths too, appending e.g.

    [cut short after 119/148 frames: peer gone (ICE drop/disconnect)]

This is why the historical log looked so sparse: the only two `via WebRTC` lines ever recorded
were the two sends that happened to run to completion. If the sidecar is ever restored from a
backup, reapply this or `device-watch` will under-report the downlink transport.

## Trust boundary

- The channel is **AEAD-authenticated** (ChaCha20-Poly1305); only the session-key holder can
  inject ops or code. No keyless code can reach the webview.
- The webview is **egress-free** (`connect-src 'none'`, deny-all `WebViewClient`): code the
  agent ships cannot phone home or load remote assets — the asset store is the only source.
- **Mic, stop, and the reply indicator are native**, outside the webview, so even a hostile
  or buggy widget cannot toggle the mic or stop the agent. This is what lets the webview be
  flexible.
- A storage cap (configurable in app settings) bounds how much shipped code/data can
  accumulate on-device.

## Phase plan

1. **Wire protocol + host runtime** — ✓ `surface-core.js` + `surface-host.js` handle every
   op (register/add/update/remove/publish/test), the sandboxed tile runtime, the storage cap,
   and `render_result` render feedback. Tested 15/15.
2. **Native chrome** — round animated mic + stop + reply indicator as native overlays OUTSIDE
   the webview. **Deferred by decision**: the established preference is mic+stop as components
   over the wire (they ride the channel like any component, backed by the native mic-consent gate).
   The native reply/speaking indicator is instead delivered via the status strip (Phase 3/4,
   `{type:'status'}`: heartbeat, mic level, heard, working).
3. **Adapter surface tool** — ✓ `adapter.py`: the agent emits `surface` ops via a
   `{"__surface__": ops}` reply; `render_result` feedback routes back to the agent on its next
   turn (`[render key=ok|FAILED: err]`). `_publish_surface` guards malformed/oversized batches.
4. **Skill** — ✓ `agentmob-render-components`: register → test → build → publish loop, storage
   cap, status-strip chrome documented.
