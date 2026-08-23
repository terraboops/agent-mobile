// udp-media.js — UDP media transceiver for the spotty-cellular transport path.
//
// Audio moves off WebSocket/TCP onto a UDP RTP-style socket (see
// docs/udp-media-transport.md). Security stays on the EXISTING ChaCha20-Poly1305
// proto Channel — each UDP datagram is one authenticated box; the nonce rides in
// the frame. UDP uses its OWN nonce stream (stream 1) with a per-stream counter
// and anti-replay window, so WS stalls and UDP reordering never interfere.
//
// Wire layout per UDP datagram (authenticated plaintext):
//   [ kind u8 ][ seq u32 ][ tsMs u64 ][ opus ... ]
//   kind: 0 = mic uplink (phone->gateway), 1 = reply downlink (gateway->phone)
//        2 = probe/ack: phone sends kind-2 probes until it receives an
//            authenticated kind-2 ack (echoing the probe seq) — only then does
//            it flip its uplink to UDP. The ack proves Bidirectional reach.
//
// The receiver funnels frames through the AdaptiveJitterBuffer so playout is
// ordered, gap-concealed (PLC), and always pre-buffered — the reliability core.
//
// API
//   const m = new UdpMedia({ channel, allow: (rinfo)=>bool });
//   await m.start(port, host);       // binds, resolves m.port
//   m.on('media', ({kind, seq, tsMs, frame, concealed}) => …)
//   m.send({ kind, seq, tsMs, opus, addr, port })   // seals + sends
//   m.close();
//
// `concealed:true` marks a frame the sender lost — the consumer runs Opus PLC,
// never silence. `frame` is the raw opus bytes for real frames, null otherwise.
import { createSocket } from 'node:dgram';
import { unpack, T } from './wsframes.js';
import { STREAM_UDP } from '../proto.js';

export class UdpMedia {
  constructor({ channel, allow = () => true, respondToProbes = true }) {
    this.channel = channel;               // proto.Channel (AEAD)
    this.allow = allow;                   // authz: who may reach this media port
    this.respondToProbes = respondToProbes; // gateway acks kind-2 probes; phone (Java) does not
    this.socket = createSocket('udp4');
    this.port = 0;
    this.jb = null;                       // adaptive jitter buffer (created on first frame)
    this._handlers = new Map();
    this._next = null;                    // first seq seen -> stream anchor
    this._firstReq = null;                // most recent AUTHENTICATED sender (rinfo) for replies
    this.lastKind = 0;                    // kind of the most recent frame (diagnostics)
    this.lastTsMs = 0;
    this._tick = null;
  }

  on(evt, fn) { (this._handlers.get(evt) || this._handlers.set(evt, []).get(evt)).push(fn); }
  _emit(evt, ...args) { for (const fn of this._handlers.get(evt) || []) { try { fn(...args); } catch (e) { /* swallow */ } } }

  start({ port = 0, host = '0.0.0.0' } = {}) {
    return new Promise((resolve, reject) => {
      this.socket.on('error', reject);
      this.socket.on('message', (msg, rinfo) => {
        try { this._onDatagram(msg, rinfo); } catch (e) { this._emit('error', e); }
      });
      this.socket.bind(port, host, () => {
        this.port = this.socket.address().port;
        this._tick = setInterval(() => { if (this.jb) this.jb.tick(); }, 1000);
        if (this._tick.unref) this._tick.unref();
        resolve(this);
      });
    });
  }

