/*
 * clock-widget.js — a self-contained, sandboxed widget TYPE for the display
 * surface. Agent ships as register_widget_type code, adds a tile, then publishes
 * { text: "14:32" } whenever the time changes (in-place, one tile, no repaint).
 *
 * Contract: window.render(props); window.onData(data). Egress-free + sandboxed.
 */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var el = document.createElement('div');
  el.style.cssText = 'font:bold 46px/1.2 ui-monospace,monospace;color:#e6edf3;' +
    'text-align:center;padding-top:26px;letter-spacing:1px';
  root.appendChild(el);
  window.render = function (props) {
    el.textContent = (props && props.text != null) ? props.text : (props ? props.label : '');
  };
  window.onData = function (data) { if (data && data.text != null) el.textContent = data.text; };
})();
