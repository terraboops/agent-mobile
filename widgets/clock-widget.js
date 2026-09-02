/*
 * clock-widget.js — a self-contained, sandboxed widget TYPE for the display
 * surface. Agent ships as register_widget_type code, adds a tile, then publishes
 * { text: "14:32" } whenever the time changes (in-place, one tile, no repaint).
 *
 * Contract: window.render(props); window.onData(data). Egress-free + sandboxed.
 * Theme: the host ships its tokens into every frame as CSS variables
 * (--surface --ink --muted --accent --accent-2 --hairline --mono) and updates
 * them live on theme change — never hard-code a palette.
 */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var el = document.createElement('div');
  el.style.cssText = 'font:700 46px/1.2 var(--mono,ui-monospace,monospace);color:var(--ink,#e6edf3);' +
    'text-align:center;padding:26px 0 18px;letter-spacing:.04em;font-variant-numeric:tabular-nums;' +
    'text-shadow:0 0 12px color-mix(in srgb, var(--accent,#22d3ee) 45%, transparent)';
  root.appendChild(el);
  function show(v) { el.textContent = (v == null || v === '') ? '--:--' : String(v); }
  window.render = function (props) {
    show(props && props.text != null ? props.text : (props ? props.label : null));
  };
  window.onData = function (data) { if (data && data.text != null) show(data.text); };
})();
