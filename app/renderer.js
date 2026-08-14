// renderer.js — draws the agent's declarative UI. Injected agent code cannot
// affect rendering beyond these typed nodes; everything reaches the screen
// through __pushAgentMessage.
(function () {
  'use strict';
  const ui = document.getElementById('ui');
  const badge = document.getElementById('agentid');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function draw(u) {
    if (!u) return;
    let h = '';
    if (u.title) h += '<h1>' + esc(u.title) + '</h1>';
    if (u.text) h += '<p>' + esc(u.text) + '</p>';
    if (Array.isArray(u.list)) {
      h += '<ul>' + u.list.map((i) =>
        '<li>' + esc(i.title) + (i.subtitle ? '<em>' + esc(i.subtitle) + '</em>' : '') + '</li>').join('') + '</ul>';
    }
    if (u.button) h += '<button id="act">' + esc(u.button.label) + '</button>';
    ui.innerHTML = h;
    const b = document.getElementById('act');
    if (b && u.button && u.button.action) {
      b.onclick = function () {
        window.__agent.send(JSON.stringify({ type: 'action', rpc: u.button.action.rpc, args: u.button.action.args || {} }));
      };
    }
  }

  window.__agent.onMessage.push(function (data) {
    let msg = data;
    if (typeof data === 'string') { try { msg = JSON.parse(data); } catch (_) { return; } }
    if (msg && msg.type === 'render') draw(msg.ui);
    else if (msg && msg.type === 'text') draw({ text: msg.text });
  });

  window.__setAgentId = function (id) { if (id) badge.textContent = id; };
})();
