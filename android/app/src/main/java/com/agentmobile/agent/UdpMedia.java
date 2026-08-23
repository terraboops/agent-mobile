package com.agentmobile.agent;

import android.os.SystemClock;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

/**
 * UdpMedia — Android side of the UDP media path (transport/udp-media.js).
 *
 * Audio rides UDP instead of WebSocket/TCP for spotty cellular. Security stays on
 * the SAME session {@link KoCrypto.Channel}: each datagram is one sealed frame
 * `[type][nonce][tag][ct]` on nonce stream {@link KoCrypto#STREAM_UDP} (its own
 * counter + anti-replay window, independent of the WS stream), matching the
 * sidecar's UdpMedia exactly.
 *
 * Authenticated plaintext per datagram: `[kind u8][seq u32][tsMs u64][opus]`
 *   kind 0 = mic uplink (this device -> gateway), kind 1 = reply downlink,
 *   kind 2 = probe/ack. On start this class sends kind-2 probes every second
 *   until the sidecar answers with an authenticated kind-2 ack; only then does
 *   {@link #onProbed(Callback)} fire so the host can flip the uplink to UDP.
 *
 * The receiver funnels downlink frames through an {@link Ajb} so playout is
 * ordered + gap-concealed (PLC markers), then hands each frame to `sink`.
 * Send + receive are on separate threads; the jitter buffer is synchronized.
 */
public final class UdpMedia {
    public interface Sink {
        /** kind, seq, tsMs, opus (null when concealed), concealed */
        void onMedia(int kind, long seq, long tsMs, byte[] opus, boolean concealed);
    }
    public interface Callback { void run(); }

    private static final int PROBE_INTERVAL_MS = 1000;

    private final KoCrypto.Channel channel;
    private final Sink sink;
    private final Ajb jitter = new Ajb(6, 60, 20, 80, 100);

    private volatile DatagramSocket socket;
    private volatile boolean running;
    private volatile boolean probed;
    private Thread rxThread;
    private Thread probeThread;
    private InetAddress gwAddr;
    private int gwPort;
    private volatile Callback probedCb;

    public UdpMedia(KoCrypto.Channel channel, Sink sink) {
        this.channel = channel; this.sink = sink;
    }

    /** Fired (on the udp-rx thread) once the sidecar's authenticated kind-2 ack arrives. */
    public void onProbed(Callback cb) { this.probedCb = cb; }

    /** Bind the local socket. Returns the chosen local port (the gateway learns
     * it from our first uplink datagram and replies to it). */
    public int start() throws Exception {
        socket = new DatagramSocket(); // ephemeral local port on all interfaces
        running = true;
        rxThread = new Thread(this::receiveLoop, "agent-udp-rx");
        rxThread.setDaemon(true);
        rxThread.start();
        probeThread = new Thread(this::probeLoop, "agent-udp-probe");
        probeThread.setDaemon(true);
        probeThread.start();
        return socket.getLocalPort();
    }

    private void probeLoop() {
        int pseq = 0;
        while (running && !probed) {
            sendFrame(2, pseq++, System.currentTimeMillis(), new byte[0]);
            try { Thread.sleep(PROBE_INTERVAL_MS); } catch (InterruptedException e) { break; }
        }
    }

    /** Set the gateway media endpoint (host from the WS URL, port from hello). */
    public void setPeer(InetAddress addr, int port) { this.gwAddr = addr; this.gwPort = port; }

    public boolean isUp() { return running && gwAddr != null; }

    /** Seal + send one media frame (called from the mic encode thread). */
    public boolean sendFrame(int kind, long seq, long tsMs, byte[] opus) {
        DatagramSocket s = socket;
        if (s == null || gwAddr == null) return false;
        try {
            byte[] pt = new byte[13 + opus.length];
            pt[0] = (byte) kind;
            byte[] seqB = {(byte)(seq >> 24), (byte)(seq >> 16), (byte)(seq >> 8), (byte)seq};
            System.arraycopy(seqB, 0, pt, 1, 4);
            for (int i = 0; i < 8; i++) pt[5 + i] = (byte) (tsMs >>> (56 - i * 8));
            System.arraycopy(opus, 0, pt, 13, opus.length);
            byte[] wire = channel.seal(KoCrypto.TYPE_AUDIO, pt, KoCrypto.STREAM_UDP);
            s.send(new DatagramPacket(wire, wire.length, gwAddr, gwPort));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void receiveLoop() {
        byte[] bufArr = new byte[4096];
        DatagramPacket pkt = new DatagramPacket(bufArr, bufArr.length);
        while (running) {
            try {
                pkt.setLength(bufArr.length);
                socket.receive(pkt);
                byte[] wire = java.util.Arrays.copyOfRange(pkt.getData(), 0, pkt.getLength());
                byte[] pt;
                try { pt = channel.open(wire); }          // AEAD + anti-replay; throws -> drop
                catch (Exception bad) { continue; }
                if (pt == null || pt.length < 13) continue;
                int kind = pt[0] & 0xff;
                long seq = ((pt[1] & 0xffL) << 24) | ((pt[2] & 0xffL) << 16) | ((pt[3] & 0xffL) << 8) | (pt[4] & 0xffL);
                long tsMs = 0; for (int i = 0; i < 8; i++) tsMs = (tsMs << 8) | (pt[5 + i] & 0xffL);
                if (kind == 2) {                // sidecar ack to our probe — UDP is friendly now
                    if (!probed) {
                        probed = true;
                        Callback cb = probedCb;
                        if (cb != null) { try { cb.run(); } catch (Exception ignored) {} }
                    }
                    continue;
                }
                byte[] opus = java.util.Arrays.copyOfRange(pt, 13, pt.length);
                jitter.push(seq, tsMs, opus);
                drain(tsMs);
            } catch (Exception e) {
                if (!running) break;
            }
        }
    }

    private void drain(long tsMs) {
        Ajb.Frame f;
        long now = SystemClock.elapsedRealtime();
        while ((f = jitter.pull(now)) != null) {
            sink.onMedia(1, f.seq, tsMs, f.opus, f.concealed);
        }
    }

    public void close() {
        running = false;
        DatagramSocket s = socket;
        if (s != null) { try { s.close(); } catch (Exception ignored) {} }
    }
}
