/*
 * weather-tile.js — a self-contained, sandboxed widget TYPE for the display
 * surface (docs/display-surface.md). The agent ships this string as the `code`
 * of a register_widget_type op, then adds a tile and publishes data in place.
 *
 * Contract: window.render(props) draws initially; window.onData(data) updates
 * in place (no re-registration). Runs in the egress-free opaque-origin sandbox,
 * so it is fully self-contained — no fetch, no external libs, no parent access.
 * Theme: colours come from the CSS variables the host ships into the frame
 * (--surface --ink --muted --accent --accent-2 --hairline --mono); they update
 * live when the surface theme changes.
 *
 * Data shape (publish payload):
 *   { title, now, min, max, cond, hourly:[{h:"00", t:9}, ...] }
 * Every field is optional; a malformed hourly entry is skipped, never thrown on.
 * Publishes MERGE over the last state, so a data-only publish keeps the title.
 */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var box = document.createElement('div');
  box.style.cssText = 'padding:14px 16px;background:var(--surface,#161b22);border:1px solid var(--hairline,#30363d);' +
    'border-radius:12px;color:var(--ink,#e6edf3);font-family:system-ui,sans-serif';
  root.appendChild(box);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { return (v == null || v === '' || (typeof v === 'number' && isNaN(v))) ? '--' : esc(v); }
  var MUTED = 'color:var(--muted,#8b949e)', MONO = 'font-family:var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums';
  var state = {};
  function draw(d) {
    d = state = Object.assign({}, state, (d && typeof d === 'object') ? d : {});
    var h = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">'
      + '<div style="font-size:15px;' + MUTED + '">' + esc(d.title || '') + '</div>'
      + '<div style="font-size:30px;font-weight:700;color:var(--accent,#e6edf3);' + MONO + '">' + num(d.now) + '°</div></div>'
      + '<div style="font-size:13px;margin:2px 0 10px;' + MUTED + '">min <span style="' + MONO + '">' + num(d.min)
      + '°</span> · max <span style="' + MONO + '">' + num(d.max) + '°</span>' + (d.cond ? ' · ' + esc(d.cond) : '') + '</div>';
    if (Array.isArray(d.hourly) && d.hourly.length) {
      h += '<div style="display:flex;gap:6px">' + d.hourly.slice(0, 6).map(function (p) {
        if (!p || typeof p !== 'object') return '';
        return '<div style="flex:1;text-align:center;background:color-mix(in srgb, var(--accent,#22d3ee) 8%, var(--surface,#0d1117));'
          + 'border:1px solid var(--hairline,#30363d);border-radius:8px;padding:6px 0">'
          + '<div style="font-size:12px;' + MUTED + ';' + MONO + '">' + esc(p.h != null ? p.h : '') + '</div>'
          + '<div style="font-size:14px;' + MONO + '">' + num(p.t) + '°</div></div>';
      }).join('') + '</div>';
    }
    box.innerHTML = h;
  }
  window.render = function (props) { draw(props); };
  window.onData = function (data) { if (data) draw(data); };
})();
