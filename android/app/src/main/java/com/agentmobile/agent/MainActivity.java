package com.agentmobile.agent;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — hosts the Capacitor webview and the NATIVE, unforgeable identity badge.
 *
 * <p>The webview renders channel-pushed data only; arbitrary agent JS runs with zero attack
 * surface. Everything it draws (including the old "CONNECTED TO AGENT" header) is mutable by
 * that agent JS, so the trust signal is NOT drawn there. Instead this class draws a small
 * native overlay on top of the webview that injected JS cannot touch: it starts amber, and on
 * a successful AEAD handshake the Android plugin pushes the verified agent fingerprint onto it
 * (green). A webview compromise cannot fake this badge.
 *
 * <p>Also installs the webview egress blocker (denies all webview HTTP(S) except the app's
 * local origin). The gateway WebSocket is an app-level OkHttp socket, so it coexists with
 * Tailscale with no competing VPN.
 */
public class MainActivity extends BridgeActivity {

    private TextView identityBadge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgentChannelPlugin.class);
        super.onCreate(savedInstanceState);
        // native webview egress deny (Tailscale-safe; no VPN competed): allow only local origin
        try {
            bridge.setWebViewClient(new EgressWebViewClient(bridge));
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "egress webview client: " + e);
        }
        installIdentityBadge();
        try {
            AgentChannelPlugin p = (AgentChannelPlugin) bridge.getPlugin("AgentChannel").getInstance();
            if (p != null) p.setIdentitySink(onAgentIdentity());
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "identity sink: " + e);
        }
    }

    /** Consumer fired (on the UI thread) when the AEAD handshake pins a verified agent. */
    private java.util.function.Consumer<String> onAgentIdentity() {
        return id -> {
            if (identityBadge != null) {
                // "✓" only after the agent's X25519 SPKI was verified by the handshake.
                identityBadge.setText("✓ AGENT " + id + " · E2E");
                identityBadge.setBackground(makeBadge(0xFF7EE787, 0xFF1A2718)); // verified green
            }
        };
    }

    /** Build the small top-center overlay that floats above the webview. */
    private void installIdentityBadge() {
        TextView tv = new TextView(this);
        tv.setText("⌁ session starting");
        tv.setTextColor(Color.rgb(0xE6, 0xED, 0xF3));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setPadding(dp(14), dp(6), dp(14), dp(6));
        tv.setBackground(makeBadge(0xFFE3B341, 0xFF221D10)); // amber = not yet verified
        tv.setElevation(dp(6));
        tv.setAlpha(0.92f);
        identityBadge = tv;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = dp(56); // below the Pixel punch-hole camera (top-center cutout)
        try {
            ((android.widget.FrameLayout) findViewById(android.R.id.content)).addView(tv, lp);
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "badge add: " + e);
        }
    }

    /** Rounded pill background: colored border on a translucent dark fill. */
    private static GradientDrawable makeBadge(int strokeArgb, int fillArgb) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fillArgb);
        d.setStroke(2, strokeArgb);
        d.setCornerRadius(8);
        return d;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
            getResources().getDisplayMetrics()));
    }
}
