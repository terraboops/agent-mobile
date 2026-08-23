package com.agentmobile.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.util.Base64;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

/**
 * Proves the Java AEAD channel (KoCrypto, protocol v2) interoperates byte-for-byte with the
 * Node gateway (proto.js + transport/ws-gateway.js): hello -> reply(mac) -> confirm, server
 * MAC verification, sealed command round-trip, and rejection of tampered / replayed /
 * type-flipped frames. Runs on the host JVM against a spawned Node.
 */
public class NodeInteropTest {

    static Process node;
    static String url;
    static KeyPair clientId;
    static KoCrypto.Channel channel;
    static String lastReply;
    static BlockingQueue<Object> q = new LinkedBlockingQueue<>();

    @BeforeClass
    public static void startGateway() throws Exception {
        Path repo = findRepo();
        ProcessBuilder pb = new ProcessBuilder("node", repo.resolve("transport/run-gateway.mjs").toString());
        pb.environment().put("PORT", "0");
        node = pb.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> node.destroy()));

        BufferedReader br = new BufferedReader(new InputStreamReader(node.getInputStream()));
        String line = null;
        for (int i = 0; i < 50; i++) {
            if (line != null && line.startsWith("LISTENING ")) break;
            if (!node.isAlive()) throw new IllegalStateException("node died: " +
                new String(node.getErrorStream().readAllBytes()));
            if (br.ready() && (line = br.readLine()) != null) continue;
            Thread.sleep(100);
        }
        if (line == null || !line.startsWith("LISTENING ")) throw new IllegalStateException("gateway did not report LISTENING");
        int port = Integer.parseInt(line.substring("LISTENING ".length()).trim());
        url = "ws://127.0.0.1:" + port;
    }

    @AfterClass
    public static void stop() { if (node != null) node.destroy(); }

    private static Path findRepo() throws Exception {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null) {
            if (Files.exists(dir.resolve("transport/ws-gateway.js"))) return dir;
            dir = dir.getParent();
        }
        throw new IllegalStateException("repo root not found from " + System.getProperty("user.dir"));
    }

    private static WebSocketClient openWs(String url) throws Exception {
        CountDownLatch open = new CountDownLatch(1);
        WebSocketClient ws = new WebSocketClient(URI.create(url)) {
            public void onOpen(ServerHandshake h) { open.countDown(); }
            public void onMessage(String s) { q.add("T:" + s); }
            public void onMessage(ByteBuffer b) { byte[] x = new byte[b.remaining()]; b.get(x); q.add(x); }
            public void onClose(int code, String reason, boolean remote) {}
            public void onError(Exception e) { q.add("ERR:" + e); }
        };
        ws.connect();
        assertTrue("ws connect (open within 5s)", open.await(5, TimeUnit.SECONDS));
        return ws;
    }

    private static KoCrypto.ClientHandshake.Result handshake(WebSocketClient ws, byte[] pin) throws Exception {
        clientId = clientId != null ? clientId : KoCrypto.genXdh();
        KoCrypto.ClientHandshake hs = new KoCrypto.ClientHandshake(clientId);
        ws.send(hs.helloJson());
        Object first = q.take();
        assertTrue("expected text hello reply, got " + first, first instanceof String && first.toString().startsWith("T:"));
        lastReply = first.toString().substring(2);
        KoCrypto.ClientHandshake.Result r = hs.finish(
            Base64.getDecoder().decode(jsonGet(lastReply, "server_identity")),
            Base64.getDecoder().decode(jsonGet(lastReply, "server_eph")),
            Base64.getDecoder().decode(jsonGet(lastReply, "mac")), pin);
        ws.send(r.confirmJson);
        return r;
    }

    @Test
    public void javaChannelInteropsWithNodeGateway() throws Exception {
        WebSocketClient ws = openWs(url);
        KoCrypto.ClientHandshake.Result r = handshake(ws, null);   // TOFU (no pin yet)
        channel = r.channel;
        assertEquals(8, r.agentId.length());

        // sealed command round-trip: Java -> Node -> Java
        byte[] pt = "{\"i\":1,\"d\":\"hello-java\"}".getBytes(StandardCharsets.UTF_8);
        byte[] frame = channel.seal(KoCrypto.TYPE_CMD, pt);
        ws.send(ByteBuffer.wrap(frame));
        Object rep = q.poll(5, TimeUnit.SECONDS);
        assertTrue("expected binary reply, got " + rep, rep instanceof byte[]);
        String decrypted = new String(channel.open((byte[]) rep), StandardCharsets.UTF_8);
        assertTrue("echo should come back from Node gateway: " + decrypted, decrypted.contains("hello-java"));

        // replayed frame: the gateway must NOT answer again
        ws.send(ByteBuffer.wrap(frame));
        assertNull("replayed frame must be ignored", q.poll(700, TimeUnit.MILLISECONDS));

        // flipped type byte (AAD): must be ignored
        byte[] f2 = channel.seal(KoCrypto.TYPE_CMD, "{\"i\":2,\"d\":\"flip\"}".getBytes(StandardCharsets.UTF_8));
        f2[0] = KoCrypto.TYPE_AUDIO;
        ws.send(ByteBuffer.wrap(f2));
        assertNull("type-flipped frame must be ignored", q.poll(700, TimeUnit.MILLISECONDS));

        // the channel is still live afterwards
        ws.send(ByteBuffer.wrap(channel.seal(KoCrypto.TYPE_CMD, "{\"i\":3,\"d\":\"again\"}".getBytes(StandardCharsets.UTF_8))));
        Object rep3 = q.poll(5, TimeUnit.SECONDS);
        assertTrue(new String(channel.open((byte[]) rep3), StandardCharsets.UTF_8).contains("again"));
        ws.close();
    }

    @Test
    public void pinnedIdentityMismatchIsRefused() throws Exception {
        WebSocketClient ws = openWs(url);
        byte[] wrongPin = KoCrypto.exportPublic(KoCrypto.genXdh());
        Exception e = assertThrows(Exception.class, () -> handshake(ws, wrongPin));
        assertEquals("identity_mismatch", e.getMessage());
        ws.close();
    }

    @Test
    public void tamperAndLocalReplayAreRejected() throws Exception {
        if (channel == null) javaChannelInteropsWithNodeGateway(); // ensure session exists
        KoCrypto.Channel a = new KoCrypto.Channel(new byte[32], new byte[32], new byte[32]);
        KoCrypto.Channel b = new KoCrypto.Channel(new byte[32], new byte[32], new byte[32]); // mirror keys
        byte[] good = a.seal(KoCrypto.TYPE_CMD, "tamper".getBytes(StandardCharsets.UTF_8));
        assertEquals("tamper", new String(b.open(good), StandardCharsets.UTF_8));
        assertThrows("replay", Exception.class, () -> b.open(good));
        byte[] junk = a.seal(KoCrypto.TYPE_CMD, "tamper".getBytes(StandardCharsets.UTF_8));
        junk[20] ^= 0x01; // flip a tag byte
        assertThrows(Exception.class, () -> b.open(junk));
        byte[] flip = a.seal(KoCrypto.TYPE_CMD, "tamper".getBytes(StandardCharsets.UTF_8));
        flip[0] = KoCrypto.TYPE_PING;
        assertThrows(Exception.class, () -> b.open(flip));
    }

    private static String jsonGet(String json, String key) {
        String needle = "\"" + key + "\":\"";
        int i = json.indexOf(needle);
        if (i < 0) throw new IllegalStateException("no key " + key + " in " + json);
        int s = i + needle.length();
        int e = json.indexOf('"', s);
        return json.substring(s, e);
    }
}
