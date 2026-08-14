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

Each registered widget type is a JS module exposing `render(el, props)` returning a cleanup
(or a subscription handle):
```js
registerWidgetType('avatar', function (el, props) {
  el.innerHTML = '<img class="avat">';
  return { onData: function (data) { /* update in place */ } };
});
```
- `add_widget` → `render(el, props)`.
- `publish` → calls the instance's `onData(data)` (no full re-render).
- `remove_widget` → calls `onDestroy()` and drops the tile.

The host passes an isolated tile element per widget key. Registered assets are available to
tile code by name; the host loads them lazily on first use.

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
