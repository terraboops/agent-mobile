/*
 * weather-tile.js — a self-contained, sandboxed widget TYPE for the display
 * surface (docs/display-surface.md). The agent ships this string as the `code`
 * of a register_widget_type op, then adds a tile and publishes data in place.
 *
 * Contract: window.render(props) draws initially; window.onData(data) updates
 * in place (no re-registration). Runs in the egress-free opaque-origin sandbox,
 * so it is fully self-contained — no fetch, no external libs, no parent access.
 *
 * Data shape (publish payload):
 *   { title, now, min, max, cond, hourly:[{h:"00", t:9}, ...] }
 */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var box = document.createElement('div');
  box.style.cssText = 'padding:14px 16px;background:#161b22;border:1px solid #30363d;' +
    'border-radius:12px;color:#e6edf3;font-family:system-ui,sans-serif';
  root.appendChild(box);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function draw(d) {
    d = d || {};
    var h = '<div style="display:flex;justify-content:space-between;align-items:baseline">'
      + '<div style="font-size:15px;color:#8b949e">' + esc(d.title || '') + '</div>'
      + '<div style="font-size:30px;font-weight:700">' + esc(d.now != null ? d.now : '--') + '°</div></div>'
      + '<div style="font-size:13px;color:#8b949e;margin:2px 0 10px">min ' + esc(d.min != null ? d.min : '--')
      + '° · max ' + esc(d.max != null ? d.max : '--') + '° · ' + esc(d.cond || '') + '</div>';
    if (Array.isArray(d.hourly)) {
      h += '<div style="display:flex;gap:8px">' + d.hourly.slice(0, 6).map(function (p) {
        return '<div style="flex:1;text-align:center;background:#0d1117;border-radius:8px;padding:6px 0">'
          + '<div style="font-size:10px;color:#8b949e">' + esc(p.h || '') + '</div>'
          + '<div style="font-size:14px">' + esc(p.t != null ? p.t : '--') + '°</div></div>';
      }).join('') + '</div>';
    }
    box.innerHTML = h;
  }
  window.render = function (props) { draw(props); };
  window.onData = function (data) { if (data) draw(data); };
})();
