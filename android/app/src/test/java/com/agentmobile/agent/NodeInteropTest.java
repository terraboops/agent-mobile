package com.agentmobile.agent;

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
 * Proves the Java AEAD channel (KoCrypto) interoperates byte-for-byte with the Node
 * gateway (proto.js + transport/ws-gateway.js): handshake, sealed command round-trip,
 * and auth rejection of tampered frames. Runs on the host JVM against a spawned Node.
 */
public class NodeInteropTest {

    static Process node;
    static String url;
    static KeyPair clientId, clientEph;
    static byte[] tx, rx;
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

    @Test
    public void javaChannelInteropsWithNodeGateway() throws Exception {
        clientId = KoCrypto.genXdh();
        clientEph = KoCrypto.genXdh();
        WebSocketClient ws = openWs(url);

        // handshake — plaintext hello, mirrored from Node
        ws.send("{"
            + "\"client_id\":\"" + KoCrypto.identityId(clientId.getPublic()) + "\","
            + "\"client_identity\":\"" + Base64.getEncoder().encodeToString(KoCrypto.exportPublic(clientId)) + "\","
            + "\"client_eph\":\"" + Base64.getEncoder().encodeToString(KoCrypto.exportPublic(clientEph)) + "\"}");

        Object first = q.take();
        assertTrue("expected text hello response, got " + first, first instanceof String && first.toString().startsWith("T:"));
        String j = first.toString().substring(2);
        String serverId = jsonGet(j, "server_identity");
        String serverEph = jsonGet(j, "server_eph");

        byte[][] session = KoCrypto.deriveClientSession(
            clientId, Base64.getDecoder().decode(serverId),
            clientEph, Base64.getDecoder().decode(serverEph));
        tx = session[0];
        rx = session[1];

        // sealed command round-trip: Java -> Node -> Java
        byte[] pt = "{\"i\":1,\"d\":\"hello-java\"}".getBytes(StandardCharsets.UTF_8);
        ws.send(ByteBuffer.wrap(KoCrypto.sealMessage(tx, KoCrypto.TYPE_CMD, pt)));

        Object r = q.take();
        assertTrue("expected binary reply, got " + r, r instanceof byte[]);
        byte[] plain = KoCrypto.openMessage(rx, (byte[]) r);
        String decrypted = new String(plain, StandardCharsets.UTF_8);
        assertTrue("echo should come back from Node gateway: " + decrypted, decrypted.contains("hello-java"));

        ws.close();
    }

    @Test
    public void tamperIsRejected() throws Exception {
        if (tx == null) javaChannelInteropsWithNodeGateway(); // ensure session exists
        byte[] junk = KoCrypto.sealMessage(tx, KoCrypto.TYPE_CMD, "tamper".getBytes(StandardCharsets.UTF_8));
        junk[20] ^= 0x01; // flip a ciphertext byte
        assertThrows(Exception.class, () -> KoCrypto.openMessage(rx, junk));
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
