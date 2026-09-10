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

What this does NOT cover: Android's own libwebrtc (ICE behaviour over the Tailscale
userspace TUN, AudioTrack pacing, mic permissions). Those still need the device.

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
