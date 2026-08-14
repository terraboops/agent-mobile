# agentmob

**agentmob** is the agent-mobile platform: a phone that acts as a secure, hands-free
remote into Hermes — the agentic loop that holds your tools, memory, and models. The
phone stays deliberately dumb and egress-free. Every byte it shows or speaks arrives
over an authenticated channel (ChaCha20-Poly1305 across WebSocket and a UDP media path
built for unreliable cellular), and every capability it exposes — the microphone above
all — is gated by explicit native consent and signed by an unforgeable identity badge.
Voice flows both ways in real time through Opus, an onset-safe VAD, plug-loss
concealment, and an adaptive jitter buffer, so conversations survive the real-world
connections they run on. And because the phone renders a declarative component surface
rather than raw text, an agent can show you anything — a list, a forecast chart, a live
dashboard, an arbitrary sandboxed visualization — as something you see and hear, not
just read. agentmob is the smallest, most trustworthy window you can put around your
agent, in your hand.

## Elevator pitch

agentmob turns any phone into a keyless, egress-free voice remote for your own Hermes
agent. It ships your mic and your agent's replies over an authenticated, low-latency
media path — Tailscale-private, AEAD-secured, jitter-tolerant on bad cellular — and
renders the agent's output as rich live components, not plain text. No separate brain,
no cloud sidecar, no token to leak: the phone is just a secure window into your agent's
hands.

## Features

### A voice remote into the agentic loop
Your phone becomes a hands-free terminal for a real agent — your agent — with your
tools, memory, persona, and models. Speak, and the agent does real work and answers by
voice, components, or both.

### Security is the point, not an afterthought
- **Egress-free webview** — the phone renders only data it receives; a deny-all
  `WebViewClient` + strict CSP (`connect-src 'none'`) mean it can never reach the
  network on its own.
- **Keyless, AEAD-authenticated channel** — ChaCha20-Poly1305 signs every message; only
  a session-key holder can inject data. No static tokens.
- **Per-capability native consent** — mic access is granted deliberately, not silently.
- **Unforgeable identity badge** — a native overlay shows who you're connected to; the
  webview cannot fake it.
- Transport stays private over **Tailscale** (VPN/egress rejected).

### Real-time, full-duplex voice, built for spotty cellular
- Opus 20 ms frames both ways, with native VAD.
- **Burst-and-buffer downlink** — your reply is pre-buffered and drains at real-time, so
  jitter can't chop it.
- An **adaptive jitter buffer + packet-loss concealment** on the UDP media path; a
  **probe/ack handshake** only engages UDP once it's proven bidirectional (always falls
  back to WS).
- **Seq-gap loss detection** flags a clip as `lossy` so the agent knows audio may have
  dropped and asks you to repeat rather than guessing.
- **Onset-safe VAD** — low-energy leading consonants ("TH" in "three") are preserved, so
  the first syllable isn't clipped.

### Crisp understanding and speech
- STT via **mlx-whisper** (MLX-native, under a second on an M4 Max).
- TTS via **piper** (fully local; no cloud), with an opt-in KittenTTS preview.

### The phone is a component surface, not a chat box
- Any information is shown as a declarative component over the wire — `title`, `text`,
  `list`, `image`, ApexCharts `chart`, `svg`, or an arbitrary **sandboxed `viz`** running
  any JS a whim brings.
- The webview is a dumb renderer; the agent composes everything; the adapter auto-converts
  stray files into components (or fails them, so the agent corrects itself).

### Feels alive and controllable
- Live status strip: mic pickup level, heartbeat, "heard you," and agent
  working-with-progress.
- **Stop** interrupts the current turn; **Start-new/Resume** on open controls session
  lifecycle (so the agent reloads its skills).
- Keepalive + partition buffering + auto-reconnect survive a flaky link.

## Layout

```
agent-mobile/
  android/          # Pure-Java Capacitor app (no NDK), full-duplex AudioService, UDP media
  www/              # Egress-free webview: bridge.js, renderer.js, ApexCharts bundle
  transport/        # UDP media + adaptive jitter buffer (+ offline tests)
  docs/             # design notes (udp-media-transport.md, ...)
```

The Hermes side lives in the `agentmob` gateway plugin: `adapter.py` (TTS/STT, component
publishing, session control) and a Node `sidecar` (the encrypted WS + UDP transport edge).

## Status

Active prototype. Voice transport, AEAD security, and the component surface are working
end-to-end. The display is moving to the **on-demand surface model** ([docs/display-surface.md](docs/display-surface.md)):
the phone becomes a Dashing-style persistent widget surface where the agent **ships widget
code/assets over the channel**, registers them (with a storage cap), and feeds them event-keyed
data — with mic, stop, and the reply indicator as the only fixed native chrome outside the webview.
