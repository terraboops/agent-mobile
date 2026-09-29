// webrtc-media.mjs — WebRTC audio media path for agent-mobile.
//
// Replaces the hand-rolled AEAD-UDP/opus/jitter transport with the WebRTC media
// engine (werift on the gateway side): DTLS-SRTP for transport crypto, NetEQ
// jitter buffer + packet-loss concealment, and (on the Android twin) AEC3 echo
// cancellation + noise suppression. This module owns the gateway half of a
// PeerConnection whose audio carries the phone's microphone (uplink) and the
// agent's synthesized reply (downlink).
//
// Signaling rides the EXISTING authenticated WS control channel (SDP exchanged
// there), so no new authentication surface is introduced and DTLS fingerprints
// are pinned across an already-trusted link. No hand-rolled crypto.
//
// Wire (audio, 24 kHz mono opus, one frame = 480 samples / 20 ms):
//   uplink   phone -> PeerConnection -> onUtterance(opusBuffer)   [sidecar VAD]
//   downlink writeReply(opusBuffer) -> PeerConnection -> phone     [TTS pcm]
//
// exported factory for the sidecar's WebSocket handler.
import {
  MediaStreamTrack, RtpHeader, RtpPacket, RTCPeerConnection, RTCIceCandidate,
} from '/Users/terra/Developer/agent-mobile/node_modules/werift/lib/index.mjs';

export function createWebRtcSignal() {
  /**
   * WebRtcPeer — one PeerConnection for one phone connection.
   *   pcProps: { iceServers: [] } (Tailscale peers are directly reachable,
   *            host candidates suffice; no STUN/TURN needed)
   *   handler: { onUtterance(opus: Buffer), onState(state: string) }
   *
   * Control protocol on the WS (JSON messages the sidecar routes here):
   *   -> handleOffer({ sdp })   (the phone's libwebrtc offer) returns answer sdp
   *   -> handleCandidate({ candidate })  (optional trickle)
   *   -> writeReply(opusBuffer)          (agent TTS -> phone speaker)
   *   -> close()
   */
  class WebRtcPeer {
    constructor(handler = {}, pcProps = { iceServers: [] }) {
      this.pc = new RTCPeerConnection(pcProps);
      this.handler = handler;
      this.replyTrack = new MediaStreamTrack({ kind: 'audio' });
      this.replySender = null;
      this.opusPT = null;
      this.connected = false;
      this._seq = (Math.random() * 60000) | 0;
      this._ts = 0;
      // remote mic track -> onUtterance
      this.pc.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((pkt) => {
          if (this.handler.onUtterance) this.handler.onUtterance(pkt.payload);
        });
      });
      // always track ICE/connection state -> an explicit `connected` flag (the
      // `connectionState` getter is unreliable at query time, which caused the
      // downlink to keep falling back to UDP even after DTLS-SRTP was up).
      const stCh = this.pc.connectionStateChange ?? this.pc.iceConnectionStateChange;
      if (stCh) stCh.subscribe?.((s) => {
        if (s === 'connected') this.connected = true;
        else if (/closed|failed|disconnected/.test(String(s))) this.connected = false;
        if (this.handler.onState) this.handler.onState(s);
      });
    }

    /** Consume the phone's offer; resolve with our answer SDP (fully gathered). */
    async handleOffer(sdp) {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      // local outbound reply track
      this.replySender = await this.pc.addTrack(this.replyTrack);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      // wait for our host candidates so the answer carries them (non-trickle)
      await this._gatherComplete();
      const { sdp: ans } = this.pc.localDescription;
      this.opusPT = this.replySender.codec?.payloadType;
      // RTP timestamps are in units of the NEGOTIATED clock rate (opus=48kHz).
      // A 20ms frame = clockRate/50 samples (960 at 48k). Mistaking this for
      // 480 makes the phone pace the reply at 2x — "fast forward".
      this._ptsPerFrame = Math.max(1, Math.round(((this.replySender.codec?.clockRate) || 48000) / 50));
      return { type: 'answer', sdp: ans };
    }

    /**
     * The NOMINATED candidate pair, once ICE has settled — i.e. which path media is actually
     * taking, not which paths were offered.
     *
     * WHY IT IS WORTH LOGGING. "ICE connected" is not the claim this project makes. The claim is
     * that a phone reaches this Mac over Tailscale from anywhere, and when both are on the same
     * Wi-Fi the LAN pair wins on priority and a connected state proves nothing about the remote
     * case at all. The two are indistinguishable from the outside, so a device run on the sofa
     * can "verify" a property that has never once been exercised.
     *
     * Every accessor here is optional-chained: werift's internals are not a public contract, and
     * a diagnostic that throws is worse than one that returns null.
     */
    nominatedPair() {
      try {
        for (const t of (this.pc.iceTransports || [])) {
          const pair = t?.connection?.nominated;
          if (!pair) continue;
          const r = pair.remoteCandidate;
          const l = pair.protocol?.localCandidate;
          return {
            remote: r ? `${r.host}:${r.port} (${r.type})` : null,
            local: l && l.host ? `${l.host}:${l.port} (${l.type})` : null,
            remoteHost: r ? r.host : null,
          };
        }
      } catch { /* diagnostics must never take themedia path down */ }
      return null;
    }

    addRemoteCandidate(candidate) {
      if (!candidate) return;
      try {
        // werift's addIceCandidate expects an RTCIceCandidate object (parses the
        // `candidate` string); the phone sends the raw JSON fields, so wrap them.
        this.pc.addIceCandidate(candidate instanceof RTCIceCandidate
          ? candidate
          : new RTCIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex }));
        if (this.handler.onState) this.handler.onState('candidate+');
      } catch (e) {
        if (this.handler.onState) this.handler.onState('candidate-err:' + e.message);
      }
    }

    /** Agent reply opus frame -> phone speaker (downlink). */
    writeReply(opus) {
      const pt = this.opusPT ?? this.replySender?.codec?.payloadType;
      if (!pt || !opus) return false;
      this.replySender.timestampOffset ??= 0;
      this.replySender.seqOffset ??= 0;
      const header = new RtpHeader({
        version: 2, ssrc: this.replySender.ssrc,
        sequenceNumber: this._seq++ % 65536,
        timestamp: this._ts, payloadType: pt,
      });
      this._ts += this._ptsPerFrame || 960;
      this.replyTrack.writeRtp(new RtpPacket(header, opus));
      return true;
    }

    async _gatherComplete(timeoutMs = 6000) {
      const dl = Date.now() + timeoutMs;
      while (Date.now() < dl && this.pc.iceGatheringState !== 'complete') {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    get ready() { return this.connected && !!this.opusPT; }

    async close() {
      try { this.replyTrack.stop(); } catch {}
      try { await this.pc.close(); } catch {}
    }
  }
  return { WebRtcPeer };
}
