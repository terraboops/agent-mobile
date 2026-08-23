package com.agentmobile.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.activity.result.ActivityResult;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import io.github.jaredmdobson.OpusApplication;
import io.github.jaredmdobson.OpusDecoder;
import io.github.jaredmdobson.OpusEncoder;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import javax.net.SocketFactory;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.net.URISyntaxException;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.URI;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * AgentChannel — Capacitor plugin exposing the AEAD WebSocket channel to the web-layer.
 *
 * <p>The webview's ONLY native surface (window.Capacitor.Plugins.AgentChannel):
 *   connect(url), send(payload), identify(), startAudio(), stopAudio(), resetPairing(). Everything
 *   else lives behind the AEAD channel over WebSocket; the webview never touches the network directly.
 *
 * <p>Protocol v2 (KoCrypto / proto.js): persistent phone identity (IdentityStore), server
 *   transcript MAC verified + server identity PINNED per host (first contact = native TOFU dialog),
 *   client confirm MAC, type byte authenticated, per-stream counters + anti-replay windows.
 *
 * <p>Audio is NATIVE, capability-gated, user-consented (RECORD_AUDIO via Capacitor's @Permission
 * + @PermissionCallback flow). Voice is captured with AudioRecord, encoded with Concentus
 * (pure-Java Opus, bit-exact with libopus), wrapped in the wire frame [seq u32][tsMs u64][opus]
 * (matches transport/wsframes.js packAudio) and sealed as a TYPE_AUDIO box. Downlink frames are
 * decoded and played on AudioTrack (full duplex).
 */
@CapacitorPlugin(
    name = "AgentChannel",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    })
public class AgentChannelPlugin extends Plugin {

    private final ConcurrentLinkedQueue<byte[]> buffer = new ConcurrentLinkedQueue<>();
    // Partition buffer bound: ~4 MB (≈15 min of Opus) — beyond that the OLDEST AUDIO frames
    // are dropped first (stale speech is worthless after minutes), commands are kept.
    private static final long MAX_BUFFER_BYTES = 4L * 1024 * 1024;
    private static final int MAX_BUFFER_FRAMES = 12000;
    private final AtomicLong bufferedBytes = new AtomicLong();
    private final Map<Integer, PluginCall> pending = new ConcurrentHashMap<>();
    private final Map<Integer, Long> pendingAt = new ConcurrentHashMap<>(); // mid -> elapsedRealtime when sent
    private final AtomicInteger msgId = new AtomicInteger();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private OkHttpClient client;
    private volatile WebSocket ws;
    // Session: ONE authenticated channel (AEAD keys + per-stream counters/replay windows).
    // null until the v2 handshake (MAC verified + identity pinned + confirm sent) completes.
    private volatile KoCrypto.Channel channel;
    private volatile KoCrypto.ClientHandshake hs;
    private IdentityStore idStore;                  // persistent X25519 identity + server pins
    private volatile boolean identityBlocked;       // pinned identity mismatch: refuse until reset
    private volatile String pinnedState = ID_DISCONNECTED;
    private volatile boolean connected;
    private volatile boolean derived;
    private volatile int failures;
    private volatile long lastRx;
    private volatile boolean keepaliveRunning;
    private PluginCall connectCall;
    private volatile boolean connectConsented; // native per-capability consent gate (connect)
    private volatile String consentedHost;     // the ONE gateway host the user consented to

    // Identity badge states (native overlay in MainActivity — the webview cannot reach it).
    public static final String ID_VERIFIED = "verified";      // MAC ok AND server SPKI == stored pin
    public static final String ID_PAIRED = "paired";          // first contact: MAC ok, user confirmed, pinned now
    public static final String ID_MISMATCH = "mismatch";      // server SPKI != pin: refused
    public static final String ID_ERROR = "error";            // MAC / handshake failure
    public static final String ID_DISCONNECTED = "disconnected";
    public interface IdentitySink { void onIdentity(String agentId, String state); }

    // auto-reconnect: re-establish the session when the socket truly dies
    // (gateway restart), WITHOUT touching partition-reconnect semantics
    // (keepalive failures keep buffering; they never close the socket).
    private volatile String lastUrl;
    private volatile boolean destroying;
    private volatile long reconnectDelayMs = 2000;
    private final Object reconnectLock = new Object();
    private volatile boolean reconnectPending;

    private long baseMs = 2000, maxMs = 64000;
    private int partitionThreshold = 3;
    private long probeTimeoutMs = 1000;

    // audio (Opus full-duplex, 24 kHz mono, 20 ms frames)
    private static final int AUDIO_RATE = 24000;
    private static final int AUDIO_FRAME = 480; // 20 ms at 24 kHz
    private final AtomicLong audioSeq = new AtomicLong();
    private final AtomicLong mediaSeq = new AtomicLong();
    // UDP media path (spotty-cellular): audio off TCP onto UDP+adaptive jitter
    // buffer. Null / !udpUp => WS fallback keeps the app working.
    private volatile UdpMedia media;
    private volatile boolean udpUp;
    // WebRTC media (AEC/NetEQ/DTLS-SRTP) owner of the mic+speaker once connected.
    private volatile WebRtcMedia webRtc;
    private volatile short[] lastReplyPcm;
    private final short[] pcmOut = new short[AUDIO_FRAME];
    // Unbounded playback queues: a reply must NEVER drop a frame on offer(),
    // or the tail (or middle) of the reply goes silent. The playback threads
    // drain at real-time (AudioTrack.write blocks), so the queue depth is
    // naturally bounded by reply length — the true backpressure is the audio
    // device, not a fixed buffer. (A fixed ABQ silently dropped every reply
    // longer than the capacity — the "cut off and silent" bug.)
    private final LinkedBlockingQueue<short[]> playQueue = new LinkedBlockingQueue<>();
    private final LinkedBlockingQueue<short[]> replyQueue = new LinkedBlockingQueue<>();
    // Pre-roll: insert a short silence pad at the START of each reply so playback
    // never begins on an under-primed buffer (which clipped the first 1-2s).
    private static final int REPLY_PREROLL = 8; // frames of 20ms = 160ms
    private volatile long lastReplyEnqMs;
    private long decoded;
    private long lvlFrames = 0;
    private long rxAudioFrames;
    private volatile Thread audioPlayingThread;
    private volatile AudioRecord recorder;
    private volatile AudioTrack track;
    private volatile OpusEncoder encoder;
    private volatile OpusDecoder decoder;
    private volatile Thread audioThread;
    private volatile boolean audioRunning;
    // reply-only playback (works even when the mic/capture is toggled off)
    private volatile AudioTrack playTrack;
    private volatile OpusDecoder playDecoder;
    private volatile Thread replyThread;
    private volatile long replyActiveUntil; // echo gate: pause mic while a reply plays

