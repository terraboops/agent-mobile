package com.agentmobile.agent;

import java.util.HashMap;
import java.util.Map;

/**
 * AdaptiveJitterBuffer — NetEQ-style adaptive jitter buffer, ported 1:1 from
 * transport/adaptive-jitter.js (see docs/udp-media-transport.md).
 *
 * Receiver-side primitive for the UDP media path: ALWAYS pre-buffers a baseline,
 * grows on observed loss / jitter spikes, plays in strict seq order, and emits a
 * `concealed` marker for a lost frame so the caller can run Opus PLC — never a
 * silence hole.
 *
 * Frames are opaque (Opus boxes). `pull` returns a {@link Frame}: either a real
 * frame or {@code concealed=true} with a null buffer, meaning "decoder PLC".
 */
public final class Ajb {
    public static final class Frame {
        public final long seq;
        public final byte[] opus;   // null when concealed
        public final boolean concealed;
        Frame(long seq, byte[] opus, boolean concealed) { this.seq = seq; this.opus = opus; this.concealed = concealed; }
    }

    private final long baseline;
    private final long max;
    private final long frameMs;
    private final long maxHoldMs;   // wait for a late packet before concealing
    private final long reholdMs;    // hard cap on the start pre-buffer hold

    private final Map<Long, byte[]> buf = new HashMap<>();
    private Long next;              // next seq to emit
    private long target;
    private boolean started;

    private long prevTsMs = -1;
    private Long prevSeq = null;
    private double ewmaJitterMs = 0;
    private long lossPenalty = 0;
    private long lossTimer = 0;

    private long waitingSince = 0;
    private final Map<Long, Long> waitingForLate = new HashMap<>();

    public long lost = 0, concealed = 0, droppedLate = 0;

    public Ajb() { this(6, 60, 20, 80, 100); }
    public Ajb(int baselineFrames, int maxFrames, int frameMs, int maxHoldMs, int reholdMs) {
        this.baseline = baselineFrames; this.max = maxFrames; this.frameMs = frameMs;
        this.maxHoldMs = maxHoldMs; this.reholdMs = reholdMs; this.target = baselineFrames;
    }

    public synchronized void push(long seq, long tsMs, byte[] frame) {
        if (next != null && seq < next) { droppedLate++; return; } // too late
        if (prevSeq != null && seq > prevSeq) {
            long gapMs = tsMs - prevTsMs;
            long expected = (seq - prevSeq) * frameMs;
            double spike = Math.abs(gapMs - expected);
            ewmaJitterMs = ewmaJitterMs == 0 ? spike : 0.75 * ewmaJitterMs + 0.25 * spike;
        }
        if (prevSeq != null && seq > prevSeq + 1) {
            long skipped = seq - prevSeq - 1;
            lost += skipped;
            lossPenalty = Math.min(10, lossPenalty + skipped);
            lossTimer = 500;
        }
        prevTsMs = tsMs; prevSeq = seq;
        buf.put(seq, frame);
        if (next == null) next = seq;
        long jitterFrames = (long) Math.ceil(ewmaJitterMs / frameMs);
        target = Math.min(max, baseline + jitterFrames + lossPenalty);
    }

    public synchronized Frame pull(long nowMs) {
        if (next == null) return null;
        byte[] cur = buf.get(next);
        if (cur != null) {
            if (!started) {
                long depth = runAhead();
                if (depth < target) {
                    if (waitingSince == 0) waitingSince = nowMs;
                    if (nowMs - waitingSince < reholdMs) return null;
                }
                waitingSince = 0; started = true;
            }
            buf.remove(next);
            waitingForLate.remove(next);
            long seq = next; next++;
            return new Frame(seq, cur, false);
        }
        // next still missing — late-in-transit or lost
        long waited = (waitingForLate.containsKey(next) ? waitingForLate.get(next) : 0) + frameMs;
        waitingForLate.put(next, waited);
        if (waited <= maxHoldMs) return null;
        waitingForLate.remove(next); waitingSince = 0; started = true;
        long seq = next; next++; concealed++;
        return new Frame(seq, null, true);
    }

    public synchronized void tick() {
        if (lossTimer > 0) { lossTimer -= 1000; if (lossTimer <= 0) lossPenalty = 0; }
    }

    private long runAhead() {
        long n = 0;
        for (long s = next; buf.containsKey(s); s++) n++;
        return n;
    }

    public synchronized Map<String,Object> stats() {
        Map<String,Object> m = new HashMap<>();
        m.put("target", target); m.put("baseline", baseline);
        m.put("lost", lost); m.put("concealed", concealed); m.put("droppedLate", droppedLate);
        m.put("buffered", (long) buf.size()); m.put("started", started);
        return m;
    }
}
