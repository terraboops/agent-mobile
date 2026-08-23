// ws-client.mjs — the app's WebSocket client with partition resilience (protocol v2).
//
//  * One durable WS connection; all frames AEAD-sealed (transport/wsframes.js).
//  * Handshake: hello -> reply(mac) -> confirm. The client verifies the server's
//    transcript MAC and compares server_identity to its PIN before sending
//    anything. With no pin, `onPair(serverIdentity, agentId)` is consulted (TOFU:
//    the caller shows the fingerprint and persists the pin on approval).
//  * App-layer keepalive (ping/pong) with exponential backoff:
//      base interval, double per failure up to max, reset on any liveness.
//      Partition declared after P consecutive failed probes.
//  * Partition resilience: the FIRST failed probe switches the client into
//    buffering (do not wait to declare). Outbound frames (audio + commands)
//    queue in order, each already AEAD-sealed with its own counter. On any
//    liveness the partition clears and the whole buffer flushes in order.
//  * Unbounded buffer: never loses speech; memory grows only with partition
//    length (Opus ~4 KB/s per direction). Frames keep seq+ts so the agent can
//    discard-stale by policy.

import WebSocket from 'ws';
import { genIdentity, clientHello, clientFinish } from '../proto.js';
import { pack, unpack, T, packAudio } from './wsframes.js';

export class AgentStream {
  constructor({ url, base = 2000, max = 64000, P = 3, probeTimeout = 1000,
                identity = null, expectServerIdentity = null, onPair = null } = {}) {
    this.url = url;
    this.base = base;
    this.max = max;
    this.P = P;
    this.probeTimeout = probeTimeout;
    this.identity = identity || genIdentity();   // PERSISTENT client identity (caller stores it)
    this.expectServerIdentity = expectServerIdentity; // pinned server SPKI (Buffer/base64) or null
    this.onPair = onPair;                          // TOFU hook: async (serverIdentity, agentId) => bool
    this.agentId = null;
    this.serverIdentity = null;
    this.ws = null;
    this.channel = null;
    this.failures = 0;
    this.partitioned = false;
    this.buffer = [];       // unbounded outbound queue
    this._pending = new Map();
    this._mid = 0;
    this._nextTimer = null;
    this._probeTimer = null;
    this.onPartitionChange = () => {};
    this.onRemoteAudio = () => {};
    this.stats = { buffered: 0, live: 0, flushed: 0, probes: 0 };
  }

  // ---- connect + handshake -------------------------------------------------
  connect() {
    return new Promise((resolve, reject) => {
      const eph = genIdentity();
      const hello = clientHello(this.identity, eph);
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(err); } };
      ws.on('open', () => ws.send(JSON.stringify(hello)));
      ws.on('message', async (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (this.channel) { this._onFrame(buf); return; }
        let reply;
        try { reply = JSON.parse(buf.toString('utf8')); } catch { return; }   // not the hello reply
        if (reply && reply.error) return fail(new Error('gateway: ' + reply.error));
        let fin;
        try { fin = clientFinish(this.identity, eph, hello, reply, { expectServerIdentity: this.expectServerIdentity }); }
        catch (e) { return fail(e); }
        if (!this.expectServerIdentity && this.onPair) {
          let okPair = false;
          try { okPair = await this.onPair(fin.serverIdentity, fin.agentId); } catch { okPair = false; }
          if (!okPair) return fail(new Error('pairing_declined'));
        }
        ws.send(JSON.stringify(fin.confirm));
        this.channel = fin.channel;
        this.agentId = fin.agentId;
        this.serverIdentity = fin.serverIdentity;
        settled = true;
        resolve({ agentId: fin.agentId, serverIdentity: fin.serverIdentity });
      });
      ws.on('error', fail);
      ws.on('close', () => { if (this.channel) this._onLivenessClosure(); else fail(new Error('closed before handshake')); });
    });
  }

  startKeepalive() {
    this._scheduleNext(this.base);
  }

  // ---- command round-trip ---------------------------------------------------
  cmd(payload, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const i = ++this._mid;
      const box = this.channel.send(Buffer.from(JSON.stringify({ i, d: payload })), T.cmd);
      const t = setTimeout(() => { this._pending.delete(i); reject(new Error('cmd timeout')); }, timeoutMs);
      this._pending.set(i, { resolve, reject, t });
      this._emit(pack(T.cmd, box));
    });
  }

  // ---- audio stream ---------------------------------------------------------
  sendAudio(seq, tsMs, opusBytes) {
    const box = this.channel.send(packAudio(seq, tsMs, opusBytes), T.audio);
    this._emit(pack(T.audio, box));
  }

  sendGap() {
    const box = this.channel.send(Buffer.from('g'), T.gap);
    this._emit(pack(T.gap, box));
  }

  // ---- outbound: buffer on trouble, else send ---------------------------------
  _emit(frame) {
    if (this.failures > 0) { this.buffer.push(frame); this.stats.buffered++; }
    else { this.ws.send(frame, { binary: true }); this.stats.live++; }
  }

  _flush() {
    const buf = this.buffer;
    this.buffer = [];
    for (const f of buf) this.ws.send(f, { binary: true });
    this.stats.flushed += buf.length;
  }

  // ---- inbound ---------------------------------------------------------------
  _onFrame(raw) {
    let f; try { f = unpack(Buffer.from(raw)); } catch { return; }
    if (!this.channel) return;
    const pt = this.channel.recvBytes(f);
    if (pt === null) return;               // forged / replayed: NOT liveness
    // Only an AUTHENTICATED inbound frame is liveness: clears the partition and flushes.
    if (this.failures > 0) this._onLiveness();
    if (f.type === T.pong) return;         // keepalive ack, already handled as liveness
    if (f.type === T.cmd) {
      const { i, d } = JSON.parse(pt.toString('utf8'));
      const p = this._pending.get(i);
      if (p) { clearTimeout(p.t); this._pending.delete(i); p.resolve(d); }
    } else if (f.type === T.audio) {
      // inbound agent audio (not exercised by this mock, but supported)
      const seq = pt.readUInt32BE(0);
      this.onRemoteAudio(seq, pt.subarray(4));
    }
  }

  // ---- keepalive with exponential backoff --------------------------------------
  _onLiveness() {
    clearTimeout(this._probeTimer);
    if (this.partitioned) {
      this.partitioned = false;
      this._flush();
      this.onPartitionChange(false);
    }
    if (this.failures > 0) this.failures = 0;
    this._scheduleNext(this.base);
  }

  _scheduleNext(interval) {
    clearTimeout(this._nextTimer);
    this._nextTimer = setTimeout(() => this._probe(), interval);
  }

  _probe() {
    if (!this.channel) return;
    this.stats.probes++;
    let box;
    try { box = this.channel.send(Buffer.alloc(0), T.ping); } catch (_) { return; }
    this.ws.send(pack(T.ping, box), { binary: true });
    this._probeTimer = setTimeout(() => {
      this.failures++;
      if (!this.partitioned && this.failures >= this.P) {
        this.partitioned = true;
        this.onPartitionChange(true);
      }
      const next = Math.min(this.base * Math.pow(2, this.failures), this.max);
      this._scheduleNext(next);
    }, this.probeTimeout);
  }

  _onLivenessClosure() {
    // Connection truly closed: report a hard partition so callers can act.
    this.onPartitionChange(true);
  }

  close() {
    clearTimeout(this._probeTimer);
    clearTimeout(this._nextTimer);
    try { this.ws.close(); } catch (_) {}
  }
}
