package com.agentmobile.agent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.security.KeyPair;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * IdentityStore — the phone's PERSISTENT X25519 identity + per-host server pins.
 *
 * <p>The client identity used to be regenerated on every connection, so the gateway
 * could never recognise (allowlist) this phone and "pairing" meant nothing. Now one
 * keypair is generated on first use and kept in app-private SharedPreferences; the
 * private key is wrapped with an AES-GCM key that lives in the AndroidKeyStore (never
 * exported), so a backup / file read yields only ciphertext.
 *
 * <p>Pins: the server's SPKI (base64) per gateway host. First connection to a host is
 * trust-on-first-use behind a native confirmation dialog showing the fingerprint; every
 * later connection must present exactly that key or the plugin refuses to talk.
 */
public final class IdentityStore {
    private static final String TAG = "IdentityStore";
    private static final String PREFS = "agentmob.identity";
    private static final String K_PUB = "id.pub";               // SPKI DER b64
    private static final String K_PRIV = "id.priv.wrapped";     // AES-GCM(PKCS8 DER) b64
    private static final String K_PRIV_IV = "id.priv.iv";       // GCM iv b64
    private static final String K_PRIV_PLAIN = "id.priv.plain"; // fallback only (no Keystore)
    private static final String KS_ALIAS = "agentmob.idwrap";
    private static final String PIN_PREFIX = "pin.";

    private final SharedPreferences prefs;
    private KeyPair cached;

    public IdentityStore(Context ctx) {
        this.prefs = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The phone's identity keypair — generated once, then reused forever. */
    public synchronized KeyPair loadOrCreate() {
        if (cached != null) return cached;
        try {
            String pub = prefs.getString(K_PUB, null);
            if (pub != null) {
                byte[] pubDer = Base64.decode(pub, Base64.NO_WRAP);
                byte[] privDer = null;
                String wrapped = prefs.getString(K_PRIV, null), iv = prefs.getString(K_PRIV_IV, null);
                if (wrapped != null && iv != null) {
                    privDer = unwrap(Base64.decode(wrapped, Base64.NO_WRAP), Base64.decode(iv, Base64.NO_WRAP));
                } else if (prefs.getString(K_PRIV_PLAIN, null) != null) {
                    privDer = Base64.decode(prefs.getString(K_PRIV_PLAIN, null), Base64.NO_WRAP);
                }
                if (privDer != null) { cached = KoCrypto.importKeyPair(privDer, pubDer); return cached; }
            }
        } catch (Exception e) {
            Log.w(TAG, "stored identity unreadable, regenerating: " + e);
        }
        KeyPair kp = KoCrypto.genXdh();
        save(kp);
        cached = kp;
        return kp;
    }

    private void save(KeyPair kp) {
        SharedPreferences.Editor ed = prefs.edit();
        ed.putString(K_PUB, Base64.encodeToString(KoCrypto.exportPublic(kp), Base64.NO_WRAP));
        ed.remove(K_PRIV).remove(K_PRIV_IV).remove(K_PRIV_PLAIN);
        byte[] priv = KoCrypto.exportPrivate(kp);
        try {
            byte[][] w = wrap(priv);
            ed.putString(K_PRIV, Base64.encodeToString(w[0], Base64.NO_WRAP));
            ed.putString(K_PRIV_IV, Base64.encodeToString(w[1], Base64.NO_WRAP));
        } catch (Exception e) {
            // Keystore unavailable (emulator oddities): still app-private storage, but log loudly.
            Log.e(TAG, "AndroidKeyStore wrap failed; storing identity unwrapped in app-private prefs: " + e);
            ed.putString(K_PRIV_PLAIN, Base64.encodeToString(priv, Base64.NO_WRAP));
        }
        ed.apply();
    }

    public String clientId() { return KoCrypto.identityId(loadOrCreate().getPublic()); }

    // ---- server pins ----------------------------------------------------------
    /** Pinned server SPKI (DER) for a gateway host, or null if never paired. */
    public synchronized byte[] getPin(String host) {
        String s = prefs.getString(PIN_PREFIX + host, null);
        return s == null ? null : Base64.decode(s, Base64.NO_WRAP);
    }
    public synchronized void setPin(String host, byte[] serverSpkiDer) {
        prefs.edit().putString(PIN_PREFIX + host, Base64.encodeToString(serverSpkiDer, Base64.NO_WRAP)).apply();
    }
    public synchronized void clearPin(String host) {
        prefs.edit().remove(PIN_PREFIX + host).apply();
    }

    // ---- AndroidKeyStore AES-GCM wrapping of the private key -----------------------
    private static SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KS_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KS_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return kg.generateKey();
    }
    private static byte[][] wrap(byte[] plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, wrapKey());
        return new byte[][] { c.doFinal(plain), c.getIV() };
    }
    private static byte[] unwrap(byte[] ct, byte[] iv) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, iv));
        return c.doFinal(ct);
    }
}
