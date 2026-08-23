// adaptive-jitter.js — NetEQ-style adaptive jitter buffer for the UDP media path.
//
// The receiver-side primitive that makes audio hold together over spotty
// cellular. Principles from WebRTC's NetEQ (see docs/udp-media-transport.md):
//   1. ALWAYS buffer a baseline — jitter is normal, even on a clean link.
//   2. Grow the target playout depth on observed loss / jitter spikes.
//   3. Decay back toward baseline when the link is stable.
//   4. Never play silence for a gap — emit a `concealed` marker so the Opus
//      decoder can run packet-loss concealment (or the caller can conceal).
//
// Pure logic, no I/O — importable by the Node sidecar and portable to the
// Android Java side. Frames are opaque (Opus boxes); the caller decodes them
// and maps `concealed:true` markers to decoder PLC.
//
// Playout model (turn-based + short-utterance friendly):
//   * Before starting, hold until `target` frames are buffered (the pre-buffer).
//   * Once started, emit the next seq in order as soon as it lands; never emit
//     out of order.
//   * When a loss spike raises `target`, briefly re-hold available frames to
//     re-establish playout depth (grow the buffer), with a hard deadline so we
//     never stall indefinitely.
//   * A seq past its deadline is emitted as a `concealed:true` marker (PLC),
//     advancing playout — never a backing-up stall.
//
// API
//   const jb = new AdaptiveJitterBuffer({ baselineFrames, maxFrames, frameMs });
//   jb.push(seq, tsMs, frame);   // feed a received packet (may reorder)
//   jb.pull(nowMs) ->            // next frame to play, or null to wait
//     { seq, frame, tsMs, concealed:false }
//     { seq, frame:null, tsMs:null, concealed:true }
//   jb.tick()                    // once per second: loss-penalty decay
//   jb.stats() -> { target, lost, concealed, droppedLate, buffered, started }

export class AdaptiveJitterBuffer {
  constructor({ baselineFrames = 6, maxFrames = 60, frameMs = 20, maxHoldMs = 80, reholdMs = 100 } = {}) {
    this.baseline = baselineFrames;
    this.max = maxFrames;
    this.frameMs = frameMs;
    this.maxHoldMs = maxHoldMs;  // wait for a late packet before concealing
    this.reholdMs = reholdMs;     // hard cap on a re-buffering hold

    this.buf = new Map();        // seq -> frame (opaque)
    this.next = null;            // next seq to emit
    this.target = baselineFrames;
    this.started = false;

    this._prevTsMs = null;
    this._prevSeq = null;
    this._ewmaJitterMs = 0;
    this._lossPenalty = 0;
    this._lossTimer = 0;

    this._waitingSince = 0;      // monotonic time when a pre-buffer wait began
    this._waitingForLate = new Map(); // seq -> ms waited for a late packet

    this.lost = 0;
    this.concealed = 0;
    this.droppedLate = 0;
  }

  push(seq, tsMs, frame) {
    if (this.next !== null && seq < this.next) {
      this.droppedLate++; // arrived past its play-out seq; drop
      return;
    }

    if (this._prevTsMs !== null && this._prevSeq !== null && seq > this._prevSeq) {
      const gapMs = tsMs - this._prevTsMs;
      const expected = (seq - this._prevSeq) * this.frameMs;
      const spike = Math.abs(gapMs - expected);
      this._ewmaJitterMs = this._ewmaJitterMs === 0
        ? spike
        : 0.75 * this._ewmaJitterMs + 0.25 * spike;
    }

    if (this._prevSeq !== null && seq > this._prevSeq + 1) {
      const skipped = seq - this._prevSeq - 1;
      this.lost += skipped;
      this._lossPenalty = Math.min(10, this._lossPenalty + skipped);
      this._lossTimer = 500;
    }
    this._prevTsMs = tsMs;
    this._prevSeq = seq;

    this.buf.set(seq, { frame, tsMs });
    if (this.next === null) this.next = seq;
    // Bound the buffer: a huge forward jump (sender reset / long stall) or overflow must not
    // grow memory or make the playout spend minutes concealing the gap — jump to the live edge.
    if (seq - this.next > this.max * 4) {
      this.droppedLate += Math.max(0, this.buf.size - 1);
      for (const k of this.buf.keys()) if (k < seq) this.buf.delete(k);
      this.next = seq; this.started = false; this._waitingForLate.clear();
    } else if (this.buf.size > this.max) {
      let lowest = Infinity; for (const k of this.buf.keys()) if (k < lowest) lowest = k;
      this.droppedLate += Math.max(0, lowest - this.next);
      this.next = lowest; this._waitingForLate.clear();
    }

    const jitterFrames = Math.ceil(this._ewmaJitterMs / this.frameMs);
    this.target = Math.min(this.max, this.baseline + jitterFrames + this._lossPenalty);
  }

  pull(nowMs) {
    if (this.next === null) return null;

    const cur = this.buf.get(this.next);
    if (cur !== undefined) {
      // Have the next frame. Only gate at START (pre-buffer to `target`), with
      // a hard deadline so we can't stall on an empty start. Once started we
      // emit in order immediately — real-time arrival (not a per-frame gate)
      // maintains continuous playout.
      if (!this.started) {
        const depth = this._runAhead();
        if (depth < this.target) {
          if (this._waitingSince === 0) this._waitingSince = nowMs;
          if (nowMs - this._waitingSince < this.reholdMs) return null;
        }
        this._waitingSince = 0;
        this.started = true;
      }
      this.buf.delete(this.next);
      this._waitingForLate.delete(this.next);
      const seq = this.next;
      this.next++;
      return { seq, frame: cur.frame, tsMs: cur.tsMs, concealed: false };
    }

    // Next seq not here yet — late-in-transit or lost.
    const waited = (this._waitingForLate.get(this.next) || 0) + this.frameMs;
    this._waitingForLate.set(this.next, waited);
    if (waited <= this.maxHoldMs) return null; // give it a chance to land

    // Past deadline: conceal this seq (caller runs PLC) and advance.
    this._waitingForLate.delete(this.next);
    this._waitingSince = 0;
    this.started = true;
    const seq = this.next;
    this.next++;
    this.concealed++;
    return { seq, frame: null, tsMs: null, concealed: true };
  }

  // Call ~once per second (UdpMedia does): decays the loss penalty so `target` returns
  // to baseline after a burst instead of staying inflated for the whole session.
  tick(nowMs) {
    if (this._lossTimer > 0) {
      this._lossTimer -= 1000;
      if (this._lossTimer <= 0) this._lossPenalty = 0;
    }
  }

  _runAhead() {
    let n = 0;
    for (let s = this.next; this.buf.has(s); s++) n++;
    return n;
  }

  stats() {
    return {
      target: this.target,
      baseline: this.baseline,
      lost: this.lost,
      concealed: this.concealed,
      droppedLate: this.droppedLate,
      buffered: this.buf.size,
      started: this.started,
    };
  }
}
