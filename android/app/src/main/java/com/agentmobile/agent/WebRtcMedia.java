package com.agentmobile.agent;

import android.content.Context;
import android.util.Log;

import org.webrtc.AudioTrack;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import org.json.JSONObject;

import java.util.List;

/**
 * WebRtcMedia — the Android (libwebrtc) half of the agent-mobile media path.
 *
 * Replaces the hand-rolled AEAD-UDP/opus/jitter transport with the WebRTC media
 * engine: DTLS-SRTP for transport crypto, NetEQ jitter buffer + PLC for the
 * spotty link, and libwebrtc's built-in AEC3 echo cancellation + noise
 * suppression (so the phone no longer re-hears the agent's own reply).
 *
 * Signaling (SD P + ICE candidates) travels over the SAME authenticated WS the
 * app already uses — the DTLS fingerprint is therefore pinned across a link we
 * already trust. No new crypto is written.
 *
 * Lifecycle: start() is called after a successful handshake. The controller
 * (AgentChannelPlugin) feeds each inbound `d.webRTC` signal to handleSignal() and
 * calls close() on disconnect.
 */
public final class WebRtcMedia {
    private static final String TAG = "AgentWebRtc";

    /** Async bridge: send one signaling object back to the sidecar. */
    public interface SignalSink { void send(JSONObject obj); }

    private final Context context;
    private final SignalSink sink;
    private final PeerConnection.Observer observer;

    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private AudioTrack audioTrack;
    private volatile boolean started;
    private volatile boolean closed;

    public WebRtcMedia(Context context, SignalSink sink) {
        this.context = context.getApplicationContext();
        this.sink = sink;
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

    /** Must run off the UI thread; spins up the peer and sends an offer. */
    public void start() {
        if (started || closed) return;
        started = true;
        try {
            PeerConnectionFactory.InitializationOptions init =
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .setEnableInternalTracer(false).createInitializationOptions();
            PeerConnectionFactory.initialize(init);
            factory = PeerConnectionFactory.builder().createPeerConnectionFactory();

            // iceServers: a public STUN server is the stability baseline (Pipecat
            // defaults to it) — discovery only, no relay. Tailscale host candidates
            // usually suffice, but this stops ICE stalling at `connecting` when the
            // Android host candidate set omits the userspace TUN IP.
            java.util.List<PeerConnection.IceServer> ice =
                new java.util.ArrayList<PeerConnection.IceServer>();
            ice.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(ice);
            pc = factory.createPeerConnection(cfg, observer);
            if (pc == null) { Log.e(TAG, "createPeerConnection failed"); return; }

            // Send + receive audio (mic capture + speaker playback) with AEC/NS on.
            pc.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
                new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV));

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
            Log.i(TAG, "webrtc started, offer sent");
        } catch (Exception e) {
            Log.e(TAG, "webrtc start: " + e);
        }
    }

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
            }
        } catch (Exception e) {
            Log.e(TAG, "handleSignal: " + e);
        }
    }

    public void close() {
        if (closed) return;
        closed = true;
        try { if (pc != null) pc.close(); } catch (Exception ignored) {}
        try { if (factory != null) factory.dispose(); } catch (Exception ignored) {}
        pc = null; factory = null;
        Log.i(TAG, "webrtc closed");
    }
}
