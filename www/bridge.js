// bridge.js — webview <-> native channel. The webview's ONLY network path is the
// AgentChannel native plugin. The injected agent JS cannot reach the wire itself.
(function () {
  'use strict';
  window.__setAgentId = function (id) {
    var b = document.getElementById('agentid');
    if (b) b.textContent = id;
  };

  // Sync every on-screen mic control (however the renderer drew it) with live state.
  window.__syncAudioCtl = function (running) {
    var mics = document.querySelectorAll('#ui [data-ctl="mic"]');
    mics.forEach(function (b) {
      var off = b.getAttribute('data-off') || '🎤 Start audio';
      b.textContent = running ? (b.getAttribute('data-on') || '⏹ Mic on') : off;
    });
    // Always-on bar (index.html #ctrlbar) — keep its label honest too.
    var pctl = document.getElementById('ctl-mic');
    if (pctl) pctl.textContent = running ? '⏹ Mic on' : '🎤 Start audio';
    return running;
  };

  // The always-on control bar is bound ONCE at load; it is separate from any
  // component the agent draws, so mute/stop are always available.
  function bindCtrlBar() {
    var mic = document.getElementById('ctl-mic');
    var stop = document.getElementById('ctl-stop');
    if (mic) mic.onclick = function () { window.toggleAudio(); };
    if (stop) stop.onclick = function () { window.__agent.stop(); };
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
        window.toggleAudio(); window.__syncLiveCtl();
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
