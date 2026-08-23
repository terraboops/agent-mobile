// proto.js — mutual key exchange + AEAD channel (the security core). PROTOCOL v2.
//
// Four-Diffie-Hellman handshake (the same family as X3DH / TLS 1.3's key
// schedule), producing a forward-secret, mutually-authenticated session key.
//
//   secret1 = DH(clientIdentity , serverIdentity)   -> mutual auth (pairing)
//   secret2 = DH(clientIdentity , serverEphemeral)
//   secret3 = DH(clientEphemeral, serverIdentity)
//   secret4 = DH(clientEphemeral, serverEphemeral)  -> forward secrecy
//   k       = HKDF-SHA256(sort(secret1..4), info="agent-mobile/v2", 128 bytes)
//   k[0:32]  client->server key    k[32:64] server->client key
//   k[64:96] authKey (handshake transcript MAC)      k[96:128] reserved
//
// Handshake (three plaintext JSON messages; public keys only):
//   C->S  hello   { v:2, client_id, client_identity, client_eph }
//   S->C  reply   { v:2, server_identity, server_eph, mac }
//           mac = HMAC(authKey, "server" || 0 || transcript)
//   C->S  confirm { v:2, confirm }
//           confirm = HMAC(authKey, "client" || 0 || transcript)
//   transcript = info || len(client_identity)||client_identity || len(client_eph)||client_eph
//                     || len(server_identity)||server_identity || len(server_eph)||server_eph
// The server MAC proves the server holds its identity private key (only a true
// holder derives authKey); the client verifies it AND compares server_identity
// to its pinned SPKI before sending anything. The server allowlists client
// identities and accepts sealed frames only after verifying `confirm`.
//
// Frames (ChaCha20-Poly1305 AEAD):
//   wire   = [ type u8 ][ nonce 12 ][ tag 16 ][ ciphertext ]
//   aad    = [ type ]                           (routing byte is authenticated)
//   nonce  = [ stream u32 BE ][ counter u64 BE ] (stream 0 = WS, 1 = UDP media)
// The sender keeps one monotonic counter per stream; the receiver keeps a
// per-stream anti-replay window (REPLAY_WINDOW slots). WS and UDP live in
// different streams so a stalled TCP socket can't push UDP out of its window.
//
// Everything is built on Node's built-in `crypto` — no third-party deps.

import { createHash, createHmac, createPrivateKey, createPublicKey,
         diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual,
         createCipheriv, createDecipheriv } from 'node:crypto';

export const PROTO_VERSION = 2;
export const HKDF_INFO = 'agent-mobile/v2';
export const ALGO = 'chacha20-poly1305';
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const KEY_LEN = 32; // chacha20-poly1305 + hmac use 32-byte keys
export const STREAM_WS = 0;
export const STREAM_UDP = 1;
export const MAX_STREAMS = 4;
export const REPLAY_WINDOW = 1024;
const MAX_COUNTER = 2 ** 53 - 1;

// ---- identity ---------------------------------------------------------------

export function genIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

export function identityId(identity) {
  // A short, human-readable fingerprint for pairing/QR + the unforgeable badge.
  const pub = Buffer.isBuffer(identity) ? identity : identity.publicKey;
  return createHash('sha256').update(pub).digest('hex').slice(0, 8);
}

