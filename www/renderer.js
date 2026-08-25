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

  // Mic/Stop controls are the ALWAYS-ON pinned bar in index.html (#ctrlbar),
  // bound once in bridge.js — no longer drawn per-render by the agent, so they
  // can never be hidden or omitted.

  function draw(u) {
    if (!u) return;
    let h = '';
    const charts = [];
    const vizzes = [];
    if (u.title) h += '<h1>' + esc(u.title) + '</h1>';
    // Image renders BEFORE the top-level text, so a caption/description lands BELOW
    // the image (the natural "picture with a caption under it" layout).
    if (u.image && u.image.src) {
      h += '<figure class="img"><img src="' + esc(u.image.src) + '" alt="' + esc(u.image.alt || '') + '">'
        + (u.image.alt ? '<figcaption>' + esc(u.image.alt) + '</figcaption>' : '') + '</figure>';
    }
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
          const runner = 'window.render=function(d){var r=document.getElementById("root");if(r&&d&&d.svg)r.innerHTML=d.svg;};';
          vizzes.push({ code: runner, data: { svg: svg }, label: c.label || '' });
          h += '<div class="viz"><iframe class="vizframe" sandbox="allow-scripts"></iframe></div>';
        }
      });
    }
    // Image is ONE declarative component (src is a data: URI over the channel;
    // the webview can't fetch remote URLs). (Rendered above the text near the top
    // of draw() so a caption sits below it.)
    if (u.button) h += '<button id="act">' + esc(u.button.label) + '</button>';
    ui.innerHTML = h;
    // Keep the always-on mic/stop labels honest — reflect real native audio state.
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
    //
    // `code` is JS (same contract as surface-host widget types: defines window.render /
    // window.onData) and is wrapped in <script> with `</` escaped so a "</script>" inside
    // a string cannot break out. For compatibility, code that is itself HTML (starts with
    // a tag / contains <script>) is inlined RAW — it must not be escaped, or every closing
    // tag turns into text and the runner script never closes (the old bug: viz/svg never
    // rendered, silently).
    const jsEscape = str => String(str).replace(/<\//gi, '<\\/');
    const hasExternal = s => /<script[^>]+src=["']https?:/i.test(s || '');
    const isHtml = s => /^\s*</.test(s || '') || /<script[\s>]/i.test(s || '');
    const frames = window.__vizFrames = [];          // index -> { frame, label }
    window.__vizStatus = {};                         // index -> 'ok' | 'error: ...' (render feedback)
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
      const body = isHtml(v.code) ? String(v.code) : ('<script>' + jsEscape(v.code) + '<' + '/script>');
      fr.setAttribute('sandbox', 'allow-scripts');
      fr.setAttribute('srcdoc',
        '<!doctype html><meta charset="utf-8">'
        + (window.__sandboxPreamble || '')   // realm hardening: no WebRTC, no nested frames (bridge.js)
        + '<style>html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;overflow:hidden;font:13px/1.4 system-ui,sans-serif}</style>'
        + '<div id="root" style="width:100%;height:100%"></div>'
        + body
        + '<script>window.addEventListener("message",function(e){var m=e.data;if(!m||m.type!=="vmdata")return;'
        + 'try{if(window.onData&&window.__vizInit)window.onData(m.payload);else{(window.render||function(){throw new Error("viz code defines no window.render")})(m.payload);window.__vizInit=true;}'
        + 'parent.postMessage({type:"vmok",i:' + i + '},"*");}catch(err){try{parent.postMessage({type:"vimer",i:' + i + ',s:String(err&&err.message||err)},"*");}catch(_){}}});<\/script>'
        + (v.label ? '<div style="position:absolute;top:6px;right:10px;color:#8b949e;font-size:11px">' + esc(v.label) + '</div>' : ''));
      frames[i] = { frame: fr, label: v.label };
      fr.onload = function () { try { fr.contentWindow.postMessage({ type: 'vmdata', payload: v.data }, '*'); } catch (e) {} };
    });
    const b = document.getElementById('act');
    if (b && u.button && u.button.action) {
      b.onclick = () => window.__agent.send(JSON.stringify({ type: 'action', rpc: u.button.action.rpc, args: u.button.action.args || {} }));
    }
  }

  // Live status strip (README "Feels alive"): heartbeat / mic pickup level /
  // "heard you" / agent working arrive as {type:'status', ...} pushes (adapter
  // drives heard/working; the sidecar drives hb/level). The chrome elements live
  // in index.html (#hb dot, #micfill meter, #heard, #work prog).
  function showTemp(id, ms) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('show');
    if (ms) setTimeout(function () { el.classList.remove('show'); }, ms);
  }
  function applyStatus(st) {
    if (!st) return;
    if (st.hb) {
      const hb = document.getElementById('hb');
      if (!hb) return;
      hb.classList.remove('off'); hb.classList.add('pulse');
      setTimeout(function () { hb.classList.remove('pulse'); }, 3400);
    }
    if (typeof st.level === 'number') {
      const f = document.getElementById('micfill');
      if (f) f.style.width = Math.max(2, Math.min(100, Math.round(st.level * 100))) + '%';
      // ring pulse from mic input (only pulse while mic is live — handled in bridge)
      if (window.__setMicLevel) window.__setMicLevel(st.level);
    }
    if (typeof st.speaking === 'boolean' && window.__setAgentSpeaking) {
      window.__setAgentSpeaking(st.speaking);   // floating agent-voice widget
    }
    if (st.heard) showTemp('heard', 4000);
    if (st.working !== undefined) {
      const w = document.getElementById('work');
      if (!w) return;
      const p = document.getElementById('workprog');
      if (st.working) { w.classList.add('show'); if (p) p.textContent = '…'; }
      else { w.classList.remove('show'); }
    }
  }
  // ---- conversation log (visible confirmation of turns) ---------------------
  // A compact, scrollable strip showing "you: <transcript>" and the agent's reply
  // text. This is what tells the user her speech was heard + transcribed correctly,
  // and what the agent said — independent of whether TTS audio played.
  function logEl() {
    var el = document.getElementById('convlog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'convlog';
      el.style.cssText = 'max-width:560px;margin:6px auto 0;padding:0 18px;'
        + 'display:flex;flex-direction:column;gap:6px;';
      var ui = document.getElementById('ui');
      (ui && ui.parentNode ? ui.parentNode : document.body).insertBefore(el, ui ? ui.nextSibling : null);
    }
    return el;
  }
  function logLine(who, text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return;
    var el = logEl();
    var row = document.createElement('div');
    var mine = who === 'you';
    row.style.cssText = 'font-size:13px;line-height:1.4;padding:8px 11px;border-radius:10px;'
      + (mine
          ? 'background:#1b2735;color:#cdd9e5;align-self:flex-end;border:1px solid #2a3a4d;'
          : 'background:#161b22;color:#e6edf3;align-self:flex-start;border:1px solid #30363d;');
    row.textContent = (mine ? '🗣 ' : '🤖 ') + text;
    el.appendChild(row);
    while (el.childNodes.length > 12) el.removeChild(el.firstChild); // keep it light
    row.scrollIntoView({ block: 'nearest' });
  }
  window.__logLine = logLine;

  window.__applyStatus = applyStatus;

  // Render feedback from the legacy viz/svg sandboxes: a failing viz is shown inline and
  // reported to the agent as render_result (key "viz:<index>") so it can correct the code.
  window.addEventListener('message', function (e) {
    const d = e.data || {};
    if (d.type !== 'vmok' && d.type !== 'vimer') return;
    const entry = window.__vizFrames && window.__vizFrames[d.i];
    if (!entry || !entry.frame || e.source !== entry.frame.contentWindow) return; // not ours
    if (d.type === 'vmok') { window.__vizStatus[d.i] = 'ok'; return; }
    window.__vizStatus[d.i] = 'error: ' + d.s;
    try {
      const box = entry.frame.parentNode;
      if (box) {
        const err = document.createElement('div');
        err.className = 'vizerr';
        err.textContent = '[viz' + (entry.label ? ' ' + entry.label : '') + '] ' + d.s;
        box.appendChild(err);
      }
    } catch (_) {}
    try { window.__agent.send(JSON.stringify({ type: 'render_result', key: 'viz:' + d.i, ok: false, error: String(d.s) })); } catch (_) {}
  });

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
    else if (m && m.type === 'transcript') { logLine('you', m.text); }
    else if (m && m.type === 'text') { logLine('agent', m.text); }  // show reply text too (visible confirmation; TTS still speaks it)
    else if (m && m.type === 'status') { if (window.__applyStatus) window.__applyStatus(m); }
    else if (m && m.echo !== undefined) draw({ text: 'agent › ' + m.echo });
  });
})();
