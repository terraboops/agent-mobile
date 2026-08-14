package com.agentmobile.agent;

import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;

/**
 * EgressWebViewClient — the native (non-VPN) webview egress blocker.
 *
 * <p>The webview is the only untrusted surface and has no legitimate network use:
 * everything is rendered from data the native plugin pushes, and the only socket to
 * the wire is the native gateway WebSocket (an app-level socket, unaffected here).
 * So we deny EVERY webview-initiated network request except our own local origin.
 *
 * <p>Any request whose host is not "localhost" (the Capacitor local server) returns an
 * empty response — it never leaves the device. This is load-bearing: CSP and a patched
 * fetch() are layer-1 tripwires; this is the guarantee at the native WebView boundary.
 *
 * <p>Deliberately a WebViewClient, not a VPN: it cannot conflict with Tailscale.
 */
public class EgressWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "EgressWebView";

    public EgressWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String url = request.getUrl() == null ? "" : request.getUrl().toString();
        String host = request.getUrl() == null ? null : request.getUrl().getHost();
        boolean local = host != null && (host.equals("localhost") || host.endsWith(".localhost"));
        if (!local) {
            Log.w(TAG, "DENIED webview egress -> " + url);
            // empty 200 body: the request never reaches the network
            return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }
}
