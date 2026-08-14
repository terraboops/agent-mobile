// renderer.js — draws the agent's messages. No agent-injected code affects
// rendering beyond these typed nodes; everything arrives via __pushAgentMessage.
// The UI is fully component-driven: whatever the sender puts in a render block is
// drawn verbatim. Mic + stop are ordinary styled components that ride the same wire
// (the adapter attaches them), so they look and feel like "components over the wire".
(function () {
  'use strict';
  const ui = document.getElementById('ui');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function controlsHTML(u) {
    let items = u && u.controls;
    if (!items) return '';
    if (!Array.isArray(items)) items = items.items;
    if (!Array.isArray(items)) return '';
    return '<div class="controls">' + items.map(function (c) {
      const label = esc(c.label || (c.t === 'mic' ? '🎤 Start audio' : '✕ Stop'));
      const accent = c.accent || (c.t === 'mic' ? '#8957e5' : '#da3633');
      return '<button data-ctl="' + esc(c.t) + '" data-off="' + esc(label) + '"'
        + (c.t === 'mic' ? ' data-on="⏹ Mic on"' : '')
        + ' style="background:' + esc(accent) + '">' + label + '</button>';
    }).join('') + '</div>';
  }

  function bindControls() {
    ui.querySelectorAll('[data-ctl]').forEach(function (b) {
      b.onclick = function () {
        if (b.getAttribute('data-ctl') === 'mic') window.toggleAudio();
        else if (b.getAttribute('data-ctl') === 'stop') window.__agent.stop();
      };
    });
  }

  function draw(u) {
    if (!u) return;
    let h = '';
    const charts = [];
    const vizzes = [];
    if (u.title) h += '<h1>' + esc(u.title) + '</h1>';
    if (u.text) h += '<p>' + esc(u.text) + '</p>';
    if (Array.isArray(u.list)) {
      h += '<ul>' + u.list.map(i => '<li>' + esc(i.title) + (i.subtitle ? '<em>' + esc(i.subtitle) + '</em>' : '') + '</li>').join('') + '</ul>';
    }
    if (Array.isArray(u.components)) {
      u.components.forEach(function (c) {
        if (c.t === 'text') h += '<p>' + esc(c.text) + '</p>';
        else if (c.t === 'list') h += '<ul>' + (c.items || []).map(i => '<li>' + esc(i.title) + (i.subtitle ? '<em>' + esc(i.subtitle) + '</em>' : '') + '</li>').join('') + '</ul>';
        else if (c.t === 'image') h += '<figure class="img"><img src="' + esc(c.src) + '" alt="' + esc(c.alt || '') + '">' + (c.alt ? '<figcaption>' + esc(c.alt) + '</figcaption>' : '') + '</figure>';
        else if (c.t === 'title') h += '<h1>' + esc(c.text) + '</h1>';
        // Chart: declarative ApexCharts `options` arrive over the channel (data,
        // not code). The renderer mounts locally-bundled ApexCharts on the element.
        else if (c.t === 'chart') { charts.push({ options: c.options || {}, title: c.title || '' }); h += '<div class="chart"></div>'; }
        // Arbitrary viz: the agent streams code (any library) + data over the channel.
        // It runs in a sandboxed, opaque-origin iframe — draw-only, no bridge access.
        else if (c.t === 'viz') { vizzes.push({ code: c.code || '', data: c.data || {}, label: c.label || '' }); h += '<div class="viz"><iframe class="vizframe" sandbox="allow-scripts"></iframe></div>'; }
        // SVG: rendered by the same sandboxed frame (the SVG markup is data, safe even
        // if it carries handlers). Static + animated SVG draw fine; no bridge access.
        else if (c.t === 'svg') {
          // Only accept real SVG markup; a placeholder/broken string (e.g. a bare
          // "<div />") injected via innerHTML renders as a broken empty square.
          const svg = String(c.svg || '').trim();
          if (!/^<svg[\s>]/i.test(svg)) {
            h += '<div class="vizerr">[svg] missing or invalid SVG markup — the agent sent a placeholder, not a real chart</div>';
            return;
          }
          const runner = '<div id="root" style="width:100%;height:100%"></div>'
            + '<script>window.render=function(d){var r=document.getElementById("root");if(r&&d&&d.svg)r.innerHTML=d.svg;}<' + '/script>';
          vizzes.push({ code: runner, data: { svg: svg }, label: c.label || '' });
          h += '<div class="viz"><iframe class="vizframe" sandbox="allow-scripts"></iframe></div>';
        }
      });
    }
    // Image is ONE declarative component (src is a data: URI over the channel;
    // the webview can't fetch remote URLs). Supports data: URIs by design.
    if (u.image && u.image.src) {
      h += '<figure class="img"><img src="' + esc(u.image.src) + '" alt="' + esc(u.image.alt || '') + '">'
        + (u.image.alt ? '<figcaption>' + esc(u.image.alt) + '</figcaption>' : '') + '</figure>';
    }
    if (u.button) h += '<button id="act">' + esc(u.button.label) + '</button>';
    // Controls (mic + stop) come over the wire as components; draw them last so the
    // control bar sits at the bottom of the current message, sticky to stay visible.
    h += controlsHTML(u);
    ui.innerHTML = h;
    bindControls();
    // Keep the mic/stop labels honest — reflect real native audio state after each render.
    if (window.__syncLiveCtl) window.__syncLiveCtl();
    // Mount any charts. ApexCharts is a trusted local bundle; `options` is JSON
    // from the channel (declarative only — no functions can survive JSON.parse).
    charts.forEach(function (ch, i) {
      const el = ui.querySelectorAll('.chart')[i];
      if (el && window.ApexCharts) {
        try { new window.ApexCharts(el, ch.options).render(); } catch (e) { el.textContent = '[chart] ' + (e && e.message || e); }
      }
    });
    // Mount the viz sandbox. The injected code is embedded in a fresh opaque-origin
    // frame (sandbox="allow-scripts", no allow-same-origin) so it can never touch the
    // parent's window, Capacitor plugins, mic, Stop, bridge, or identity badge. It only
    // sees the data we postMessage to it, and calls the author's `render(payload)`.
    const jsEscape = str => String(str).replace(/<\//gi, '<\\/');
    const hasExternal = s => /<script[^>]+src=["']https?:/i.test(s || '');
    vizzes.forEach(function (v, i) {
      const fr = ui.querySelectorAll('.vizframe')[i];
      if (!fr) return;
      if (hasExternal(v.code)) {
        // The sandbox is egress-free: an external/CDN script can never load, so the
        // viz would silently render blank. Warn so the cause is visible, not hidden.
        const warn = document.createElement('div');
        warn.style.cssText = 'padding:10px;font-size:12px;color:#f0883e;height:100%;box-sizing:border-box';
        warn.textContent = '[viz] external/CDN script blocked (egress-free). The agent must inline the library source into the component instead.';
        fr.replaceWith(warn);
        return;
      }
      fr.setAttribute('sandbox', 'allow-scripts');
      fr.setAttribute('srcdoc',
        '<!doctype html><meta charset="utf-8">'
        + '<style>html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;overflow:hidden;font:13px/1.4 system-ui,sans-serif}</style>'
        + jsEscape(v.code)
        + '<script>window.addEventListener("message",function(e){var m=e.data;if(m&&m.type==="vmdata"){try{(window.render||function(){})(m.payload);}catch(err){try{parent.postMessage({type:"vimer",s:String(err)},"*");}catch(_){}}}});<\/script>'
        + (v.label ? '<div style="position:absolute;top:6px;right:10px;color:#8b949e;font-size:11px">' + esc(v.label) + '</div>' : ''));
      fr.onload = function () { try { fr.contentWindow.postMessage({ type: 'vmdata', payload: v.data }, '*'); } catch (e) {} };
    });
    const b = document.getElementById('act');
    if (b && u.button && u.button.action) {
      b.onclick = () => window.__agent.send(JSON.stringify({ type: 'action', rpc: u.button.action.rpc, args: u.button.action.args || {} }));
    }
  }

  window.__agent.onMessage.push(function (data) {
    let m = data;
    if (typeof data === 'string') { try { m = JSON.parse(data); } catch (_) { return; } }
    if (m && m.type === 'render') {
      // A single malformed component must never take the whole UI blank. Guard
      // draw() and surface the error visibly (survives as a screenshot clue).
      try { draw(m.ui); }
      catch (e) {
        console.error('[render]', e);
        try {
          const el = document.getElementById('ui');
          if (el) el.insertAdjacentHTML('beforeend',
            '<div style="color:#e06c75;padding:6px 10px;font:12px/1.4 monospace">[render error] ' + String(e && e.message || e) + '</div>');
        } catch (_) {}
      }
    }
    // Speech is audio-only: the agent's spoken reply is delivered as TTS audio,
    // NOT rendered as a text bubble. The display shows only agent-pushed widgets
    // (components). Leaving #ui untouched also keeps widgets from being wiped by
    // a mid-session spoken reply.
    else if (m && m.type === 'text') { /* spoken only — no on-screen text */ }
    else if (m && m.echo !== undefined) draw({ text: 'agent › ' + m.echo });
  });
})();