    // ---- Capacitor API ------------------------------------------------------
    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("url required"); return; }
        if (call.getInt("baseMs") != null) baseMs = call.getInt("baseMs");
        if (call.getInt("maxMs") != null) maxMs = call.getInt("maxMs");
        if (call.getInt("threshold") != null) partitionThreshold = call.getInt("threshold");
        if (call.getInt("probeTimeoutMs") != null) probeTimeoutMs = call.getInt("probeTimeoutMs");
        // The webview chooses the URL, so the URL is untrusted: only ws:// / wss://, and a
        // consent dialog is required for EVERY distinct host — a one-time "Allow" for host A
        // must not let later JS silently redirect the session (mic audio, surface state) to B.
        String host = hostOf(url);
        if (host == null || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
            call.reject("url must be ws:// or wss:// with a host"); return;
        }
        if (identityBlocked && host.equals(consentedHost)) {
            call.reject("refused: pinned agent identity mismatch for " + host + " (resetPairing to re-pair)"); return;
        }
        connectCall = call;
        if (connectConsented && host.equals(consentedHost)) {
            lastUrl = url;                   // same host: keep for auto-reconnect
            worker.execute(() -> connectWs(url));
        } else {
            requestConnectConsent(call, url); // native per-capability gate (per host)
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String payload = call.getString("payload");
        if (payload == null) { call.reject("payload required"); return; }
        // Guard: until the handshake completes there is NO transmit key. A
        // premature webview send (render_result, surface_state, hello, etc.) must
        // fail cleanly — NEVER let KoCrypto.sealMessage throw and crash the app.
        KoCrypto.Channel ch = channel;
        if (ch == null) { call.reject("not connected"); return; }
        int mid = msgId.incrementAndGet();
        try {
            // Proper JSON encoding (org.json escapes quotes, backslashes, control
            // chars). The old string-concat only escaped '"', so any payload that
            // already contained \" or a newline produced invalid/injected JSON and
            // was silently lost by the agent (e.g. render_result errors with quotes).
            byte[] plain = new JSONObject().put("i", mid).put("d", payload)
                    .toString().getBytes(StandardCharsets.UTF_8);
            byte[] frame = ch.seal(KoCrypto.TYPE_CMD, plain);
            pending.put(mid, call);
            pendingAt.put(mid, SystemClock.elapsedRealtime());
            outbound(frame);
        } catch (Exception e) {
            Log.w("AgentChannel", "send sealed-frame fail: " + e);
            call.reject("send failed: " + e);
        }
    }

    @PluginMethod
    public void identify(PluginCall call) {
        JSObject r = new JSObject();
        r.put("agentId", connected ? pendingAgentId : null);
        r.put("state", pinnedState);
        r.put("clientId", store().clientId());
        call.resolve(r);
    }

    /**
     * Forget the pinned agent identity for the current gateway host (e.g. after the
     * agent legitimately rotated its key). Native confirmation — the webview cannot
     * silently unpin. The next connection goes through first-contact pairing again.
     */
    @PluginMethod
    public void resetPairing(PluginCall call) {
        Activity a = getActivity();
        final String host = hostOf(lastUrl);
        if (a == null || host == null) { call.reject("no activity / no gateway host"); return; }
        a.runOnUiThread(() -> new AlertDialog.Builder(a)
            .setTitle("Forget paired agent?")
            .setMessage("Forget the pinned agent identity for " + host + "?\n\nThe next connection will ask you to confirm the agent fingerprint again. Only do this if you KNOW the agent rotated its key.")
            .setNegativeButton("Keep", (d, w) -> { d.dismiss(); call.reject("kept"); })
            .setPositiveButton("Forget", (d, w) -> { d.dismiss(); store().clearPin(host); identityBlocked = false; badge("", ID_DISCONNECTED); call.resolve(); })
            .setCancelable(false).show());
    }

    private IdentityStore store() {
        IdentityStore st = idStore;
        if (st == null) { st = new IdentityStore(getContext()); idStore = st; }
        return st;
    }

    private static String hostOf(String url) {
        try { return url == null ? null : new URI(url).getHost(); } catch (Exception e) { return null; }
    }

    @PluginMethod
    public void startAudio(PluginCall call) {
        if (micOn()) { call.resolve(); return; }
        if (getActivity() != null
                && getActivity().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startAudioActual();
            call.resolve();
        } else {
            requestPermissionForAlias("microphone", call, "audioPermissionCallback");
        }
    }

    @PermissionCallback
    public void audioPermissionCallback(PluginCall call) {
        if (getActivity() != null
                && getActivity().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startAudioActual();
            call.resolve();
        } else {
            // Denied: say so, instead of resolving as if the mic were on (the ring showed
            // "unmuted" while nothing was being captured).
            JSObject ev = new JSObject(); ev.put("audio", false); ev.put("error", "microphone permission denied");
            notifyListeners("audio", ev);
            call.reject("microphone permission denied");
        }
    }

    @PluginMethod
    public void stopAudio(PluginCall call) {
        stopAudioActual();
        call.resolve();
    }

    @PluginMethod
    public void isAudioRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", micOn());
        call.resolve(r);
    }

    private volatile String pendingAgentId;

    /** Native overlay sink: MainActivity installs it so the agent fingerprint can be shown
     *  on an unforgeable view the webview cannot reach. Fires on the UI thread. */
    private volatile IdentitySink identitySink;
    public void setIdentitySink(IdentitySink sink) { this.identitySink = sink; }

    /** Update the native badge (UI thread). */
    private void badge(String id, String state) {
        pinnedState = state;
        IdentitySink sink = identitySink;
        Activity a = getActivity();
        if (sink == null || a == null) return;
        final String fid = id == null ? "" : id;
        a.runOnUiThread(() -> { try { sink.onIdentity(fid, state); } catch (Exception ignored) {} });
    }

    /** Per-capability native consent before opening the secure session. Webview cannot skip it. */
    private void requestConnectConsent(PluginCall call, String url) {
        Activity a = getActivity();
        if (a == null) { connectCall = null; call.reject("no activity for consent"); return; }
        final String host = hostOf(url) != null ? hostOf(url) : url;
        a.runOnUiThread(() -> {
            new AlertDialog.Builder(a)
                .setTitle("Confirm secure session")
                .setMessage("Allow Agent to open an end-to-end encrypted session to "
                    + host + "?\n\n" + (store().getPin(host) != null
                        ? "This host is paired: the agent must present its pinned identity key or the connection is refused."
                        : "First connection to this host: after the key exchange you will be asked to confirm the agent's fingerprint before anything is sent."))
                .setNegativeButton("Deny", (d, w) -> { d.dismiss(); connectCall = null; call.reject("connection denied by user"); })
                .setPositiveButton("Allow", (d, w) -> {
                    d.dismiss();
                    connectConsented = true; consentedHost = host; lastUrl = url; identityBlocked = false;
                    worker.execute(() -> connectWs(url));
                })
                .setCancelable(false)
                .show();
        });
    }

    @Override
    public void handleOnDestroy() {
        destroying = true;
        keepaliveRunning = false;
        failPending("plugin destroyed");
        stopAudioActual();
        closeWebRtc();
        try { if (ws != null) ws.close(1000, "bye"); } catch (Exception ignored) {}
        worker.shutdownNow();
        super.handleOnDestroy();
    }

    // ---- connection -----------------------------------------------------------
    private void connectWs(String url) {
        try {
            if (identityBlocked) {
                var c = connectCall; if (c != null) { connectCall = null; c.reject("refused: pinned agent identity mismatch (resetPairing to re-pair)"); }
                return;
            }
            // Persistent identity (IdentityStore) + fresh ephemeral per connection.
            hs = new KoCrypto.ClientHandshake(store().loadOrCreate());
            // ONE shared client (the old code leaked a dispatcher + pool per reconnect).
            // pingInterval: OkHttp-level WS pings detect a half-open TCP socket (cellular
            // handoff) and fail the socket -> onFailure -> auto-reconnect.
            if (client == null) client = new OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build();
            Request req = new Request.Builder().url(url).build();
            ws = client.newWebSocket(req, new WebSocketListener() {
                @Override public void onOpen(WebSocket w, Response response) { sendHello(); }
                @Override public void onMessage(WebSocket w, String text) {
                    if (!derived) handleHello(text);
                }
                @Override public void onMessage(WebSocket w, ByteString bytes) { onFrame(bytes.toByteArray()); }
                @Override public void onFailure(WebSocket w, Throwable t, Response r) {
                    connected = false;
                    derived = false;
                    dropSession("ws failure: " + t);
                    emitConn(false);
                    if (!identityBlocked) badge(pendingAgentId, ID_DISCONNECTED);
                    stopAudioActual();   // never leave the mic "on" with no uplink (encodeLoop exits on !connected)
                    closeMedia();
                    closeWebRtc();
                    var c = connectCall; if (c != null) { connectCall = null; c.reject("ws failure: " + t); }
                    scheduleReconnect();
                }
                @Override public void onClosed(WebSocket w, int code, String reason) {
                    if (connected || derived) {
                        connected = false;
                        derived = false;
                        dropSession("ws closed " + code + " " + reason);
                        emitConn(false);
                        if (!identityBlocked) badge(pendingAgentId, ID_DISCONNECTED);
                        stopAudioActual();
                        closeMedia();
                        closeWebRtc();
                        scheduleReconnect();
                    }
                }
            });
        } catch (Exception e) {
            var c = connectCall; if (c != null) { connectCall = null; c.reject("connect error: " + e); }
        }
    }

    /** Forget the session keys (nothing may be sealed with a dead session) and fail every
     *  command still waiting for a reply, so webview promises settle instead of hanging and
     *  the PluginCalls are released. */
    private void dropSession(String reason) {
        channel = null;
        hs = null;
        failPending(reason);
    }

    private void failPending(String reason) {
        for (Integer id : new java.util.ArrayList<>(pending.keySet())) {
            PluginCall c = pending.remove(id); pendingAt.remove(id);
            if (c != null) { try { c.reject(reason); } catch (Exception ignored) {} }
        }
    }

    /** Commands with no reply after PENDING_TIMEOUT_MS are failed (agent never answered). */
    private static final long PENDING_TIMEOUT_MS = 60000;
    private void sweepPending() {
        long now = SystemClock.elapsedRealtime();
        for (Map.Entry<Integer, Long> e : new java.util.ArrayList<>(pendingAt.entrySet())) {
            if (now - e.getValue() > PENDING_TIMEOUT_MS) {
                PluginCall c = pending.remove(e.getKey()); pendingAt.remove(e.getKey());
                if (c != null) { try { c.reject("no reply from agent within " + (PENDING_TIMEOUT_MS / 1000) + "s"); } catch (Exception ignored) {} }
            }
        }
    }

    /** Auto-reconnect (gateway restart resilience). Runs AFTER a real socket
     *  death (onFailure/onClosed), never during partition buffering — keepalive
     *  failures keep the socket open on purpose. Starts a fresh handshake after
     *  an exponential backoff capped at 60s. */
    private void scheduleReconnect() {
        if (connected || destroying || !connectConsented || lastUrl == null || identityBlocked) return;
        synchronized (reconnectLock) {
            if (reconnectPending) return;
            reconnectPending = true;
        }
        final long delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
        Thread t = new Thread(() -> {
            try { Thread.sleep(delay); } catch (InterruptedException e) {
                synchronized (reconnectLock) { reconnectPending = false; }
                return;
            }
            synchronized (reconnectLock) { reconnectPending = false; }
            if (connected || destroying || !connectConsented || lastUrl == null || identityBlocked) return;
            Log.i("AgentChannel", "auto-reconnect to " + lastUrl);
            worker.execute(() -> { try { connectWs(lastUrl); } catch (Exception ignored) {} });
        });
        t.setDaemon(true);
        t.start();
    }

    private void sendHello() {
        KoCrypto.ClientHandshake h = hs;
        if (ws != null && h != null) ws.send(h.helloJson());
    }

    /**
     * Server reply: { v:2, server_identity, server_eph, mac }. Verify the transcript MAC
     * (proves the server holds its identity private key) and compare server_identity to
     * the PIN for this host. Only then derive the session and send the confirm MAC.
     * First contact (no pin yet): native TOFU dialog showing the fingerprint.
     */
    private void handleHello(String text) {
        try {
            KoCrypto.ClientHandshake h = hs;
            if (h == null) return;
            JSONObject j = new JSONObject(text);
            if (j.has("error")) throw new IllegalStateException("gateway refused: " + j.optString("error"));
            if (j.optInt("v", 0) != KoCrypto.PROTO_VERSION)
                throw new IllegalStateException("gateway speaks protocol v" + j.opt("v") + ", this app needs v" + KoCrypto.PROTO_VERSION);
            byte[] sId = Base64.getDecoder().decode(j.getString("server_identity"));
            byte[] sEph = Base64.getDecoder().decode(j.getString("server_eph"));
            byte[] mac = Base64.getDecoder().decode(j.getString("mac"));
            final String host = hostOf(lastUrl);
            byte[] pin = host == null ? null : store().getPin(host);
            KoCrypto.ClientHandshake.Result r;
            try {
                r = h.finish(sId, sEph, mac, pin);
            } catch (GeneralSecurityException e) {
                if ("identity_mismatch".equals(e.getMessage())) { onIdentityMismatch(host, KoCrypto.identityIdDer(sId)); return; }
                throw e; // mac_mismatch / bad_reply
            }
            if (pin != null) { completeHandshake(r, text, ID_VERIFIED); return; }
            requestPairing(r, text, host);
        } catch (Exception e) {
            Log.w("AgentChannel", "handshake error: " + e);
            rejectHandshake("handshake error: " + e, ID_ERROR);
        }
    }

    /** Refuse the session (bad MAC, declined pairing, ...). No auto-reconnect loop: the
     *  socket is closed before `connected`/`derived` were ever set. */
    private void rejectHandshake(String reason, String state) {
        badge("", state);
        var c = connectCall; if (c != null) { connectCall = null; c.reject(reason); }
        try { WebSocket w = ws; if (w != null) w.close(4002, "handshake rejected"); } catch (Exception ignored) {}
    }

    /** The server presented a key that is NOT the one pinned for this host. Refuse, block
     *  auto-reconnect, and show it on the native badge. Nothing was sent. */
    private void onIdentityMismatch(String host, String presentedId) {
        identityBlocked = true;
        Log.e("AgentChannel", "IDENTITY MISMATCH for " + host + ": presented " + presentedId + " != pinned key. Refusing.");
        JSObject ev = new JSObject(); ev.put("error", "identity_mismatch"); ev.put("agentId", presentedId);
        notifyListeners("session", ev);
        rejectHandshake("refused: agent identity mismatch for " + host + " (presented " + presentedId + ")", ID_MISMATCH);
        badge(presentedId, ID_MISMATCH);
    }

    /** First contact with this host: trust-on-first-use behind a native confirmation. */
    private void requestPairing(KoCrypto.ClientHandshake.Result r, String helloText, String host) {
        Activity a = getActivity();
        if (a == null || host == null) { rejectHandshake("no activity/host for pairing", ID_ERROR); return; }
        a.runOnUiThread(() -> new AlertDialog.Builder(a)
            .setTitle("Pair with agent " + r.agentId + "?")
            .setMessage("First connection to " + host + ".\n\nAgent fingerprint:  " + r.agentId
                + "\n\nCompare it with the agent id your gateway prints. If it differs, tap Cancel — something else is answering on this address."
                + "\n\nThis phone's id: " + store().clientId() + " (add it to the gateway allowlist).")
            .setNegativeButton("Cancel", (d, w) -> { d.dismiss(); rejectHandshake("pairing declined by user", ID_ERROR); })
            .setPositiveButton("Pair", (d, w) -> {
                d.dismiss();
                store().setPin(host, r.serverIdPub);
                worker.execute(() -> completeHandshake(r, helloText, ID_PAIRED));
            })
            .setCancelable(false)
            .show());
    }

    /** MAC verified + identity accepted: send confirm, install the channel, go live. */
    private void completeHandshake(KoCrypto.ClientHandshake.Result r, String helloText, String state) {
        try {
            WebSocket w = ws;
            if (w == null) return;
            w.send(r.confirmJson);                 // proves WE hold the client identity key
            channel = r.channel;
            lastHelloText = helloText;
            tryStartUdpMedia(r.channel, helloText);
            pendingAgentId = r.agentId;
            derived = true; connected = true;
            reconnectDelayMs = 2000; // fresh handshake -> reset reconnect backoff
            emitConn(true);
            startWebRtc();
            JSObject out = new JSObject(); out.put("agentId", r.agentId); out.put("state", state); out.put("pinned", true);
            notifyListeners("session", out);
            badge(r.agentId, state);               // native unforgeable badge (webview cannot alter)
            var c = connectCall; if (c != null) { connectCall = null; c.resolve(out); }
            startKeepalive();
        } catch (Exception e) {
            Log.w("AgentChannel", "handshake completion: " + e);
            rejectHandshake("handshake error: " + e, ID_ERROR);
        }
    }

    /** Start the UDP media path from the server hello (media_port) + WS URL host. */
    private void tryStartUdpMedia(KoCrypto.Channel ch, String hello) {
        try {
            JSONObject j = new JSONObject(hello);
            int mp = j.optInt("media_port", 0);
            String host = new URI(lastUrl).getHost();
            if (host == null || mp <= 0) return;
            UdpMedia m = new UdpMedia(ch, (kind, seq, tsMs, opus, concealed) -> {
                if (kind == 1) playReply(opus, concealed); // reply downlink
            });
            m.start();
            m.setPeer(InetAddress.getByName(host), mp);
            // Stay on the proven WS uplink until the probe/ack confirms the sidecar
            // is actually receiving our UDP (see docs/udp-media-transport.md). The
            // ack callback flips the uplink to UDP — voice never breaks in between.
            m.onProbed(() -> {
                if (!udpUp) {
                    udpUp = true;
                    Log.i("AgentChannel", "udp media UP (probe/ack confirmed) peer " + host + ":" + mp);
                }
            });
            // Acks stopped (NAT rebind / network switch / sidecar restart): the mic uplink
            // must NOT keep black-holing into UDP — encodeLoop checks udpUp per frame and
            // goes back to the WS uplink; probing continues and onProbed flips it back.
            m.onDown(() -> {
                if (udpUp) {
                    udpUp = false;
                    Log.w("AgentChannel", "udp media DOWN (no ack " + "for a while) -> WS uplink fallback");
                }
            });
            media = m;
            udpUp = false;
            Log.i("AgentChannel", "udp media socket ready (probe/ack pending, WS audio) peer " + host + ":" + mp);
        } catch (Exception e) {
            Log.w("AgentChannel", "udp media init (WS fallback): " + e);
            udpUp = false;
        }
    }

    private void closeMedia() {
        UdpMedia m = media;
        media = null;
        udpUp = false;
        if (m != null) { try { m.close(); } catch (Exception ignored) {} }
    }

    private volatile String lastHelloText;

    /** Parse `ice: [...]` (string urls) from the server hello; empty list when absent. */
    private static java.util.List<String> iceUrlsFromHello(String hello) {
        java.util.List<String> out = new java.util.ArrayList<String>();
        if (hello == null) return out;
        try {
            org.json.JSONArray arr = new JSONObject(hello).optJSONArray("ice");
            if (arr == null) return out;
            for (int i = 0; i < arr.length(); i++) {
                String u = arr.optString(i, null);
                if (u != null && (u.startsWith("stun:") || u.startsWith("turn:") || u.startsWith("turns:"))) out.add(u);
            }
        } catch (Exception ignored) {}
        return out;
    }

    /** Start the WebRTC media peer (owner of mic + speaker once connected). */
    private void startWebRtc() {
        try {
            final Context c = getContext().getApplicationContext();
            // ICE servers: ONLY what the gateway advertised in its hello (`ice: ["stun:100.x.y.z:3478"]`),
            // i.e. something on the tailnet it controls. Default NONE: host candidates over
            // Tailscale/LAN suffice, and the phone must not talk to third parties (Google STUN
            // leaked the phone's public IP + session timing to Google on every connect).
            webRtc = new WebRtcMedia(c, this::sendSignal, iceUrlsFromHello(lastHelloText));
            // libwebrtc's PeerConnectionFactory must be initialized/created on the
            // MAIN thread — its native network/signaling threads attach to that
            // JavaVM. Running it on a worker thread dies with "Fatal error in jvm.cc".
            Activity a = getActivity();
            if (a != null) a.runOnUiThread(() -> {
                // Set the VoIP route BEFORE libwebrtc opens its output track —
                // Android commits the speakerphone/communication route when the
                // AudioTrack engages; setting it after (as before) could leave the
                // agent's speech on the quiet earpiece. Mirror the mic path.
                try {
                    AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    am.setSpeakerphoneOn(true);
                    am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                    // (no forced max volume — the user's level is theirs; see L2)
                } catch (Exception e) { Log.w("AgentChannel", "webrtc route: " + e); }
                try { webRtc.start(); } catch (Exception e) { Log.w("AgentChannel", "webrtc start: " + e); }
            });
            else webRtc.start();
        } catch (Exception e) {
            Log.w("AgentChannel", "webrtc start: " + e);
        }
    }

    /** Ship a WebRTC signaling object (SDP/ICE) over the authenticated channel. */
    private void sendSignal(JSONObject d) {
        try {
            int mid = msgId.incrementAndGet();
            JSONObject msg = new JSONObject();
            msg.put("i", mid);
            msg.put("d", d);
            byte[] plain = msg.toString().getBytes(StandardCharsets.UTF_8);
            KoCrypto.Channel ch = channel; if (ch == null) return;
            byte[] frame = ch.seal(KoCrypto.TYPE_CMD, plain);
            outbound(frame);
        } catch (Exception e) {
            Log.w("AgentChannel", "webrtc signal: " + e);
        }
    }

    private void closeWebRtc() {
        WebRtcMedia w = webRtc; webRtc = null;
        if (w != null) {
            try { w.close(); } catch (Exception ignored) {}
            // Give the audio route back: communication mode + speakerphone + focus were taken
            // for the call; leaving them set after disconnect changed every other app's audio.
            try {
                AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
                am.abandonAudioFocus(null);
            } catch (Exception ignored) {}
        }
    }

    /** Reply downlink from UDP media: decode + play in order (Concentus). A
     * concealed (lost) frame uses PLC: repeat the last decoded frame so there is
     * no silence hole / click. */
    private void playReply(byte[] opus, boolean concealed) {
        replyActiveUntil = SystemClock.elapsedRealtime() + 900; // echo gate
        try {
            if (concealed) {
                short[] c = (lastReplyPcm != null) ? lastReplyPcm.clone() : new short[AUDIO_FRAME];
                (audioRunning ? playQueue : replyQueue).offer(c);
                return;
            }
            short[] pcm = new short[AUDIO_FRAME];
            if (audioRunning && decoder != null && track != null) {
                int n = decoder.decode(opus, 0, opus.length, pcm, 0, AUDIO_FRAME, false);
                if (n > 0) { lastReplyPcm = Arrays.copyOf(pcm, n); playQueue.offer(Arrays.copyOf(pcm, n)); }
            } else {
                ensureReplyPlayback();
                if (playDecoder == null || playTrack == null) return;
                int n = playDecoder.decode(opus, 0, opus.length, pcm, 0, AUDIO_FRAME, false);
                if (n > 0) { lastReplyPcm = Arrays.copyOf(pcm, n); replyQueue.offer(Arrays.copyOf(pcm, n)); }
            }
        } catch (Exception e) {
            Log.e("AgentChannel", "media play: " + e);
        }
    }

    // ---- inbound --------------------------------------------------------------
    private synchronized void onFrame(byte[] frame) {
        KoCrypto.Channel ch = channel;
        if (ch == null || frame == null || frame.length < KoCrypto.HEADER_LEN) return; // pre-auth or junk: drop
        int type = frame[0] & 0xff;
        byte[] plain;
        try {
            plain = ch.open(frame);            // AEAD (type as AAD) + anti-replay; throws -> drop
        } catch (Exception e) {
            if (++rxErr % 50 == 1) Log.w("AgentChannel", "rx frame drop (unauthenticated/replayed): " + e);
            return;                            // NOT liveness: junk must not clear a partition or flush
        }
        // Only an AUTHENTICATED frame (pong included) proves the peer is alive.
        lastRx = SystemClock.elapsedRealtime();
        boolean wasBuffering = failures > 0;
        failures = 0;
        if (wasBuffering) flush();
        if (++anyRx % 50 == 1) Log.i("AgentChannel", "any rx type=" + type + " len=" + frame.length);
        if (type == KoCrypto.TYPE_PONG) return;
        try {
            if (type == KoCrypto.TYPE_AUDIO) {
                if (++rxAudioFrames % 50 == 1) Log.i("AgentChannel", "rx audio frame len=" + plain.length);
                decodePlay(plain); return;
            }
            if (type == KoCrypto.TYPE_CMD) {
                String j = new String(plain, StandardCharsets.UTF_8);
                int i = jsonInt(j, "i");
                // WebRTC signaling (answer / candidate-ack) from the sidecar:
                // route to the media peer, never surface it to the webview.
                try {
                    JSONObject jj = new JSONObject(j);
                    JSONObject dd = jj.optJSONObject("d");
                    if (dd != null && dd.has("webrtc")) {
                        WebRtcMedia w = webRtc;
                        if (w != null) w.handleSignal(dd);
                        return;
                    }
                } catch (Exception ignored) {}
                PluginCall c = pending.remove(i);
                if (c != null) {
                    pendingAt.remove(i);
                    JSObject rep = new JSObject();
                    rep.put("reply", dField(j));
                    c.resolve(rep);
                    if (++rxCmd % 50 == 1) Log.i("AgentChannel", "cmd reply decrypted, resolved #" + i);
                } else {
                    // No pending command -> the agent PUSHED this asynchronously
                    // (text / declarative UI / data). Forward to the web layer.
                    JSObject push = new JSObject();
                    push.put("payload", dField(j));
                    notifyListeners("message", push);
                    if (++rxPush % 50 == 1) Log.i("AgentChannel", "agent push frame received");
                }
            } // gap: not yet exercised in this slice
        } catch (Exception e) {
            if (++rxErr % 50 == 1) Log.w("AgentChannel", "rx frame handling: " + e);
        }
    }

    private long rxCmd;
    private long rxErr;
    private long anyRx;
    private long rxPush;

    private synchronized void flush() {
        byte[] f; int n = 0;
        while ((f = buffer.poll()) != null && ws != null) { bufferedBytes.addAndGet(-f.length); ws.send(ByteString.of(f)); n++; }
        if (buffer.isEmpty()) bufferedBytes.set(0);
        if (n > 0) { JSObject p = new JSObject(); p.put("partition", false); notifyListeners("partition", p); }
    }

    // ---- outbound -------------------------------------------------------------
    private synchronized void outbound(byte[] frame) {
        if (failures > 0) { buffer.add(frame); bufferedBytes.addAndGet(frame.length); trimBuffer(); }
        else if (ws != null) { ws.send(ByteString.of(frame)); }
    }

    /** Keep the partition buffer bounded: drop oldest audio first, then oldest anything. */
    private void trimBuffer() {
        if (bufferedBytes.get() <= MAX_BUFFER_BYTES && buffer.size() <= MAX_BUFFER_FRAMES) return;
        int dropped = 0;
        java.util.Iterator<byte[]> it = buffer.iterator();
        while (it.hasNext() && (bufferedBytes.get() > MAX_BUFFER_BYTES || buffer.size() > MAX_BUFFER_FRAMES)) {
            byte[] f = it.next();
            if ((f[0] & 0xff) == KoCrypto.TYPE_AUDIO) { it.remove(); bufferedBytes.addAndGet(-f.length); dropped++; }
        }
        while ((bufferedBytes.get() > MAX_BUFFER_BYTES || buffer.size() > MAX_BUFFER_FRAMES) && !buffer.isEmpty()) {
            byte[] f = buffer.poll(); if (f != null) { bufferedBytes.addAndGet(-f.length); dropped++; }
        }
        if (dropped > 0) Log.w("AgentChannel", "partition buffer capped: dropped " + dropped + " oldest frames");
    }

    // ---- audio (native Opus full-duplex, capability-gated) ---------------------
    /** Mic is live on EITHER path: libwebrtc track attached, or the raw Concentus loop. */
    private boolean micOn() {
        WebRtcMedia w = webRtc;
        return audioRunning || (w != null && w.isMicEnabled());
    }

    private void startAudioActual() {
        if (micOn()) return; // reentry guard (session event can double-fire)
        WebRtcMedia w = webRtc;
        if (w != null) {
            // WebRTC owns mic + speaker (AEC3). Attach a REAL capture track to the sender
            // (previously the transceiver had no track, so nothing was ever captured or sent).
            boolean ok = w.setMicEnabled(true);
            Log.i("AgentChannel", "audio owned by webrtc, mic enabled=" + ok);
            if (ok) {
                try { // mic-type foreground service keeps capture alive, same as the raw path
                    android.content.Context c = getContext().getApplicationContext();
                    c.startForegroundService(new android.content.Intent(c, AudioService.class));
                } catch (Exception e) { Log.w("AgentChannel", "fgs start: " + e); }
            }
            JSObject ev = new JSObject(); ev.put("audio", ok); if (!ok) ev.put("error", "webrtc mic unavailable");
            notifyListeners("audio", ev);
            return;
        }
        audioRunning = true;
        try {
            encoder = new OpusEncoder(AUDIO_RATE, 1, OpusApplication.OPUS_APPLICATION_VOIP);
            decoder = new OpusDecoder(AUDIO_RATE, 1);
            int minRec = AudioRecord.getMinBufferSize(AUDIO_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, AUDIO_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minRec, AUDIO_FRAME * 2 * 8));
            recorder.startRecording();
            int minOut = AudioTrack.getMinBufferSize(AUDIO_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            track = new AudioTrack(
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
                new AudioFormat.Builder().setSampleRate(AUDIO_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
                Math.max(minOut, AUDIO_FRAME * 2 * 8), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
            // communication mode + audio focus = the route that keeps capture+playback duplex alive
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            // in communication mode the default output is the EARPIECE; route to the loudspeaker
            // so downlink (loopback / agent replies) is audible, and lift the voice-call stream
            try { am.setSpeakerphoneOn(true); } catch (Exception e) { Log.w("AgentChannel", "speaker on: " + e); }
            // (no forced max volume — the user's level is theirs; see L2)
            // foreground service (microphone type) keeps the process foreground-active so the
            // RECORD_AUDIO app-op check passes for sustained full-duplex capture
            try {
                android.content.Context c = getContext().getApplicationContext();
                c.startForegroundService(new android.content.Intent(c, AudioService.class));
            } catch (Exception e) { Log.w("AgentChannel", "fgs start: " + e); }
            audioRunning = true;
            playQueue.clear();
            audioPlayingThread = new Thread(this::playLoop, "agent-play");
            audioPlayingThread.setDaemon(true);
            audioPlayingThread.start();
            audioThread = new Thread(this::encodeLoop, "agent-audio");
            audioThread.setDaemon(true);
            audioThread.start();
            Log.i("AgentChannel", "audio on; recorder state=" + recorder.getState()
                + " hwRate=" + recorder.getSampleRate() + " minBuf=" + minRec);
            JSObject ev = new JSObject(); ev.put("audio", true); notifyListeners("audio", ev);
        } catch (Exception e) {
            audioRunning = false;
            JSObject ev = new JSObject(); ev.put("audio", false); ev.put("error", String.valueOf(e));
            notifyListeners("audio", ev);
        }
    }

    private void stopAudioActual() {
        WebRtcMedia w = webRtc;
        if (w != null) { try { w.setMicEnabled(false); } catch (Exception ignored) {} }
        audioRunning = false;
        Thread t = audioThread; audioThread = null;
        if (t != null && t != Thread.currentThread()) { try { t.interrupt(); } catch (Exception ignored) {} }
        Thread p = audioPlayingThread; audioPlayingThread = null;
        if (p != null && p != Thread.currentThread()) { try { p.interrupt(); } catch (Exception ignored) {} }
        try { if (recorder != null) { recorder.stop(); recorder.release(); } } catch (Exception ignored) {}
        try { if (track != null) { track.stop(); track.release(); } } catch (Exception ignored) {}
        playQueue.clear();
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.abandonAudioFocus(null);
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {}
        try {
            android.content.Context c = getContext().getApplicationContext();
            c.stopService(new android.content.Intent(c, AudioService.class));
        } catch (Exception ignored) {}
        recorder = null; track = null; encoder = null; decoder = null;
        JSObject ev = new JSObject(); ev.put("audio", false); notifyListeners("audio", ev);
    }

    private void encodeLoop() {
        short[] pcm = new short[AUDIO_FRAME];
        byte[] out = new byte[960];
        long frames = 0;
        while (audioRunning && connected) {
            try {
                // echo gate: while a reply is playing OR still buffered, don't feed
                // the agent the mic picking up its own speaker output. The old gate
                // only used replyActiveUntil (decode-time + margin); because frames
                // are decoded ahead and drained by the AudioTrack over real-time, the
                // speaker keeps playing long after the last decode. Keying on the
                // queued reply audio too closes that gap so the mic stays muted for
                // the WHOLE reply, on either playback path.
                if (SystemClock.elapsedRealtime() < replyActiveUntil || !playQueue.isEmpty() || !replyQueue.isEmpty()) {
                    Thread.sleep(12);
                    continue;
                }
                int n = recorder.read(pcm, 0, AUDIO_FRAME);
                if (n <= 0) { if (++frames % 50 == 1) Log.i("AgentChannel", "audio read=" + n + " (waiting)");
                    Thread.sleep(2); continue; }
                if (n < AUDIO_FRAME) { for (int i = n; i < AUDIO_FRAME; i++) pcm[i] = 0; n = AUDIO_FRAME; }
                if (++lvlFrames % 4 == 1) emitMicLevel(rmsLevel(pcm));
                int nb = encoder.encode(pcm, 0, n, out, 0, out.length);
                if (nb <= 0) { Log.w("AgentChannel", "opus encode returned " + nb); continue; }
                byte[] pl = new byte[4 + 8 + nb];
                long seq = audioSeq.getAndIncrement();
                writeU32(pl, 0, seq);
                writeU64(pl, 4, SystemClock.elapsedRealtime());
                System.arraycopy(out, 0, pl, 12, nb);
                if (udpUp && media != null) {
                    // UDP media path: seal a [kind][seq][tsMs][opus] frame over UDP.
                    media.sendFrame(0, mediaSeq.getAndIncrement(), SystemClock.elapsedRealtime(), Arrays.copyOf(out, nb));
                } else {
                    KoCrypto.Channel ch = channel; if (ch == null) continue;
                    byte[] frame = ch.seal(KoCrypto.TYPE_AUDIO, pl);
                    outbound(frame); // partition-aware (buffers in-order, unbounded)
                }
                if (++frames % 50 == 1) Log.i("AgentChannel", "audio tx #" + seq + " opus=" + nb + "B via " + (udpUp ? "UDP" : "WS"));
            } catch (InterruptedException e) { return; }
            catch (Exception e) {
                Log.e("AgentChannel", "audio loop", e);
                try { Thread.sleep(5); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private void decodePlay(byte[] pl) {
        try {
            replyActiveUntil = SystemClock.elapsedRealtime() + 900; // also gates mic (echo)
            // Pad the start of each NEW reply burst so playback starts pre-buffered.
            boolean replyOnly = !(track != null && decoder != null && audioRunning);
            if (replyOnly) ensureReplyPlayback();
            boolean pad = beginReplyBurst();
            if (track != null && decoder != null && audioRunning) {
                int n = decoder.decode(pl, 12, pl.length - 12, pcmOut, 0, AUDIO_FRAME, false);
                if (++decoded % 50 == 1) Log.i("AgentChannel", "audio rx decoded=" + n + " samples (" + pl.length + "B in)");
                if (n > 0) {
                    short[] copy = new short[n];
                    System.arraycopy(pcmOut, 0, copy, 0, n);
                    if (pad) enqueuePreRoll(playQueue);
                    playQueue.offer(copy);
                }
            } else {
                // mic/capture is off — use the always-available reply playback path
                if (playDecoder == null || playTrack == null) return;
                short[] pcm = new short[AUDIO_FRAME];
                int n = playDecoder.decode(pl, 12, pl.length - 12, pcm, 0, AUDIO_FRAME, false);
                if (++decoded % 50 == 1) Log.i("AgentChannel", "reply rx decoded=" + n + " samples (" + pl.length + "B in)");
                if (n > 0) {
                    short[] copy = new short[n];
                    System.arraycopy(pcm, 0, copy, 0, n);
                    if (pad) enqueuePreRoll(replyQueue);
                    replyQueue.offer(copy);
                }
            }
        } catch (Exception e) {
            Log.e("AgentChannel", "decode/play", e);
        }
    }

    /** true when a new reply burst begins (enough gap since the last enqueue). */
    private boolean beginReplyBurst() {
        long now = SystemClock.elapsedRealtime();
        boolean nb = lastReplyEnqMs == 0 || now - lastReplyEnqMs > 250;
        lastReplyEnqMs = now;
        return nb;
    }

    /** Insert REPLY_PREROLL frames of silence ahead of reply content. */
    private void enqueuePreRoll(LinkedBlockingQueue<short[]> q) {
        short[] z = new short[AUDIO_FRAME];
        for (int i = 0; i < REPLY_PREROLL; i++) q.offer(z);
    }

    /** Lazy playback-only path: plays agent replies even when the mic is stopped. */
    private synchronized void ensureReplyPlayback() {
        if (playDecoder != null && playTrack != null) return;
        try {
            if (playDecoder == null) playDecoder = new OpusDecoder(AUDIO_RATE, 1);
            if (playTrack == null) {
                int minOut = AudioTrack.getMinBufferSize(AUDIO_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                playTrack = new AudioTrack(
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
                    new AudioFormat.Builder().setSampleRate(AUDIO_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
                    Math.max(minOut, AUDIO_FRAME * 2 * 12), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                playTrack.setVolume(1.0f);
                playTrack.play();
                short[] zero = new short[AUDIO_FRAME];
                for (int i = 0; i < 10; i++) playTrack.write(zero, 0, AUDIO_FRAME);
            }
            if (replyThread == null || !replyThread.isAlive()) {
                replyThread = new Thread(() -> {
                    short[] zero = new short[AUDIO_FRAME];
                    try {
                        // Run while connected (or until the queued reply has drained); do NOT spin
                        // writing silence to the HAL forever after a disconnect (battery + route lock).
                        while (!destroying && (connected || !replyQueue.isEmpty())) {
                            short[] f = replyQueue.poll(40, TimeUnit.MILLISECONDS);
                            if (f == null) { try { playTrack.write(zero, 0, AUDIO_FRAME); } catch (Exception ignored) {} }
                            else { try { playTrack.write(f, 0, f.length); } catch (Exception ignored) {} }
                        }
                    } catch (InterruptedException ignored) {}
                    AudioTrack pt = playTrack; playTrack = null;   // ensureReplyPlayback() recreates on demand
                    try { if (pt != null) { pt.stop(); pt.release(); } } catch (Exception ignored) {}
                }, "agent-reply-play");
                replyThread.setDaemon(true);
                replyThread.start();
            }
        } catch (Exception e) {
            Log.e("AgentChannel", "ensure reply playback", e);
        }
    }

    /** Dedicated playback thread: pre-fill silence, then stream decoded frames. */
    private void playLoop() {
        short[] zero = new short[AUDIO_FRAME];
        try {
            // pre-fill ~10 frames (200ms) so streaming starts without an underrun/stall
            for (int i = 0; i < 10; i++) track.write(zero, 0, AUDIO_FRAME);
            track.play();
            while (audioRunning && track != null) {
                short[] f = playQueue.poll(50, TimeUnit.MILLISECONDS);
                if (f == null) { track.write(zero, 0, AUDIO_FRAME); continue; } // idle fill
                track.write(f, 0, f.length);
                // echo gate rides on playback progress: the mic stays muted as
                // long as reply audio is still being played (queue keeps this
                // thread fed at real-time, so this extends across the WHOLE
                // reply, including pauses between streamed bursts).
                replyActiveUntil = SystemClock.elapsedRealtime() + 240;
            }
        } catch (Exception e) {
            Log.e("AgentChannel", "play loop", e);
        }
    }

    // ---- keepalive with exponential backoff -------------------------------------
    private void emitConn(boolean up) {
        try { JSObject ev = new JSObject(); ev.put("connected", up); notifyListeners("conn", ev); } catch (Exception ignored) {}
    }
    private void emitHb(boolean ok) {
        try { JSObject ev = new JSObject(); ev.put("ok", ok); notifyListeners("hb", ev); } catch (Exception ignored) {}
    }
    private void emitMicLevel(int lvl) {
        try { JSObject ev = new JSObject(); ev.put("level", lvl); notifyListeners("miclevel", ev); } catch (Exception ignored) {}
    }
    // RMS of one 20ms PCM frame -> 0..100 for the mic-level bar.
    private int rmsLevel(short[] pcm) {
        long sum = 0;
        for (int i = 0; i < pcm.length; i++) sum += (long) pcm[i] * pcm[i];
        double rms = Math.sqrt((double) sum / pcm.length);
        return (int) Math.max(0, Math.min(100, Math.round(rms / 40.0)));
    }
    private void startKeepalive() {
        keepaliveRunning = true;
        Thread t = new Thread(() -> {
            long interval = baseMs;
            while (keepaliveRunning && connected) {
                try { Thread.sleep(interval); } catch (InterruptedException e) { return; }
                if (!keepaliveRunning || !connected) return;
                sweepPending();
                try {
                    KoCrypto.Channel ch = channel; if (ch == null) return;
                    byte[] ping = ch.seal(KoCrypto.TYPE_PING, new byte[0]);
                    long rx0 = lastRx;
                    if (ws != null) ws.send(ByteString.of(ping));
                    boolean acked = false;
                    long deadline = SystemClock.elapsedRealtime() + probeTimeoutMs;
                    while (SystemClock.elapsedRealtime() < deadline) {
                        if (lastRx > rx0) { acked = true; break; }
                        Thread.sleep(30);
                    }
                    if (acked) { interval = baseMs; }
                    else {
                        failures++;
                        long silentMs = SystemClock.elapsedRealtime() - lastRx;
                        if (failures >= partitionThreshold && silentMs > Math.max(2 * maxMs, 30000)) {
                            // Half-open socket: keepalive has failed for longer than the backoff
                            // cap with NO authenticated byte received. Buffering forever only grows
                            // memory; tear the socket down so auto-reconnect builds a fresh one
                            // (the partition buffer flushes on the new session's first liveness).
                            Log.w("AgentChannel", "link silent " + silentMs + "ms after " + failures + " failed probes -> cancel socket, reconnect");
                            WebSocket w = ws; if (w != null) { try { w.cancel(); } catch (Exception ignored) {} }
                            return;
                        }
                        if (failures >= partitionThreshold) {
                            JSObject p = new JSObject(); p.put("partition", true); notifyListeners("partition", p);
                        }
                        interval = Math.min(baseMs * (1L << Math.min(failures, 6)), maxMs);
                    }
                    emitHb(acked);
                } catch (InterruptedException e) { return; } catch (Exception ignored) {}
            }
        });
        t.setDaemon(true);
        t.start();
    }

    // ---- tiny JSON/binary helpers ------------------------------------------------
    private static String jsonGet(String s, String key) {
        String nd = "\"" + key + "\":\"";
        int i = s.indexOf(nd); if (i < 0) throw new IllegalStateException(key);
        int a = i + nd.length(), b = s.indexOf('"', a);
        return s.substring(a, b);
    }
    private static int jsonInt(String s, String key) {
        String nd = "\"" + key + "\":";
        int i = s.indexOf(nd); if (i < 0) throw new IllegalStateException(key);
        int a = i + nd.length(), b = a;
        // signed: push frames use i:-1, so allow a leading '-'
        if (b < s.length() && s.charAt(b) == '-') b++;
        while (b < s.length() && Character.isDigit(s.charAt(b))) b++;
        return Integer.parseInt(s.substring(a, b));
    }
    /** The `d` field as text for the webview: objects/arrays as JSON, strings as-is
     *  (the old hand parser returned "" for any scalar `d`, dropping the message). */
    private static String dField(String j) {
        try {
            Object d = new JSONObject(j).opt("d");
            if (d == null || d == JSONObject.NULL) return "";
            return d instanceof String ? (String) d : d.toString();
        } catch (Exception e) { return jsonRaw(j, "d"); }
    }
    private static String jsonRaw(String s, String key) {
        String nd = "\"" + key + "\":";
        int i = s.indexOf(nd); if (i < 0) throw new IllegalStateException(key);
        int a = i + nd.length();
        int depth = 0, q = a; boolean instr = false;
        for (int k = a; k < s.length(); k++) {
            char ch = s.charAt(k);
            if (instr) { if (ch == '\\') k++; else if (ch == '"') instr = false; continue; }
            if (ch == '"') instr = true;
            else if (ch == '{' || ch == '[') depth++;
            else if (ch == '}' || ch == ']') { depth--; if (depth == 0) { q = k + 1; break; } }
        }
        return s.substring(a, q);
    }
    private static void writeU32(byte[] b, int o, long v) {
        b[o] = (byte) (v >>> 24); b[o + 1] = (byte) (v >>> 16); b[o + 2] = (byte) (v >>> 8); b[o + 3] = (byte) v;
    }
    private static void writeU64(byte[] b, int o, long v) {
        for (int i = 7; i >= 0; i--) { b[o + i] = (byte) (v & 0xff); v >>>= 8; }
    }
}
