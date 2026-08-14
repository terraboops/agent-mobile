# UDP Media Path — adaptive transport for spotty cellular

Status: foundation. Research-backed design for moving the real-time audio on
agent-mobile off WebSocket/TCP onto a UDP RTP-style media path, mirroring what
WebRTC/mobile carriers do for voice.

## Why (evidence)
- WebSocket = TCP. On lossy/mobile links TCP's **head-of-line blocking** stalls
  the whole stream behind one lost segment (200ms–2s staleness), which reads as
  choppy/robotic audio. Every real-time voice system uses UDP/RTP, not TCP.
- Receivers MUST run an **adaptive jitter buffer** (WebRTC NetEQ is the reference):
  always buffer a baseline, resizing the target to live network statistics —
  grow on jitter spikes / packet loss, decay toward baseline when stable.
  Zero buffering until a failure is "detected" is the naive design that stutters.
- Missing frames are **concealed** (PLC) rather than played as silence;
  silence insertion is the worst option (audible clicks). Opus has built-in PLC
  and in-band FEC (LBRR) for isolated losses.

## Architecture
- KEEP the AEAD WebSocket for control: handshake/consent, text, images, commands,
  signaling. It is not real-time; it tolerates TCP.
- ADD a **UDP media socket** for audio only, carrying RTP-ish packets.
- AEAD: reuse the existing `proto.js Channel` (ChaCha20-Poly1305). Each UDP
  datagram is one `channel.send()` box — the nonce rides in the frame, and the
  sequential `tx` counter keeps nonces unique across WS+UDP sends. No crypto
  rework; stays on audited primitives.
- Framing per UDP packet (authenticated plaintext):
  `[kind u8][seq u32][tsMs u64][opus bytes]`
  - kind: 0=mic uplink, 1=reply downlink, 2=info/RTCP-ish
  - seq: for jitter-buffer ordering + loss detection + PLC
  - tsMs: sender clock, for jitter/arrival-time estimation

## NAT / addressing (on Tailscale)
Phone and gateway both hold routable `100.x` addresses, so P2P UDP works with no
STUN: the gateway advertises its media UDP port in the WS hello; the phone sends
its first datagram to it, and the gateway replies to the learned
`IP:port` from the datagram. Direct-mode over Tailscale or same-LAN.

## Adaptive jitter buffer (this is the reliability core)
NetEQ-style, ported to both endpoints:
- Always buffer a baseline (e.g. ~6 frames = 120ms).
- Track EWMA of inter-arrival jitter; derive `target = baseline + jitter_budget + loss_penalty`.
- On a detected seq gap (loss): immediately raise the target (grow the buffer).
- When stable, decay the target back toward baseline.
- Playout pulls frames in seq order; a gap that is within the jitter budget is
  waited for; a gap past its deadline is **concealed with PLC**
  (repeat-and-fade last frame) — never silence.
- Both directions get one: phone downlink (reply playback) and sidecar uplink
  (before VAD/STT).

## Opus resiliency
- Decoder PLC on missing frames (phone: Concentus; sidecar: opusscript).
- Enable Opus in-band FEC (LBRR) on the encoder when measured loss > ~1%.

## Congestion control (phase 2)
Feedback loss/EWMA stats back over the control channel; adapt Opus bitrate and
packet cadence downward under sustained loss.

## Milestones
- [x] Research + design (this doc)
- [~] `transport/adaptive-jitter.js` + offline self-test (prove order/PLC)
- [ ] Node sidecar UDP receiver wiring (kind/seq/ts -> buffer -> VAD/STT)
- [ ] Android UDP socket (DatagramSocket) + same buffer + Concentus PLC
- [ ] In-band FEC + congestion adaptation
- [ ] On-device E2E over Tailscale
