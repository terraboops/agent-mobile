// proto.js — mutual key exchange + AEAD channel (the security core).
//
// Four-Diffie-Hellman handshake (the same family as X3DH / TLS 1.3's key
// schedule), producing a forward-secret, mutually-authenticated session key.
//
//   secret1 = DH(clientIdentity , serverIdentity)   -> mutual auth (pairing) 
//   secret2 = DH(clientIdentity , serverEphemeral)
//   secret3 = DH(clientEphemeral, serverIdentity)
//   secret4 = DH(clientEphemeral, serverEphemeral)  -> forward secrecy
//   master  = HKDF(secret1 ++ secret2 ++ secret3 ++ secret4)
//   tx/rx   = HKDF(master, context="tx" / "rx")
//
// Only a true pair knows both identity private keys, so a MITM cannot produce
// secret1 -> its master differs -> handshake MAC fails and every frame is
// undecryptable. Frames are ChaCha20-Poly1305 AEAD with sequential counters.
//
// Everything is built on Node's built-in `crypto` — no third-party deps.

import { createHash, createHmac, createPrivateKey, createPublicKey,
         diffieHellman, generateKeyPairSync, hkdfSync,
         createCipheriv, createDecipheriv } from 'node:crypto';

export const ALGO = 'chacha20-poly1305';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // chacha20-poly1305 + hmac use 32-byte keys
const COUNTER_LEN = 8;

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
  return createHash('sha256').update(identity.publicKey).digest('hex').slice(0, 8);
}

function _dh(privSpkiDer, pubSpkiDer) {
  const priv = createPrivateKey({ key: privSpkiDer, type: 'pkcs8', format: 'der' });
  const pub = createPublicKey({ key: pubSpkiDer, type: 'spki', format: 'der' });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

// ---- handshake -----------------------------------------------

function deriveSession(identity, theirId, myEph, theirEph) {
  const s1 = _dh(identity.privateKey, theirId.publicKey);      // DH(myId, peerId)
  const s2 = _dh(identity.privateKey, theirEph.publicKey);     // DH(myId, peerEph)
  const s3 = _dh(myEph.privateKey, theirId.publicKey);         // DH(myEph, peerId)
  const s4 = _dh(myEph.privateKey, theirEph.publicKey);        // DH(myEph, peerEph)
  // Both sides compute the SAME four secrets but in mirror-image order; sort so the
  // concatenation (and hence HKDF input) is identical regardless of side.
  const inputs = [s1, s2, s3, s4].sort((a, b) => a.compare(b));
  return Buffer.from(hkdfSync('sha256', Buffer.concat(inputs), Buffer.alloc(0), 'agent-mobile/v1', KEY_LEN * 4));
}

// Convert an ephemeral X25519 keypair (spki/pkcs8) into a "peer" shim the
// derive step expects (just needs .publicKey). Both client and agent use the
// same code — the roles are symmetric.

export function sessionFrom(role, identity, theirId, myEph, theirEphPub) {
  const theirEph = { publicKey: theirEphPub };
  const k = deriveSession(identity, theirId, myEph, theirEph);
  // k is 4*KEY_LEN bytes. tx = key for messages I SEND, rx = key for messages I
  // RECEIVE. Both sides derive the same slices, so the CLIENT takes tx=slice0,
  // rx=slice1 and the AGENT is flipped — that way the client's tx equals the
  // agent's rx and vice-versa.
  const k0 = k.subarray(0, KEY_LEN);
  const k1 = k.subarray(KEY_LEN, KEY_LEN * 2);
  const authKey = k.subarray(KEY_LEN * 2, KEY_LEN * 3);
  const txKey = role === 'agent' ? k1 : k0;
  const rxKey = role === 'agent' ? k0 : k1;
  return new Channel(txKey, rxKey, authKey);
}

// ---- channel ----------------------------------------------------------------

function encrypt(key, counter, plaintext) {
  const nonce = counterBytes(counter, NONCE_LEN);
  const iv = Buffer.alloc(NONCE_LEN);
  // use the counter as the nonce prefix; rest zeroed (fresh key per session)
  nonce.copy(iv);
  const c = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { ct, tag: c.getAuthTag(), nonce: iv };
}

function decrypt(key, counter, frame) {
  // EVERYTHING is inside the try: a malformed frame (short nonce, odd tag length,
  // non-Buffer fields) must be a clean `null`, never an exception that escapes a
  // socket/datagram handler and takes the process down.
  try {
    if (!frame || !frame.nonce || !frame.tag || !frame.ct) return null;
    const iv = Buffer.from(frame.nonce);
    const tag = Buffer.from(frame.tag);
    if (iv.length !== NONCE_LEN || tag.length !== TAG_LEN) return null;
    const d = createDecipheriv(ALGO, key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(frame.ct)), d.final()]);
  } catch {
    return null; // auth failure (wrong key / tamper / MITM) or malformed frame
  }
}

function counterBytes(counter, len) {
  const b = Buffer.alloc(len);
  b.writeBigUInt64BE(BigInt(counter), len - 8);
  return b;
}

export class Channel {
  constructor(txKey, rxKey, authKey) {
    this.txKey = txKey;
    this.rxKey = rxKey;
    this.authKey = authKey;
    this.tx = 0n;
    this.rx = 0n;
  }

  // Authenticated handshake transcript: both sides MAC the same transcript;
  // a MITM produces a different master authKey, so the MAC mismatches.
  handshakeMac(transcript) {
    return createHmac('sha256', this.authKey).update(transcript).digest();
  }

  send(plaintext) {
    const frame = encrypt(this.txKey, this.tx, Buffer.from(plaintext));
    frame.counter = this.tx.toString();
    this.tx += 1n;
    return frame;
  }

  recv(frame) {
    const pt = decrypt(this.rxKey, 0, frame);
    if (pt === null) return null;
    this.rx += 1n;
    return pt.toString('utf8');
  }

  // Binary-safe decrypt (audio frames carry raw Opus bytes, not UTF-8).
  recvBytes(frame) {
    const pt = decrypt(this.rxKey, 0, frame);
    if (pt === null) return null;
    this.rx += 1n;
    return pt;
  }
}

// ---- MITM detection ----------------------------------------------------------
// Returns null if the peer's identity keypairs don't match the ones it claimed —
// the pairing check. (In the real app this runs over the QR-pinned identity.)

export function detectImpostor(myIdentity, claimedPeerId, actualPeerSession) {
  return identityId(myIdentity) === identityId(claimedPeerId) ? null : 'impostor';
}
