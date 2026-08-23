package com.agentmobile.agent;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.InvalidAlgorithmParameterException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.AlgorithmParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * KoCrypto — byte-for-byte port of the Node AEAD channel (proto.js), PROTOCOL v2.
 *
 * X25519 4-DH + HKDF-SHA256("agent-mobile/v2") -> client tx key, client rx key, authKey.
 * Handshake: hello -> reply{server_identity, server_eph, mac} -> confirm. The client
 * verifies mac = HMAC(authKey, "server"||0||transcript) and compares server_identity to
 * its PIN before sending confirm = HMAC(authKey, "client"||0||transcript).
 *
 * Wire frame: [type:1][nonce:12][tag:16][ciphertext] (transport/wsframes.js).
 *   aad   = [type]                                 (routing byte is authenticated)
 *   nonce = [stream u32 BE][counter u64 BE]        (stream 0 = WS, 1 = UDP media)
 * {@link Channel} keeps one monotonic send counter per stream and a per-stream
 * anti-replay window on receive — replayed / reordered-too-far frames are rejected.
 *
 * This class uses only java.base and javax.crypto, so it compiles for Android (API 28+ has
 * X25519 + ChaCha20-Poly1305) AND runs on the host JVM for the interop test.
 */
public final class KoCrypto {
    public static final int PROTO_VERSION = 2;
    public static final String HKDF_INFO = "agent-mobile/v2";
    public static final int NONCE_LEN = 12;
    public static final int TAG_LEN = 16;
    public static final int KEY_LEN = 32;
    public static final int HEADER_LEN = 1 + NONCE_LEN + TAG_LEN;
    public static final int TYPE_CMD = 0, TYPE_AUDIO = 1, TYPE_GAP = 2, TYPE_PING = 3, TYPE_PONG = 4;
    public static final int STREAM_WS = 0, STREAM_UDP = 1, MAX_STREAMS = 4;
    public static final int REPLAY_WINDOW = 1024;
    private static final long MAX_COUNTER = (1L << 53) - 1; // matches the JS Number range

    private static final String[] XDH = { "X25519", "XDH" };

    private KoCrypto() {}

    // ---- keys -----------------------------------------------------------------
    public static KeyPair genXdh() {
        // Battle-tested native X25519 only (Conscrypt/BoringSSL on Android, SunEC on the
        // JVM). Algorithm is "X25519" on the JVM and "XDH" on Android. Do NOT force an
        // algorithm parameter spec here — it breaks Android's Conscrypt provider.
        Exception last = new Exception("none");
        for (String a : XDH) {
            try {
                KeyPairGenerator kpg = KeyPairGenerator.getInstance(a);
                return kpg.generateKeyPair();
            } catch (Exception e) { last = e; }
        }
        throw new IllegalStateException("X25519 not available on this platform", last);
    }

    /** SPKI DER of the public key (matches Node's spki/der export). */
    public static byte[] exportPublic(KeyPair kp) {
        return kp.getPublic().getEncoded();
    }

    /** PKCS8 DER of the private key (for the persistent identity store). */
    public static byte[] exportPrivate(KeyPair kp) {
        return kp.getPrivate().getEncoded();
    }

    /** Rebuild a keypair from stored PKCS8 (private) + SPKI (public) DER. */
    public static KeyPair importKeyPair(byte[] pkcs8Priv, byte[] spkiPub) {
        Exception last = new Exception("none");
        for (String a : XDH) {
            try {
                KeyFactory kf = KeyFactory.getInstance(a);
                PrivateKey priv = kf.generatePrivate(new PKCS8EncodedKeySpec(pkcs8Priv));
                PublicKey pub = kf.generatePublic(new X509EncodedKeySpec(spkiPub));
                return new KeyPair(pub, priv);
            } catch (Exception e) { last = e; }
        }
        throw new IllegalStateException("cannot import X25519 keypair", last);
    }

    public static String identityId(PublicKey pub) {
        return identityIdDer(pub.getEncoded());
    }