function _dh(privPkcs8Der, pubSpkiDer) {
  const priv = createPrivateKey({ key: privPkcs8Der, type: 'pkcs8', format: 'der' });
  const pub = createPublicKey({ key: pubSpkiDer, type: 'spki', format: 'der' });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

// ---- key derivation -----------------------------------------------------------

function deriveSession(identity, theirId, myEph, theirEph) {
  const s1 = _dh(identity.privateKey, theirId.publicKey);      // DH(myId, peerId)
  const s2 = _dh(identity.privateKey, theirEph.publicKey);     // DH(myId, peerEph)
  const s3 = _dh(myEph.privateKey, theirId.publicKey);         // DH(myEph, peerId)
  const s4 = _dh(myEph.privateKey, theirEph.publicKey);        // DH(myEph, peerEph)
  // Both sides compute the SAME four secrets but in mirror-image order; sort so the
  // concatenation (and hence HKDF input) is identical regardless of side.
  const inputs = [s1, s2, s3, s4].sort((a, b) => a.compare(b));
  return Buffer.from(hkdfSync('sha256', Buffer.concat(inputs), Buffer.alloc(0), HKDF_INFO, KEY_LEN * 4));
}

// role = 'client' | 'agent'. theirEphPub is the peer's ephemeral SPKI (Buffer).
export function sessionFrom(role, identity, theirId, myEph, theirEphPub) {
  const theirEph = { publicKey: theirEphPub };
  const k = deriveSession(identity, theirId, myEph, theirEph);
  const k0 = k.subarray(0, KEY_LEN);              // client -> agent
  const k1 = k.subarray(KEY_LEN, KEY_LEN * 2);    // agent -> client
  const authKey = k.subarray(KEY_LEN * 2, KEY_LEN * 3);
  const txKey = role === 'agent' ? k1 : k0;
  const rxKey = role === 'agent' ? k0 : k1;
  return new Channel(txKey, rxKey, authKey);
}

// ---- anti-replay window ----------------------------------------------------------

export class ReplayWindow {
  constructor(size = REPLAY_WINDOW) {
    this.size = size;
    this.max = -1;                       // highest counter accepted so far
    this.seen = new Uint8Array(size);    // slot = counter % size
  }
  // Would this counter be accepted? (read-only; call mark() after the AEAD check)
  accepts(counter) {
    if (!Number.isInteger(counter) || counter < 0) return false;
    if (counter > this.max) return true;
    if (this.max - counter >= this.size) return false;   // too old
    return this.seen[counter % this.size] === 0;
  }
  mark(counter) {
    if (counter > this.max) {
      const shift = counter - this.max;
      if (shift >= this.size) this.seen.fill(0);
      else for (let c = this.max + 1; c < counter; c++) this.seen[c % this.size] = 0;
      this.max = counter;
    }
    this.seen[counter % this.size] = 1;
  }
}

// ---- AEAD primitives ----------------------------------------------------------------

function nonceFor(stream, counter) {
  const n = Buffer.alloc(NONCE_LEN);
  n.writeUInt32BE(stream, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

function parseNonce(nonce) {
  const stream = nonce.readUInt32BE(0);
  const c = nonce.readBigUInt64BE(4);
  if (c > BigInt(MAX_COUNTER)) return null;
  return { stream, counter: Number(c) };
}

function encrypt(key, nonce, aad, plaintext) {
  const c = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { ct, tag: c.getAuthTag(), nonce };
}

// Returns plaintext Buffer, or null. NEVER throws: a malformed frame (short
// nonce, odd tag length, non-Buffer fields) must not escape a socket/datagram
// handler and take the process down.
function decrypt(key, frame) {
  try {
    if (!frame || !frame.nonce || !frame.tag || !frame.ct) return null;
    const iv = Buffer.from(frame.nonce);
    const tag = Buffer.from(frame.tag);
    const ct = Buffer.from(frame.ct);
    if (iv.length !== NONCE_LEN || tag.length !== TAG_LEN) return null;
    const aad = Buffer.from([(frame.type ?? 0) & 0xff]);
    const d = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
    d.setAAD(aad, { plaintextLength: ct.length });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    return null; // auth failure (wrong key / tamper / MITM) or malformed frame
  }
}

// ---- channel ------------------------------------------------------------------------------

export class Channel {
  constructor(txKey, rxKey, authKey) {
    this.txKey = txKey;
    this.rxKey = rxKey;
    this.authKey = authKey;
    this._tx = new Array(MAX_STREAMS).fill(0);                 // per-stream send counters
    this._rx = Array.from({ length: MAX_STREAMS }, () => new ReplayWindow());
    this.rejected = { replay: 0, auth: 0 };
  }

  // Sent-counter of a stream (diagnostics / tests).
  txCounter(stream = STREAM_WS) { return this._tx[stream]; }

  // Handshake transcript MAC. label = 'server' | 'client'.
  handshakeMac(label, transcript) {
    if (transcript === undefined) { transcript = label; label = ''; } // legacy 1-arg form
    return createHmac('sha256', this.authKey)
      .update(Buffer.from(String(label), 'utf8')).update(Buffer.from([0])).update(transcript).digest();
  }

  // Seal one message. Returns { type, nonce, tag, ct, counter }.
  send(plaintext, type = 0, stream = STREAM_WS) {
    if (!(stream >= 0 && stream < MAX_STREAMS)) throw new RangeError('bad stream');
    const counter = this._tx[stream];
    if (counter >= MAX_COUNTER) throw new RangeError('counter exhausted; rekey');
    this._tx[stream] = counter + 1;
    const frame = encrypt(this.txKey, nonceFor(stream, counter), Buffer.from([type & 0xff]), Buffer.from(plaintext));
    frame.type = type & 0xff;
    frame.counter = counter;
    return frame;
  }

  // Open one message (frame = { type, nonce, tag, ct }). Binary-safe. Returns
  // plaintext Buffer or null (bad auth, malformed, or replayed/too-old).
  recvBytes(frame) {
    let meta = null;
    try {
      if (!frame || !frame.nonce) return null;
      const nonce = Buffer.from(frame.nonce);
      if (nonce.length !== NONCE_LEN) return null;
      meta = parseNonce(nonce);
    } catch { return null; }
    if (meta === null || !(meta.stream < MAX_STREAMS)) return null;
    const win = this._rx[meta.stream];
    if (!win.accepts(meta.counter)) { this.rejected.replay++; return null; }
    const pt = decrypt(this.rxKey, frame);
    if (pt === null) { this.rejected.auth++; return null; }
    win.mark(meta.counter);               // only a GENUINE frame advances the window
    return pt;
  }

  recv(frame) {
    const pt = this.recvBytes(frame);
    return pt === null ? null : pt.toString('utf8');
  }
}

// ---- handshake helpers --------------------------------------------------------------------
// Pure functions; used by the WS gateway/client, the HTTP mock, the tests, and
// mirrored byte-for-byte by KoCrypto.java.

function lenPrefixed(buf) {
  const l = Buffer.alloc(2); l.writeUInt16BE(buf.length, 0);
  return Buffer.concat([l, buf]);
}

export function transcript(clientIdentityPub, clientEphPub, serverIdentityPub, serverEphPub) {
  return Buffer.concat([
    Buffer.from(HKDF_INFO, 'utf8'),
    lenPrefixed(clientIdentityPub), lenPrefixed(clientEphPub),
    lenPrefixed(serverIdentityPub), lenPrefixed(serverEphPub),
  ]);
}

const b64 = (b) => Buffer.from(b).toString('base64');
function db64(s, what) {
  if (typeof s !== 'string' || !s.length) throw new Error(`bad_${what}`);
  const b = Buffer.from(s, 'base64');
  if (!b.length) throw new Error(`bad_${what}`);
  return b;
}

// Client step 1: the plaintext hello.
export function clientHello(identity, eph) {
  return {
    v: PROTO_VERSION,
    client_id: identityId(identity),
    client_identity: b64(identity.publicKey),
    client_eph: b64(eph.publicKey),
  };
}

// Server: consume the hello, derive the channel, produce the reply + the confirm
// value the client must echo. `allow(clientIdentityPub, clientId)` is the
// allowlist gate — return false for an unknown/unpaired client.
export function serverHandshake(identity, hello, { allow = null, extra = {} } = {}) {
  if (!hello || hello.v !== PROTO_VERSION) throw new Error('bad_version');
  const clientIdentity = db64(hello.client_identity, 'client_identity');
  const clientEph = db64(hello.client_eph, 'client_eph');
  const clientId = identityId(clientIdentity);
  if (allow && !allow(clientIdentity, clientId)) throw new Error('unknown_client');
  const serverEph = genIdentity();
  const channel = sessionFrom('agent', identity, { publicKey: clientIdentity }, serverEph, clientEph);
  const tr = transcript(clientIdentity, clientEph, identity.publicKey, serverEph.publicKey);
  const reply = {
    ...extra,
    v: PROTO_VERSION,
    server_identity: b64(identity.publicKey),
    server_eph: b64(serverEph.publicKey),
    mac: b64(channel.handshakeMac('server', tr)),
  };
  return { reply, channel, clientIdentity, clientId, expectedConfirm: channel.handshakeMac('client', tr) };
}

// Client step 2: verify the reply (MAC + pinned identity), derive the channel,
// build the confirm message. `expectServerIdentity` is the pinned SPKI (Buffer
// or base64 string); when null/undefined the caller is doing TOFU and must pin
// the returned serverIdentity itself after user confirmation.
export function clientFinish(identity, eph, hello, reply, { expectServerIdentity = null } = {}) {
  if (!reply || reply.v !== PROTO_VERSION) throw new Error('bad_version');
  const serverIdentity = db64(reply.server_identity, 'server_identity');
  const serverEph = db64(reply.server_eph, 'server_eph');
  const mac = db64(reply.mac, 'mac');
  if (expectServerIdentity) {
    const pin = Buffer.isBuffer(expectServerIdentity) ? expectServerIdentity : Buffer.from(expectServerIdentity, 'base64');
    if (pin.length !== serverIdentity.length || !timingSafeEqual(pin, serverIdentity)) throw new Error('identity_mismatch');
  }
  const channel = sessionFrom('client', identity, { publicKey: serverIdentity }, eph, serverEph);
  const tr = transcript(db64(hello.client_identity, 'client_identity'), db64(hello.client_eph, 'client_eph'), serverIdentity, serverEph);
  const expect = channel.handshakeMac('server', tr);
  if (mac.length !== expect.length || !timingSafeEqual(mac, expect)) throw new Error('mac_mismatch');
  return {
    channel,
    serverIdentity,
    agentId: identityId(serverIdentity),
    confirm: { v: PROTO_VERSION, confirm: b64(channel.handshakeMac('client', tr)) },
  };
}

// Server step 3: verify the client's confirm message.
export function verifyConfirm(expectedConfirm, msg) {
  try {
    if (!msg || msg.v !== PROTO_VERSION) return false;
    const got = db64(msg.confirm, 'confirm');
    return got.length === expectedConfirm.length && timingSafeEqual(got, expectedConfirm);
  } catch { return false; }
}
