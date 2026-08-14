package com.agentmobile.agent;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.InvalidAlgorithmParameterException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.AlgorithmParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * KoCrypto — byte-for-byte port of the Node AEAD channel (prototype/proto.js).
 *
 * X25519 4-DH + HKDF-SHA256 -> two ChaCha20-Poly1305 keys (client tx, client rx).
 * Addressability order is canonicalized by sorting the four shared secrets, and the
 * wire frame is [type:1][nonce:12][tag:16][ciphertext...] — matching transport/wsframes.js.
 *
 * This class uses only java.base and javax.crypto, so it compiles for Android (API 28+ has
 * X25519 + ChaCha20-Poly1305) AND runs on the host JVM for the interop test.
 */
public final class KoCrypto {
    public static final int NONCE_LEN = 12;
    public static final int TAG_LEN = 16;
    public static final int KEY_LEN = 32;
    public static final int TYPE_CMD = 0, TYPE_AUDIO = 1, TYPE_GAP = 2, TYPE_PING = 3, TYPE_PONG = 4;

    private static final String[] XDH = { "X25519", "XDH" };
    private static final SecureRandom RND = new SecureRandom();

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

    public static String identityId(PublicKey pub) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(pub.getEncoded());
            return toHex(h, 4); // 8 hex chars, same as Node identityId()
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Agent id straight from a peer SPKI public key (matches Node identityId). */
    public static String identityIdDer(byte[] spkiDer) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(spkiDer), 4);
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

    /**
     * Client-side 4-DH session. Returns { txKey, rxKey } (client tx = first 32 bytes,
     * rx = next 32 — matches Node sessionFrom('client', ...)).
     */
    public static byte[][] deriveClientSession(KeyPair clientId, byte[] serverIdPub,
                                               KeyPair clientEph, byte[] serverEphPub) {
        byte[] s1 = dh(clientId.getPrivate(), serverIdPub);
        byte[] s2 = dh(clientId.getPrivate(), serverEphPub);
        byte[] s3 = dh(clientEph.getPrivate(), serverIdPub);
        byte[] s4 = dh(clientEph.getPrivate(), serverEphPub);
        byte[][] arr = { s1, s2, s3, s4 };
        Arrays.sort(arr, (a, b) -> Arrays.compareUnsigned(a, b)); // canonical order
        ByteArrayOutputStream c = new ByteArrayOutputStream();
        for (byte[] x : arr) c.writeBytes(x);
        byte[] k = hkdfSha256(c.toByteArray(), new byte[0], "agent-mobile/v1".getBytes(StandardCharsets.UTF_8), KEY_LEN * 4);
        return new byte[][] {
            Arrays.copyOfRange(k, 0, KEY_LEN),
            Arrays.copyOfRange(k, KEY_LEN, KEY_LEN * 2),
        };
    }

    // ---- ChaCha20-Poly1305 (RFC 8439, interops with Node) -----------------------
    public static byte[] randomNonce() {
        byte[] n = new byte[NONCE_LEN];
        RND.nextBytes(n);
        return n;
    }

    /** Seal one typed message -> wire frame [type][nonce][tag][ct]. */
    public static byte[] sealMessage(byte[] key, int type, byte[] pt) {
        try {
            byte[] nonce = randomNonce();
            // Host JVM (JDK): IvParameterSpec, tag appended to output.
            try {
                Cipher c = init(Cipher.ENCRYPT_MODE, key, nonce, new IvParameterSpec(nonce));
                byte[] out = c.doFinal(pt); // ct||tag
                int ctLen = out.length - TAG_LEN;
                return compose(type, nonce,
                    Arrays.copyOfRange(out, ctLen, out.length),
                    Arrays.copyOfRange(out, 0, ctLen));
            } catch (InvalidAlgorithmParameterException jdkIAP) {
                // Android (Conscrypt): GCMParameterSpec, tag NOT appended -> getAuthTag().
                Cipher c = init(Cipher.ENCRYPT_MODE, key, nonce, new GCMParameterSpec(TAG_LEN * 8, nonce));
                byte[] ct = c.doFinal(pt);
                return compose(type, nonce, getTagReflect(c), ct);
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Open a wire frame [type][nonce][tag][ct]. Throws on auth failure (bad key/tamper). */
    public static byte[] openMessage(byte[] key, byte[] frame) throws Exception {
        int o = 0;
        int type = frame[o++] & 0xff;
        byte[] nonce = Arrays.copyOfRange(frame, o, o + NONCE_LEN); o += NONCE_LEN;
        byte[] tag = Arrays.copyOfRange(frame, o, o + TAG_LEN); o += TAG_LEN;
        byte[] ct = Arrays.copyOfRange(frame, o, frame.length);
        try {
            // Host JVM: IvParameterSpec, feed ct||tag.
            Cipher d = init(Cipher.DECRYPT_MODE, key, nonce, new IvParameterSpec(nonce));
            byte[] ae = new byte[ct.length + TAG_LEN];
            System.arraycopy(ct, 0, ae, 0, ct.length);
            System.arraycopy(tag, 0, ae, ct.length, TAG_LEN);
            return d.doFinal(ae);
        } catch (InvalidAlgorithmParameterException jdkIAP) {
            // Android: GCMParameterSpec + setAuthTag + plain ct.
            Cipher d = init(Cipher.DECRYPT_MODE, key, nonce, new GCMParameterSpec(TAG_LEN * 8, nonce));
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

    private static Cipher init(int mode, byte[] key, byte[] nonce, AlgorithmParameterSpec spec) throws GeneralSecurityException {
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