    /** Agent id straight from a peer SPKI public key (matches Node identityId). */
    public static String identityIdDer(byte[] spkiDer) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(spkiDer), 4); // 8 hex chars, same as Node identityId()
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Diffie-Hellman against a peer X25519 public key (SPKI DER). */
    public static byte[] dh(PrivateKey mine, byte[] peerSpkiDer) {
        Exception last = new Exception("none");
        for (String a : XDH) {
            try {
                KeyFactory kf = KeyFactory.getInstance(a);
                PublicKey peer = kf.generatePublic(new X509EncodedKeySpec(peerSpkiDer));
                KeyAgreement ka = KeyAgreement.getInstance(a);
                ka.init(mine);
                ka.doPhase(peer, true);
                return ka.generateSecret();
            } catch (Exception e) { last = e; }
        }
        throw new RuntimeException("XDH failed", last);
    }

    // ---- HKDF (RFC 5869, matching Node crypto.hkdfSync with empty salt) ----------
    public static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int outLen) {
        try {
            byte[] s = (salt == null || salt.length == 0) ? new byte[32] : salt; // HashLen zeros
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(s, "HmacSHA256"));
            byte[] prk = m.doFinal(ikm);
            ByteArrayOutputStream okm = new ByteArrayOutputStream();
            byte[] t = new byte[0];
            for (int i = 1; okm.size() < outLen; i++) {
                Mac m2 = Mac.getInstance("HmacSHA256");
                m2.init(new SecretKeySpec(prk, "HmacSHA256"));
                m2.update(t);
                m2.update(info);
                m2.update((byte) i);
                t = m2.doFinal();
                okm.write(t, 0, t.length);
            }
            return Arrays.copyOf(okm.toByteArray(), outLen);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static byte[] hmacSha256(byte[] key, byte[]... parts) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            for (byte[] p : parts) m.update(p);
            return m.doFinal();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * Client-side 4-DH session -> Channel(tx = k[0:32], rx = k[32:64], auth = k[64:96]);
     * matches Node sessionFrom('client', ...).
     */
    public static Channel deriveClientSession(KeyPair clientId, byte[] serverIdPub,
                                              KeyPair clientEph, byte[] serverEphPub) {
        byte[] s1 = dh(clientId.getPrivate(), serverIdPub);
        byte[] s2 = dh(clientId.getPrivate(), serverEphPub);
        byte[] s3 = dh(clientEph.getPrivate(), serverIdPub);
        byte[] s4 = dh(clientEph.getPrivate(), serverEphPub);
        byte[][] arr = { s1, s2, s3, s4 };
        Arrays.sort(arr, (a, b) -> Arrays.compareUnsigned(a, b)); // canonical order
        ByteArrayOutputStream c = new ByteArrayOutputStream();
        for (byte[] x : arr) c.writeBytes(x);
        byte[] k = hkdfSha256(c.toByteArray(), new byte[0], HKDF_INFO.getBytes(StandardCharsets.UTF_8), KEY_LEN * 4);
        return new Channel(
            Arrays.copyOfRange(k, 0, KEY_LEN),
            Arrays.copyOfRange(k, KEY_LEN, KEY_LEN * 2),
            Arrays.copyOfRange(k, KEY_LEN * 2, KEY_LEN * 3));
    }

    // ---- handshake transcript (mirrors proto.js transcript()) ---------------------
    public static byte[] transcript(byte[] cId, byte[] cEph, byte[] sId, byte[] sEph) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.writeBytes(HKDF_INFO.getBytes(StandardCharsets.UTF_8));
        for (byte[] b : new byte[][] { cId, cEph, sId, sEph }) {
            o.write((b.length >>> 8) & 0xff); o.write(b.length & 0xff);
            o.writeBytes(b);
        }
        return o.toByteArray();
    }

    /** HMAC(authKey, label || 0x00 || transcript). label = "server" | "client". */
    public static byte[] handshakeMac(byte[] authKey, String label, byte[] transcript) {
        return hmacSha256(authKey, label.getBytes(StandardCharsets.UTF_8), new byte[] { 0 }, transcript);
    }

    /**
     * Client handshake state machine (pure; JSON I/O stays with the caller). Usage:
     *   hs = new ClientHandshake(persistentIdentity); ws.send(hs.helloJson());
     *   r = hs.finish(serverIdPub, serverEphPub, mac, pinnedOrNull); ws.send(r.confirmJson);
     */
    public static final class ClientHandshake {
        public final KeyPair identity, eph;
        public final byte[] identityPub, ephPub;
        public ClientHandshake(KeyPair identity) {
            this.identity = identity;
            this.eph = genXdh();
            this.identityPub = exportPublic(identity);
            this.ephPub = exportPublic(eph);
        }
        public String clientId() { return identityId(identity.getPublic()); }
        public String helloJson() {
            // base64 + hex only -> safe to build by hand (no escaping needed)
            return "{\"v\":" + PROTO_VERSION
                + ",\"client_id\":\"" + clientId() + "\""
                + ",\"client_identity\":\"" + Base64.getEncoder().encodeToString(identityPub) + "\""
                + ",\"client_eph\":\"" + Base64.getEncoder().encodeToString(ephPub) + "\"}";
        }
        /**
         * Verify the server reply and derive the session. Throws GeneralSecurityException
         * with message "identity_mismatch" (server != pin) or "mac_mismatch" (server could
         * not prove its identity key). pinnedServerIdPub == null means TOFU: the caller must
         * get user confirmation of result.agentId and pin result.serverIdPub itself.
         */
        public Result finish(byte[] serverIdPub, byte[] serverEphPub, byte[] mac, byte[] pinnedServerIdPub)
                throws GeneralSecurityException {
            if (serverIdPub == null || serverEphPub == null || mac == null) throw new GeneralSecurityException("bad_reply");
            if (pinnedServerIdPub != null && !MessageDigest.isEqual(pinnedServerIdPub, serverIdPub))
                throw new GeneralSecurityException("identity_mismatch");
            Channel ch = deriveClientSession(identity, serverIdPub, eph, serverEphPub);
            byte[] tr = transcript(identityPub, ephPub, serverIdPub, serverEphPub);
            byte[] expect = handshakeMac(ch.authKey, "server", tr);
            if (!MessageDigest.isEqual(expect, mac)) throw new GeneralSecurityException("mac_mismatch");
            byte[] confirm = handshakeMac(ch.authKey, "client", tr);
            String confirmJson = "{\"v\":" + PROTO_VERSION + ",\"confirm\":\"" + Base64.getEncoder().encodeToString(confirm) + "\"}";
            return new Result(ch, serverIdPub, identityIdDer(serverIdPub), confirmJson);
        }
        public static final class Result {
            public final Channel channel; public final byte[] serverIdPub; public final String agentId; public final String confirmJson;
            Result(Channel c, byte[] s, String a, String j) { channel = c; serverIdPub = s; agentId = a; confirmJson = j; }
        }
    }

    // ---- anti-replay window (mirrors proto.js ReplayWindow) ----------------------------
    public static final class ReplayWindow {
        private final int size;
        private long max = -1;
        private final byte[] seen;
        public ReplayWindow(int size) { this.size = size; this.seen = new byte[size]; }
        public synchronized boolean accepts(long c) {
            if (c < 0) return false;
            if (c > max) return true;
            if (max - c >= size) return false;
            return seen[(int) (c % size)] == 0;
        }
        public synchronized void mark(long c) {
            if (c > max) {
                long shift = c - max;
                if (shift >= size) Arrays.fill(seen, (byte) 0);
                else for (long x = max + 1; x < c; x++) seen[(int) (x % size)] = 0;
                max = c;
            }
            seen[(int) (c % size)] = 1;
        }
    }

    // ---- channel ---------------------------------------------------------------------------
    public static final class Channel {
        public final byte[] txKey, rxKey, authKey;
        private final AtomicLong[] tx = new AtomicLong[MAX_STREAMS];
        private final ReplayWindow[] rx = new ReplayWindow[MAX_STREAMS];
        public final AtomicLong rejectedReplay = new AtomicLong(), rejectedAuth = new AtomicLong();

        public Channel(byte[] txKey, byte[] rxKey, byte[] authKey) {
            this.txKey = txKey; this.rxKey = rxKey; this.authKey = authKey;
            for (int i = 0; i < MAX_STREAMS; i++) { tx[i] = new AtomicLong(); rx[i] = new ReplayWindow(REPLAY_WINDOW); }
        }

        public byte[] handshakeMac(String label, byte[] transcript) { return KoCrypto.handshakeMac(authKey, label, transcript); }
        public long txCounter(int stream) { return tx[stream].get(); }

        /** Seal one typed message on the WS stream -> wire frame [type][nonce][tag][ct]. */
        public byte[] seal(int type, byte[] pt) { return seal(type, pt, STREAM_WS); }

        public byte[] seal(int type, byte[] pt, int stream) {
            if (stream < 0 || stream >= MAX_STREAMS) throw new IllegalArgumentException("bad stream");
            long c = tx[stream].getAndIncrement();
            if (c >= MAX_COUNTER) throw new IllegalStateException("counter exhausted; rekey");
            byte[] nonce = nonceFor(stream, c);
            return sealWith(txKey, type, nonce, pt);
        }

        /**
         * Open a wire frame. Throws on malformed / auth failure / replay (callers drop).
         * Only a GENUINE frame advances the anti-replay window.
         */
        public byte[] open(byte[] frame) throws GeneralSecurityException {
            if (frame == null || frame.length < HEADER_LEN) throw new GeneralSecurityException("short frame");
            int type = frame[0] & 0xff;
            byte[] nonce = Arrays.copyOfRange(frame, 1, 1 + NONCE_LEN);
            byte[] tag = Arrays.copyOfRange(frame, 1 + NONCE_LEN, HEADER_LEN);
            byte[] ct = Arrays.copyOfRange(frame, HEADER_LEN, frame.length);
            int stream = ((nonce[0] & 0xff) << 24) | ((nonce[1] & 0xff) << 16) | ((nonce[2] & 0xff) << 8) | (nonce[3] & 0xff);
            long counter = 0; for (int i = 4; i < 12; i++) counter = (counter << 8) | (nonce[i] & 0xffL);
            if (stream < 0 || stream >= MAX_STREAMS || counter < 0 || counter > MAX_COUNTER)
                throw new GeneralSecurityException("bad nonce");
            ReplayWindow w = rx[stream];
            if (!w.accepts(counter)) { rejectedReplay.incrementAndGet(); throw new GeneralSecurityException("replay"); }
            byte[] pt;
            try { pt = openWith(rxKey, type, nonce, tag, ct); }
            catch (GeneralSecurityException e) { rejectedAuth.incrementAndGet(); throw e; }
            w.mark(counter);
            return pt;
        }
    }

    public static byte[] nonceFor(int stream, long counter) {
        byte[] n = new byte[NONCE_LEN];
        n[0] = (byte) (stream >>> 24); n[1] = (byte) (stream >>> 16); n[2] = (byte) (stream >>> 8); n[3] = (byte) stream;
        for (int i = 7; i >= 0; i--) { n[4 + i] = (byte) (counter & 0xff); counter >>>= 8; }
        return n;
    }

    // ---- ChaCha20-Poly1305 (RFC 8439, interops with Node) -----------------------
    /** Seal with an explicit nonce; aad = [type]. */
    public static byte[] sealWith(byte[] key, int type, byte[] nonce, byte[] pt) {
        try {
            byte[] aad = { (byte) type };
            // Host JVM (JDK): IvParameterSpec, tag appended to output.
            try {
                Cipher c = init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec(nonce));
                c.updateAAD(aad);
                byte[] out = c.doFinal(pt); // ct||tag
                int ctLen = out.length - TAG_LEN;
                return compose(type, nonce,
                    Arrays.copyOfRange(out, ctLen, out.length),
                    Arrays.copyOfRange(out, 0, ctLen));
            } catch (InvalidAlgorithmParameterException jdkIAP) {
                // Android (Conscrypt): GCMParameterSpec, tag NOT appended -> getAuthTag().
                Cipher c = init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_LEN * 8, nonce));
                c.updateAAD(aad);
                byte[] ct = c.doFinal(pt);
                return compose(type, nonce, getTagReflect(c), ct);
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Open ct with nonce/tag; aad = [type]. Throws on auth failure (bad key/tamper). */
    public static byte[] openWith(byte[] key, int type, byte[] nonce, byte[] tag, byte[] ct) throws GeneralSecurityException {
        byte[] aad = { (byte) type };
        try {
            // Host JVM: IvParameterSpec, feed ct||tag.
            Cipher d = init(Cipher.DECRYPT_MODE, key, new IvParameterSpec(nonce));
            d.updateAAD(aad);
            byte[] ae = new byte[ct.length + TAG_LEN];
            System.arraycopy(ct, 0, ae, 0, ct.length);
            System.arraycopy(tag, 0, ae, ct.length, TAG_LEN);
            return d.doFinal(ae);
        } catch (InvalidAlgorithmParameterException jdkIAP) {
            // Android: GCMParameterSpec + setAuthTag + plain ct.
            Cipher d = init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_LEN * 8, nonce));
            d.updateAAD(aad);
            setTagReflect(d, tag);
            return d.doFinal(ct);
        }
    }

    /** Reflectively invoke Cipher.getAuthTag() (Android runtime; absent from stubs/JDK core). */
    private static byte[] getTagReflect(Cipher c) throws GeneralSecurityException {
        try { return (byte[]) Cipher.class.getMethod("getAuthTag").invoke(c); }
        catch (Exception e) { throw new GeneralSecurityException("getAuthTag unavailable", e); }
    }

    private static void setTagReflect(Cipher c, byte[] tag) throws GeneralSecurityException {
        try { Cipher.class.getMethod("setAuthTag", byte[].class).invoke(c, (Object) tag); }
        catch (Exception e) { throw new GeneralSecurityException("setAuthTag unavailable", e); }
    }

    private static Cipher init(int mode, byte[] key, AlgorithmParameterSpec spec) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("ChaCha20-Poly1305");
        c.init(mode, new SecretKeySpec(key, "ChaCha20"), spec);
        return c;
    }

    private static byte[] compose(int type, byte[] nonce, byte[] tag, byte[] ct) {
        byte[] f = new byte[1 + NONCE_LEN + TAG_LEN + ct.length];
        f[0] = (byte) type;
        System.arraycopy(nonce, 0, f, 1, NONCE_LEN);
        System.arraycopy(tag, 0, f, 1 + NONCE_LEN, TAG_LEN);
        System.arraycopy(ct, 0, f, 1 + NONCE_LEN + TAG_LEN, ct.length);
        return f;
    }

    private static String toHex(byte[] b, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) sb.append(String.format("%02x", b[i]));
        return sb.toString();
    }
}
