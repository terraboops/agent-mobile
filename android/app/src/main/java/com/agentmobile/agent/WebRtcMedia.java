package com.agentmobile.agent;

import android.content.Context;
import android.util.Log;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * WebRtcMedia — the Android (libwebrtc) half of the agent-mobile media path.
 *
 * Replaces the hand-rolled AEAD-UDP/opus/jitter transport with the WebRTC media
 * engine: DTLS-SRTP for transport crypto, NetEQ jitter buffer + PLC for the
 * spotty link, and libwebrtc's built-in AEC3 echo cancellation + noise
 * suppression (so the phone no longer re-hears the agent's own reply).
 *
 * Signaling (SDP / ICE candidates) travels over the SAME authenticated WS the
 * app already uses — the DTLS fingerprint is therefore pinned across a link we
 * already trust (protocol v2: MAC-verified, identity-pinned). No new crypto.
 *
 * Mic: a real local AudioSource/AudioTrack is created and attached to the sender at
 * start() so libwebrtc's AudioDeviceModule actually captures. The track starts DISABLED
 * (muted); {@link #setMicEnabled} flips audioTrack.setEnabled() — mute stops the uplink
 * without tearing the track down, so there is no unverified setTrack-from-null path.
 *
 * Lifecycle: start() is called after a successful handshake. The controller
 * (AgentChannelPlugin) feeds each inbound `d.webrtc` signal to handleSignal() and
 * calls close() on disconnect.
 */
public final class WebRtcMedia {
    private static final String TAG = "AgentWebRtc";

    /** Async bridge: send one signaling object back to the sidecar. */
    public interface SignalSink { void send(JSONObject obj); }

    private final Context context;
    private final SignalSink sink;
    private final PeerConnection.Observer observer;
    private final List<String> iceUrls;

    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private RtpSender audioSender;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private volatile boolean micWanted;   // requested state (may precede start())
    private volatile boolean micLive;     // a track is attached and capturing
    private volatile boolean started;
    private volatile boolean closed;

    public WebRtcMedia(Context context, SignalSink sink) { this(context, sink, null); }

    /** @param iceUrls optional STUN/TURN urls advertised by the gateway (e.g. a self-hosted
     *  stun on the tailnet). null/empty = host candidates only (Tailscale/LAN). Never a
     *  third-party (public) STUN: that is phone egress + IP disclosure to a stranger. */
    public WebRtcMedia(Context context, SignalSink sink, List<String> iceUrls) {
        this.context = context.getApplicationContext();
        this.sink = sink;
        this.iceUrls = iceUrls == null ? new ArrayList<String>() : new ArrayList<String>(iceUrls);
        this.observer = new PeerConnection.Observer() {
            @Override public void onIceCandidate(org.webrtc.IceCandidate c) {
                try {
                    JSONObject cand = new JSONObject();
                    cand.put("cmd", "webrtc");
                    cand.put("sdp_type", "candidate");
                    cand.put("candidate", new JSONObject()
                        .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex));
                    sink.send(cand);
                } catch (Exception e) { /* ignore */ }
            }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                Log.i(TAG, "ice state=" + state);
            }
            @Override public void onRenegotiationNeeded() {}
            @Override public void onDataChannel(org.webrtc.DataChannel dc) {}
            @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
            @Override public void onIceConnectionReceivingChange(boolean r) {}
            @Override public void onIceCandidatesRemoved(org.webrtc.IceCandidate[] candidates) {}
            @Override public void onAddStream(org.webrtc.MediaStream s) {}
            @Override public void onRemoveStream(org.webrtc.MediaStream s) {}
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {}
            @Override public void onAddTrack(org.webrtc.RtpReceiver receiver, org.webrtc.MediaStream[] streams) {}
            @Override public void onTrack(org.webrtc.RtpTransceiver transceiver) {}
        };
    }

    /** Must run on the MAIN thread (libwebrtc JVM attach); spins up the peer and sends an offer. */
    public void start() {
        if (started || closed) return;
        started = true;
        try {
            PeerConnectionFactory.InitializationOptions init =
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .setEnableInternalTracer(false).createInitializationOptions();
            PeerConnectionFactory.initialize(init);
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory();

            List<PeerConnection.IceServer> ice = new ArrayList<PeerConnection.IceServer>();
            for (String u : iceUrls) {
                try { ice.add(PeerConnection.IceServer.builder(u).createIceServer()); }
                catch (Exception e) { Log.w(TAG, "bad ice url " + u + ": " + e); }
            }
            if (ice.isEmpty()) {
                // The gateway advertised no ICE. Android libwebrtc does not surface the
                // Tailscale userspace-TUN 100.x as a host candidate, so with ZERO ICE
                // servers this peer stalls at `connecting` and never connects (no mic
                // uplink / no voice) — the H4 "no STUN" regression. Fall back to a public
                // STUN (discovery only, no relay) so voice works out of the box; the
                // gateway can override with a tailnet STUN via the hello `ice` list.
                ice.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
                Log.i(TAG, "no ICE advertised — using default STUN so ICE can complete");
            }
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(ice);
            cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            pc = factory.createPeerConnection(cfg, observer);
            if (pc == null) { Log.e(TAG, "createPeerConnection failed"); return; }

            // Send + receive audio m-section. NO track yet: capture starts only when the
            // user enables the mic (setMicEnabled) — the sender gets its track then.
            RtpTransceiver tr = pc.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV));
            audioSender = tr.getSender();
            // Attach a real local mic track NOW (libwebrtc's AudioDeviceModule then actually
            // captures). Mute/unmute flips audioTrack.setEnabled() — the track stays attached,
            // so there is no unverified setTrack-from-null path and mute stops uplink cleanly.
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("agentmob-mic", audioSource);
            audioTrack.setEnabled(micWanted);   // starts muted until the app enables the mic
            audioSender.setTrack(audioTrack, false);
            micLive = micWanted;

            MediaConstraints c = new MediaConstraints();
            pc.createOffer(new SdpObserver() {
                @Override public void onCreateSuccess(SessionDescription sdp) {
                    pc.setLocalDescription(sdpObserver(), sdp);
                    try { sink.send(new JSONObject()
                        .put("cmd", "webrtc").put("sdp_type", "offer").put("sdp", sdp.description)); }
                    catch (Exception e) { Log.e(TAG, "send offer: " + e); }
                }
                @Override public void onCreateFailure(String reason) { Log.e(TAG, "createOffer: " + reason); }
                @Override public void onSetSuccess() {}
                @Override public void onSetFailure(String reason) { Log.w(TAG, "offer set: " + reason); }
            }, c);
            Log.i(TAG, "webrtc started, offer sent (ice servers=" + ice.size() + ", mic=" + micLive + ")");
        } catch (Exception e) {
            Log.e(TAG, "webrtc start: " + e);
        }
    }

    /**
     * Turn the microphone uplink on/off. Returns the requested state (true if the mic
     * is live or will be as soon as the peer is up). Safe from any thread.
     */
    public synchronized boolean setMicEnabled(boolean on) {
        micWanted = on;
        if (audioTrack == null || closed) return on && !closed; // track is created in start(); applied there
        try { audioTrack.setEnabled(on); micLive = on; Log.i(TAG, "mic " + (on ? "unmuted (capturing)" : "muted")); }
        catch (Exception e) { Log.e(TAG, "setMicEnabled(" + on + "): " + e); }
        return micLive;
    }

    /** True when the mic track is live (unmuted), or requested before the peer finished start(). */
    public boolean isMicEnabled() { return micLive || (micWanted && audioTrack == null && !closed); }

    private org.webrtc.SdpObserver sdpObserver() {
        return new org.webrtc.SdpObserver() {
            @Override public void onCreateSuccess(SessionDescription sdp) {}
            @Override public void onCreateFailure(String reason) {}
            @Override public void onSetSuccess() {}
            @Override public void onSetFailure(String reason) { Log.w(TAG, "setLocal: " + reason); }
        };
    }

    /** Inbound signaling from the sidecar: the answer (and future trickle). */
    public void handleSignal(JSONObject d) {
        if (pc == null || closed) return;
        try {
            JSONObject w = d.optJSONObject("webrtc");
            if (w == null) return;
            String rtype = w.optString("rtype");
            if ("answer".equals(rtype)) {
                String sdp = w.optString("sdp");
                if (sdp.isEmpty()) return;
                pc.setRemoteDescription(sdpObserver(), new SessionDescription(SessionDescription.Type.ANSWER, sdp));
                Log.i(TAG, "remote answer applied, connected audio path");
            } else if ("candidate".equals(rtype)) {
                JSONObject c = w.optJSONObject("candidate");
                if (c != null) pc.addIceCandidate(new org.webrtc.IceCandidate(
                    c.optString("sdpMid"), c.optInt("sdpMLineIndex", 0), c.optString("candidate")));
            }
        } catch (Exception e) {
            Log.e(TAG, "handleSignal: " + e);
        }
    }

    public void close() {
        if (closed) return;
        closed = true;
        micWanted = false; micLive = false;
        try { if (audioTrack != null) audioTrack.dispose(); } catch (Exception ignored) {}
        try { if (audioSource != null) audioSource.dispose(); } catch (Exception ignored) {}
        try { if (pc != null) pc.close(); } catch (Exception ignored) {}
        try { if (factory != null) factory.dispose(); } catch (Exception ignored) {}
        pc = null; factory = null; audioSender = null; audioTrack = null; audioSource = null;
        Log.i(TAG, "webrtc closed");
    }
}
