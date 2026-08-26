// bridge.js — webview <-> native channel. The webview's ONLY network path is the
// AgentChannel native plugin. The injected agent JS cannot reach the wire itself.
(function () {
  'use strict';

  // ---- sandbox preamble ---------------------------------------------------------
  // Prepended to EVERY agent-code sandbox document (renderer.js viz/svg frames and
  // surface-host.js widget frames). The frames are sandbox="allow-scripts" (opaque
  // origin) and inherit the page CSP (connect-src 'none', ...). What CSP cannot do in
  // Chromium is stop WebRTC, and what the sandbox cannot do is stop code from minting a
  // fresh realm — so this preamble:
  //   * meta CSP child-src/frame-src/object-src 'none'  -> no nested browsing contexts
  //     (a nested no-src iframe in a sandboxed frame is cross-origin anyway; srcdoc/src
  //     frames are refused; a MutationObserver removes any that slip in)
  //   * x-dns-prefetch-control off                        -> no <link rel=dns-prefetch> leak
  //   * strips RTCPeerConnection & friends from the realm (non-configurable undefined)
  //   * disables attachShadow (no hiding frames from the observer)
  // Verified in Chromium by test/surface-live.test.mjs and test/containment.test.mjs.
  window.__sandboxPreamble =
    '<meta http-equiv="Content-Security-Policy" content="child-src \'none\'; frame-src \'none\'; object-src \'none\'; connect-src \'none\'">'
    + '<meta http-equiv="x-dns-prefetch-control" content="off">'
    + '<script>(function(){'
    + 'var N=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription","RTCDtlsTransport","RTCIceTransport","RTCSctpTransport","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver"];'
    + 'function strip(w){for(var i=0;i<N.length;i++){try{Object.defineProperty(w,N[i],{value:undefined,writable:false,configurable:false,enumerable:false});}catch(e){}}}'
    + 'strip(window);'
    + 'try{Object.defineProperty(Element.prototype,"attachShadow",{value:function(){throw new Error("shadow roots are disabled in the agent sandbox");},writable:false,configurable:false});}catch(e){}'
    + 'var KILL="iframe,frame,object,embed,portal,fencedframe";'
    + 'function purge(n){try{if(n.nodeType!==1)return;if(n.matches&&n.matches(KILL)){try{if(n.contentWindow)strip(n.contentWindow);}catch(e){}n.remove();return;}if(n.querySelectorAll){n.querySelectorAll(KILL).forEach(function(f){try{if(f.contentWindow)strip(f.contentWindow);}catch(e){}f.remove();});}}catch(e){}}'
    + 'new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(purge);});}).observe(document.documentElement,{childList:true,subtree:true});'
    + '})();<' + '/script>';

  window.__setAgentId = function (id) {
    var b = document.getElementById('agentid');
    if (b) b.textContent = id;
  };

  // Sync every on-screen mic control (however the renderer drew it) with live state.
  window.__syncAudioCtl = function (running) {
    // The ring: FILLED when the mic is live (unmuted), EMPTY/hollow when muted.
    var ring = document.getElementById('mic-ring');
    if (ring) {
      ring.classList.toggle('unmuted', !!running);
      ring.classList.toggle('muted', !running);
      if (!running) ring.classList.remove('pulse');
    }
    var mics = document.querySelectorAll('#ui [data-ctl="mic"]');
    mics.forEach(function (b) {
      var off = b.getAttribute('data-off') || '🎤 Start audio';
      b.textContent = running ? (b.getAttribute('data-on') || '⏹ Mic on') : off;
    });
    return running;
  };

  // The always-on ring + stop are bound ONCE at load; the agent cannot hide them.
  function bindCtrlBar() {
    var ring = document.getElementById('mic-ring');
    var stop = document.getElementById('ctl-stop');
    if (ring) ring.onclick = function () { window.__agent.audioToggle(); };
    if (stop) stop.onclick = function () { window.__agent.stop(); };

    // ---- Agent voice indicator: a "default example widget" with a few creative
    // visual variants. Shown floating above while the agent is speaking; tapping
    // it cycles the style (bars / glowing orb / dots). This is separate from the
    // mic ring entirely.
    var sp = document.getElementById('speechWidget');
    window.__spVariants = ['bars', 'orb', 'dots'];
    window.__spIdx = 0;
    function renderSpeech() {
      if (!sp) return;
      var v = window.__spVariants[((window.__spIdx % window.__spVariants.length) + window.__spVariants.length) % window.__spVariants.length];
      var html;
      if (v === 'bars') {
        html = '<span class="sp-speech bars"><span class="spbar"></span><span class="spbar"></span>'
             + '<span class="spbar"></span><span class="spbar"></span></span>';
      } else if (v === 'orb') {
        html = '<span class="sp-speech orb"></span>';
      } else {
        html = '<span class="sp-speech dots"></span>';
      }
      sp.innerHTML = html;
    }
    window.__renderSpeechWidget = renderSpeech;
    if (sp) sp.onclick = function () { window.__spIdx++; renderSpeech(); };
    renderSpeech();

    // Mic input level (0..1, from the sidecar's uplink RMS) -> pulse the ring
    // ONLY while the mic is live (unmuted). No pulse when muted/silent.
    window.__setMicLevel = function (lvl) {
      var r = document.getElementById('mic-ring');
      if (!r || r.classList.contains('muted')) return;
      if (typeof lvl === 'number' && lvl > 0.03) r.classList.add('pulse');
      else r.classList.remove('pulse');
    };

    // Agent speaking -> show/hide the floating voice widget.
    window.__setAgentSpeaking = function (on) {
      var box = document.getElementById('agentSpeech');
      if (box) box.classList.toggle('show', !!on);
    };
    window.__syncLiveCtl();
  }

  // Ask the native plugin for the real audio state and reflect it on the buttons.
  // Call after every render so labels never drift from actual mic state (this is what
  // makes the toggle feel "sticky" — label said Start while the mic was already on).
  window.__syncLiveCtl = function () {
    var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AgentChannel;
    if (!P || !P.isAudioRunning) return Promise.resolve(false);
    return P.isAudioRunning().then(function (r) { return window.__syncAudioCtl(!!(r && r.running)); })
      .catch(function () { return false; });
  };

  // Start the mic if it is not already running — NEVER stop it. Safe to call on every
  // (re)connect; the native mic button (MainActivity) is the only thing that mutes.
  window.__ensureMicOn = function () {
    var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AgentChannel;
    if (!P || !P.isAudioRunning) return Promise.resolve(false);
    return P.isAudioRunning().then(function (r) {
      if (r && r.running) return true;
      return P.startAudio().then(function () { return true; });
    }).catch(function () { return false; });
  };

  window.__agent = {
    onMessage: [],
    send: function (payload) {
      return window.Capacitor.Plugins.AgentChannel.send({ payload: String(payload) })
        .then(function (r) {
          if (r && r.reply) window.__pushAgentMessage(r.reply);
          return r ? r.reply : null;
        })
        .catch(function (e) {
          window.__pushAgentMessage(JSON.stringify({ type: 'text', text: '[err] ' + (e && e.message || e) }));
          return null;
        });
    },
    // Mic is native + capability/consent-gated. Toggling it only asks the native
    // plugin to start/stop; the plugin refuses unless consent is granted. A re-entrancy
    // guard stops rapid taps from double-flipping while a native start/stop is in flight.
    audioToggle: function () {
      var self = this;
      if (self._busy) return Promise.resolve(false);
      self._busy = true;
      var P = window.Capacitor.Plugins.AgentChannel;
      return P.isAudioRunning().then(function (r) {
        var on = !!(r && r.running);
        return (on ? P.stopAudio() : P.startAudio()).then(function () {
          return window.__syncAudioCtl(!on);
        });
      }).catch(function (e) {
        window.__pushAgentMessage(JSON.stringify({ type: 'text', text: '[audio] ' + (e && e.message || e) }));
        return false;
      }).then(function (st) {
        self._busy = false;
        return st;
      });
    },
    // Stop the running Hermes turn (echo of /stop). Not a user message.
    stop: function () {
      return window.__agent.send('{"cmd":"interrupt"}');
    },
  };
  window.toggleAudio = function () { return window.__agent.audioToggle(); };

  window.__pushAgentMessage = function (data) {
    (window.__agent.onMessage || []).forEach(function (fn) { try { fn(data); } catch (_) {} });
  };

  window.__mode = 'resume';

  // Gate connection behind the app's session bootstrap. 'new' resets the Hermes
  // session (/new) so its system prompt — including the skill index — rebuilds fresh.
  window.__bootstrap = function (mode) {
    window.__mode = (mode === 'new') ? 'new' : 'resume';
    window.Capacitor.Plugins.AgentChannel.connect({
      url: window.AGENT_URL,
      baseMs: window.AGENT_BASE_MS || 2000,
      threshold: 3,
      probeTimeoutMs: 400,
    });
  };

  (function () {
    bindCtrlBar();
    try {
      window.Capacitor.Plugins.AgentChannel.addListener('session', function (d) {
        if (!d || !d.agentId) return;
        window.__setAgentId(d.agentId);
        // 'new': reset the Hermes session so its system prompt (skills) rebuilds.
        // Fire-and-forget — the adapter consumes /new silently and never replies, so
        // we must NOT wait on it (the greeting is what starts the fresh session).
        if (window.__mode === 'new') window.__agent.send('/new');
        window.__agent.send('hello from Pixel');
        // Idempotent: ensure the mic is ON without TOGGLING. The old toggleAudio() flipped the
        // mic state on EVERY session connect, so an auto-reconnect turned the mic OFF under the
        // user and the control wedged (issue #1). The native mic button owns muting now.
        window.__ensureMicOn(); window.__syncLiveCtl();
      });
      window.Capacitor.Plugins.AgentChannel.addListener('partition', function (d) {
        window.__pushAgentMessage(JSON.stringify({
          type: 'text',
          text: d && d.partition ? '⚠ network partition — speech is being buffered' : '✓ network restored — buffered speech flushed',
        }));
      });
      // Agent-initiated pushes (async text / declarative UI / data) -> renderer
      window.Capacitor.Plugins.AgentChannel.addListener('message', function (d) {
        if (d && d.payload) window.__pushAgentMessage(d.payload);
      });
    } catch (e) {
      window.__setAgentId('connect error');
    }
  })();
})();
