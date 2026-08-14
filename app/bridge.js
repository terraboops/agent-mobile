// bridge.js — the ONE native surface exposed to the webview.
//
// The app's JS (including anything the agent injects) talks to the outside
// world only through window.__agent.send / onMessage. These funnel through
// window.__native_send, the single native function the shell exposes. There is
// no other bridge, no eval hook, no node integration. Any reply the agent
// returns is pushed back into the page as an incoming message.
(function () {
  'use strict';
  window.__agent = {
    send: function (payload) {
      return window.__native_send(String(payload)).then(function (reply) {
        if (reply) window.__pushAgentMessage(reply);
        return reply;
      });
    },
    onMessage: [],
  };
  window.__pushAgentMessage = function (data) {
    (window.__agent.onMessage || []).forEach(function (fn) {
      try { fn(data); } catch (_) { /* renderers must not break the channel */ }
    });
  };
})();
