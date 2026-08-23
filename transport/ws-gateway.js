// ws-gateway.js — agent-side WebSocket gateway (protocol v2, see proto.js).
//
// One durable WS connection per client. Handshake over WS (keys are public, so
// plaintext initiation is fine): hello -> reply(mac) -> confirm. Sealed frames
// are accepted ONLY after the client's confirm MAC verifies, and only from a
// client identity on the allowlist. After that every message is an AEAD sealed
// box (transport/wsframes.js; type byte authenticated as AAD, per-stream replay
// window). The gateway is the mock agent: it echoes commands, counts audio
// frames, answers keepalive pongs, and tracks a `dead` flag used by tests to
// simulate a network partition (while dead it drops everything, so a client's
// keepalive stops being answered and it declares the partition).
//
// Options:
//   identity        persistent server identity {publicKey, privateKey}; default: fresh
//   allowedClients  Set of client identityId (8-hex) and/or SPKI base64. When
//                   null/undefined the gateway runs in PAIRING MODE: it accepts any
//                   client and logs the identity so the operator can pin it.
//   onUnknownClient (hello) => void  — called when the allowlist rejects a client

import { WebSocketServer } from 'ws';
import { genIdentity, identityId, serverHandshake, verifyConfirm, PROTO_VERSION } from '../proto.js';
import { pack, unpack, T, unpackAudio } from './wsframes.js';

export async function startWsGateway({ port = 0, identity = null, allowedClients = null, onUnknownClient = null } = {}) {
  identity = identity || genIdentity();
  const agentId = identityId(identity);
  const state = { dead: false, loopback: false, audioSeqs: [], audioFrames: 0, bytes: 0, gaps: 0, cmds: 0,
                  connections: 0, authenticated: 0, rejected: 0, replayDropped: 0, authDropped: 0 };
  const allowlist = allowedClients ? new Set(allowedClients) : null;
  const allow = allowlist ? (pub, id) => allowlist.has(id) || allowlist.has(pub.toString('base64')) : null;
  if (!allowlist) console.log(`[agent ${agentId}] PAIRING MODE: no client allowlist — accepting any client identity (pin one with allowedClients)`);

  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    state.connections++;
    let channel = null;   // set only after the confirm MAC verifies
    let pending = null;   // { channel, expectedConfirm, clientId } between hello and confirm
    let lastAudioSeq = null; // gap detector scope (per connection)

    ws.on('message', (data, isBinary) => {
      try {
        if (!channel) {
          if (isBinary) return;                       // sealed frames before auth: drop
          const msg = JSON.parse(data.toString('utf8'));
          if (!pending) {
            let hs;
            try { hs = serverHandshake(identity, msg, { allow }); }
            catch (e) {
              state.rejected++;
              if (e.message === 'unknown_client') {
                console.log(`[agent ${agentId}] REJECT unknown client ${msg && msg.client_id} (${msg && msg.client_identity})`);
                if (onUnknownClient) onUnknownClient(msg);
              }
              try { ws.send(JSON.stringify({ v: PROTO_VERSION, error: e.message })); } catch {}
              ws.close(4003, e.message);
              return;
            }
            pending = hs;
            if (!allowlist) console.log(`[agent ${agentId}] pairing-mode client ${hs.clientId} identity=${hs.clientIdentity.toString('base64')}`);
            ws.send(JSON.stringify(hs.reply));
            return;
          }
          if (!verifyConfirm(pending.expectedConfirm, msg)) {
            state.rejected++;
            try { ws.send(JSON.stringify({ v: PROTO_VERSION, error: 'bad_confirm' })); } catch {}
            ws.close(4003, 'bad_confirm');
            return;
          }
          channel = pending.channel; pending = null;
          state.authenticated++;
          return;
        }

        // Partition simulation: while dead, the agent is unreachable — drop all.
        if (state.dead) return;

        const f = unpack(data);
        const pt = channel.recvBytes(f);
        if (pt === null) {                          // auth failed / replayed
          state.replayDropped = channel.rejected.replay; state.authDropped = channel.rejected.auth;
          return;
        }
        const { type } = f;

        if (type === T.ping) {                    // keepalive probe -> pong
          ws.send(pack(T.pong, channel.send(Buffer.alloc(0), T.pong)));
        } else if (type === T.cmd) {
          state.cmds++;
          const { i, d } = JSON.parse(pt.toString('utf8'));
          console.log(`[agent ${agentId}] RX cmd #${i}: ${JSON.stringify(d)}`);
          ws.send(pack(T.cmd, channel.send(Buffer.from(JSON.stringify({ i, d: { echo: d } })), T.cmd)));
        } else if (type === T.audio) {
          const a = unpackAudio(pt);
          state.audioSeqs.push(a.seq);
          state.audioFrames++;
          state.bytes += a.opus.length;
          if (lastAudioSeq != null && a.seq !== lastAudioSeq + 1) {
            console.log(`[agent ${agentId}] *** SEQ GAP *** ${lastAudioSeq} -> ${a.seq}`);
          }
          lastAudioSeq = a.seq;
          console.log(`[agent ${agentId}] RX audio #${a.seq} (${a.opus.length}B)`);
          // optional loopback (default OFF): echo the sealed frame back to verify decode/play.
          // A real agent instead feeds the utterance to STT -> LLM -> TTS and speaks back.
          if (state.loopback) {
            try {
              ws.send(pack(T.audio, channel.send(pt, T.audio)));
              console.log(`[agent ${agentId}] TX loopback #${a.seq}`);
            } catch (e) {
              console.log(`[agent ${agentId}] TX loopback FAIL #${a.seq}: ${e.message}`);
            }
          }
        } else if (type === T.gap) {
          state.gaps++;
        }
      } catch (_) { /* drop malformed */ }
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      resolve({
        agentId,
        identity,
        state,
        setDead: (b) => { state.dead = b; },
        setLoopback: (b) => { state.loopback = b; },
        // Runtime allowlist management (pairing flow): add a client id / SPKI b64.
        allowClient: (idOrSpki) => { if (allowlist) allowlist.add(idOrSpki); },
        close: () => new Promise((r) => wss.close(() => r())),
        get port() { return wss.address().port; },
      });
    });
    wss.on('error', reject);
  });
}
