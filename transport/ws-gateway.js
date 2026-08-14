// ws-gateway.js — agent-side WebSocket gateway.
//
// One durable WS connection per client. Handshake over WS (keys are public, so
// plaintext initiation is fine), then every message is an AEAD sealed box
// (transport/wsframes.js). The gateway is the mock agent: it echoes commands,
// counts audio frames, answers keepalive pongs, and tracks a `dead` flag used by
// tests to simulate a network partition (while dead it drops everything, so a
// client's keepalive stops being answered and it declares the partition).

import { WebSocketServer } from 'ws';
import { genIdentity, identityId, sessionFrom } from '../proto.js';
import { pack, unpack, T, unpackAudio } from './wsframes.js';

export async function startWsGateway({ port = 0 } = {}) {
  const identity = genIdentity();
  const agentId = identityId(identity);
  const state = { dead: false, loopback: false, audioSeqs: [], audioFrames: 0, bytes: 0, gaps: 0, cmds: 0, connections: 0 };

  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    state.connections++;
    let channel = null;
    let lastAudioSeq = null; // gap detector scope (per connection)

    ws.on('message', (data) => {
      try {
        if (!channel) {
          // handshake: first message is plaintext hello (public keys, not secret)
          const h = JSON.parse(data.toString('utf8'));
          const theirId = { publicKey: Buffer.from(h.client_identity, 'base64') };
          const serverEph = genIdentity();
          channel = sessionFrom('agent', identity, theirId, serverEph, Buffer.from(h.client_eph, 'base64'));
          ws.send(JSON.stringify({
            server_identity: identity.publicKey.toString('base64'),
            server_eph: serverEph.publicKey.toString('base64'),
          }));
          return;
        }

        // Partition simulation: while dead, the agent is unreachable — drop all.
        if (state.dead) return;

        const { type, nonce, tag, ct } = unpack(data);
        const pt = channel.recvBytes({ nonce, ct, tag });
        if (pt === null) return; // auth failed

        if (type === T.ping) {                    // keepalive probe -> pong
          ws.send(pack(T.pong, channel.send(Buffer.alloc(0))));
        } else if (type === T.cmd) {
          state.cmds++;
          const { i, d } = JSON.parse(pt.toString('utf8'));
          console.log(`[agent ${agentId}] RX cmd #${i}: ${JSON.stringify(d)}`);
          ws.send(pack(T.cmd, channel.send(Buffer.from(JSON.stringify({ i, d: { echo: d } })))));
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
              ws.send(pack(T.audio, channel.send(pt)));
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
        state,
        setDead: (b) => { state.dead = b; },
        setLoopback: (b) => { state.loopback = b; },
        close: () => new Promise((r) => wss.close(() => r())),
        get port() { return wss.address().port; },
      });
    });
    wss.on('error', reject);
  });
}
