// wsframes.js — wire format for AEAD frames over WebSocket.
//
// Every WS message carries ONE authenticated sealed box:
//   [ type u8 ][ nonce 12 ][ tag 16 ][ ciphertext ... ]
// The box is produced by proto.js Channel.send() (ChaCha20-Poly1305). type is a
// routing hint only; identity/seq/ts live inside the authenticated plaintext, so
// a forged type cannot carry forged data (the key is required to make a valid ct).

export const T = { cmd: 0, audio: 1, gap: 2, ping: 3, pong: 4 };
export const RT = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

export function pack(type, box) {
  // box = { nonce, ct, tag } Buffers
  return Buffer.concat([Buffer.from([type]), box.nonce, box.tag, box.ct]);
}

export function unpack(buf) {
  let o = 0;
  const type = buf[o++];
  const nonce = buf.subarray(o, o + 12); o += 12;
  const tag = buf.subarray(o, o + 16); o += 16;
  const ct = buf.subarray(o);
  return { type, nonce, tag, ct };
}

// ---- authenticated plaintext codecs -----------------------------------------
export function packAudio(seq, tsMs, opusBytes) {
  const out = Buffer.alloc(4 + 8 + opusBytes.length);
  out.writeUInt32BE(seq, 0);
  out.writeBigUInt64BE(BigInt(tsMs), 4);
  opusBytes.copy(out, 12);
  return out;
}
export function unpackAudio(buf) {
  const seq = buf.readUInt32BE(0);
  const tsMs = Number(buf.readBigUInt64BE(4));
  const opus = buf.subarray(12);
  return { seq, tsMs, opus };
}