  _onDatagram(msg, rinfo) {
    if (!this.allow(rinfo)) return;
    // Nothing below may throw out of the dgram handler: an unauthenticated peer
    // sending one junk datagram must not be able to crash the receiver.
    let pt = null;
    try {
      const f = unpack(msg);
      pt = this.channel.recvBytes(f);       // AEAD + per-stream anti-replay (stream 1 = UDP)
    } catch { pt = null; }
    if (pt === null) { this._emit('authfail', rinfo); return; }   // AEAD is the real gate
    if (pt.length < 13) return;
    const kind = pt[0];
    const seq = pt.readUInt32BE(1);
    const tsMs = Number(pt.readBigUInt64BE(5));
    const opus = Buffer.from(pt.subarray(13));
    // Learn / refresh the reply peer from the newest FRESH authenticated datagram
    // (replayed frames never get here, so a captured packet from a spoofed source
    // cannot redirect the downlink; a NAT rebind or network switch is followed).
    const prev = this._firstReq;
    if (!prev || prev.address !== rinfo.address || prev.port !== rinfo.port) {
      this._firstReq = rinfo; this._emit('peer', rinfo);
    }

    // Probe (kind 2, phone->sidecar)? Ack it and do NOT feed the jitter buffer.
    // The phone flips to UDP uplink only after it sees this authenticated ack.
    if (kind === 2) {
      if (this.respondToProbes) this.ack({ to: rinfo, seq });
      this._emit('probe', { seq, from: rinfo });
      return;
    }

    if (this.jb === null) this.jb = new AdaptiveJitterBuffer({ frameMs: 20 }); // TODO: per-stream
    this.lastKind = kind;
    this.lastTsMs = tsMs;
    this.jb.push(seq, tsMs, { kind, opus });   // frame carries ITS OWN kind (not the latest one's)
    this.pump();
    this._emit('rcv', { kind, seq, tsMs, from: rinfo });
  }

  // Authenticated kind-2 ack back to the sender. Echoes the probe seq so the
  // phone can correlate; genuine-ness is guaranteed by AEAD (only a peer with
  // the session key can mint a box that decrypts here and back on the phone).
  ack({ to, seq, kind = 2 }) {
    const body = Buffer.alloc(13);
    body[0] = kind;
    body.writeUInt32BE(seq, 1);
    body.writeBigUInt64BE(BigInt(Date.now()), 5);
    const box = this.channel.send(body, T.audio, STREAM_UDP);
    const wire = Buffer.alloc(1 + box.nonce.length + box.tag.length + box.ct.length);
    wire[0] = T.audio;
    box.nonce.copy(wire, 1);
    box.tag.copy(wire, 1 + 12);
    box.ct.copy(wire, 1 + 12 + 16);
    this.socket.send(wire, to.port, to.address);
    return true;
  }

  // Pump the jitter buffer: emit ordered frames (or PLC markers) to consumers.
  // `nowMs` injectable so tests can drive the playout clock deterministically.
  pump(nowMs = Date.now()) {
    if (!this.jb) return;
    let out;
    while ((out = this.jb.pull(nowMs))) {
      const f = out.frame;   // { kind, opus } or null (concealed)
      this._emit('media', { kind: f ? f.kind : this.lastKind, seq: out.seq, tsMs: out.tsMs,
                            frame: f ? f.opus : null, concealed: out.concealed });
    }
  }

  // Seal and send one media frame over UDP.
  send({ kind, seq, tsMs, opus, addr, port }) {
    if (!addr || !port) return false;
    const body = Buffer.alloc(13 + opus.length);
    body[0] = kind;
    body.writeUInt32BE(seq, 1);
    body.writeBigUInt64BE(BigInt(tsMs), 5);
    opus.copy(body, 13);
    const box = this.channel.send(body, T.audio, STREAM_UDP); // UDP stream counter, type as AAD
    const wire = Buffer.alloc(1 + box.nonce.length + box.tag.length + box.ct.length);
    wire[0] = T.audio;
    box.nonce.copy(wire, 1);
    box.tag.copy(wire, 1 + 12);
    box.ct.copy(wire, 1 + 12 + 16);
    this.socket.send(wire, port, addr);
    return true;
  }

  get learnedPeer() { return this._firstReq; }
  close() { if (this._tick) clearInterval(this._tick); try { this.socket.close(); } catch {} }
}

import { AdaptiveJitterBuffer } from './adaptive-jitter.js';
