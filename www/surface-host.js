// surface-host.js — wires the display-surface op core (surface-core.js) into the
// live agent-mobile renderer. Runs as an ES module beside renderer.js (a classic
// script) and shares the SAME __agent.onMessage dispatch bridge.
//
// Division of labor (both listen on __agent.onMessage; they never conflict):
//   renderer.js     handles legacy { type:'render', ui:{ components:[...] } }
//   surface-host.js handles      { type:'surface', ops:[<op>, ...] }
//
// Surface model (docs/display-surface.md):
//   * a library/asset is REGISTERED once  -> register_asset (base64, append-able)
//   * a widget type is   REGISTERED once  -> register_widget_type(code, assets)
//   * a widget is ADDED once by stable key-> add_widget(key,type,props)
//   * data is pushed in          place    -> publish / update_widget
//   * every key owns a STABLE DOM viewport (node + optional iframe), so an update
//     re-renders ONLY that tile — never wipes peers or #ui.
//
// Egress-free + sandbox guarantee: agent-shipped widget code runs in the same
// opaque-origin sandboxed-iframe model renderer.js already uses for viz/svg
// (sandbox="allow-scripts", NO allow-same-origin -> no bridge, mic, stop,
// identity, or remote fetch). Injected frames get the widget type's registered
// assets + code, and are fed props/data by postMessage only.
import { createSurface } from './surface-core.js';

(function () {
  'use strict';

  // ---- host resources ----------------------------------------------------
  function capacity() {
    try {
      const n = parseInt((localStorage.getItem('agentmob.surface.cap') || ''), 10);
      return Number.isFinite(n) && n > 0 ? n : 100 * 1024 * 1024;
    } catch (_) { return 100 * 1024 * 1024; }
  }
  const surface = createSurface({ capacity: capacity() });

  // key -> { node, iframe, type, chart, label }
  const views = {};

  // -- small render helpers (mirror renderer.js) ---------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const jsEscape = str => String(str).replace(/<\//gi, '<\\/');
  const hasExternal = s => /<script[^>]+src=["']https?:/i.test(s || '');

  let surfaceEl = document.getElementById('surface');
  if (!surfaceEl) {
    surfaceEl = document.createElement('div');
    surfaceEl.id = 'surface';
    const ui = document.getElementById('ui');
    (ui && ui.parentNode ? ui.parentNode : document.body).appendChild(surfaceEl);
  }

  function makeView(key) {
    const node = document.createElement('div');
    node.className = 'swidget';
    node.dataset.key = String(key);
    const v = { key, node, type: null, iframe: null, chart: null, label: '' };
    views[key] = v;
    surfaceEl.appendChild(node);
    return v;
  }

  // Build the srcdoc skeleton for a widget's sandboxed frame. `body` is raw HTML
  // (already-escaped <script>/<style> blocks) inlined after #root; the shared
  // message-listener runs last so it can route vmrender/vmdata to the widget api.
  // Every frame is a fresh opaque-origin sandbox (allow-scripts, no same-origin):
  // it can never reach the bridge, mic, stop, identity, or the network.
  function sandboxDoc(body, label) {
    return '<!doctype html><meta charset="utf-8">'
      + '<style>html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;overflow:hidden;font:13px/1.4 system-ui,sans-serif}</style>'
      + '<div id="root" style="width:100%;height:100%"></div>'
      + body
      + '<script>(function(){window.addEventListener("message",function(e){var m=e.data;if(!m)return;var r=document.getElementById("root");var ok=true;var t="";'
      + 'try{if(m.type==="vmrender"){if(window.render)window.render(m.props||{});}'
      + 'else if(m.type==="vmdata"){if(window.onData)window.onData(m.data||{});else if(window.render)window.render(m.data||{});}'
      + 't=r?r.innerText:"";}catch(err){ok=false;t=String(err&&err.message||err);}'
      + 'try{window.parent.postMessage({type:ok?"vmroot":"vimer",text:t},"*");}catch(_){}});})();<' + '/script>'
      + (label ? '<div style="position:absolute;top:6px;right:10px;color:#8b949e;font-size:11px">' + esc(label) + '</div>' : '');
  }

  function mountSandbox(v, body, data, label, autoPost) {
    v.node.innerHTML = '';
    const fr = document.createElement('iframe');
    fr.className = 'vizframe';
    fr.setAttribute('sandbox', 'allow-scripts');
    fr.setAttribute('srcdoc', sandboxDoc(body, label));
    v.iframe = fr;
    v.node.appendChild(fr);
    fr.onload = autoPost ? function () { try { fr.contentWindow.postMessage({ type: 'vmdata', data: data || {} }, '*'); } catch (_) {} } : null;
    return v;
  }

  // Feed an in-place update to an existing view. data === publish payload; props
  // === render/update props. Both funnel through the same draw with their role.
  function feed(v, props, data) {
    // Registered agent-shipped type -> sandboxed module, postMessage only.
    if (surface.getType(v.type) && v.iframe) {
      try {
        if (props !== undefined) v.iframe.contentWindow.postMessage({ type: 'vmrender', props: props || {} }, '*');
        if (data !== undefined) v.iframe.contentWindow.postMessage({ type: 'vmdata', data: data || {} }, '*');
      } catch (_) {}
      return;
    }
    // Built-in primitive for backward compatibility with the flat renderer.
    const type = v.type;
    if (type === 'text') {
      const t = (data && data.text != null ? data.text : props && props.text) || '';
      v.node.innerHTML = '<p class="swtext">' + esc(t) + '</p>';
    } else if (type === 'list') {
      const items = (props && Array.isArray(props.items) ? props.items : data && data.items) || (props && props.list) || [];
      v.node.innerHTML = '<ul>' + items.map(i => '<li>' + esc(i && i.title != null ? i.title : i)
        + (i && i.subtitle ? '<em>' + esc(i.subtitle) + '</em>' : '') + '</li>').join('') + '</ul>';
    } else if (type === 'image') {
      const src = (props && props.src) || (data && data.src);
      const alt = (props && props.alt) || (data && data.alt) || '';
      v.node.innerHTML = '<figure class="swimg"><img src="' + esc(src) + '" alt="' + esc(alt) + '">'
        + (alt ? '<figcaption>' + esc(alt) + '</figcaption>' : '') + '</figure>';
    } else if (type === 'chart') {
      // Declarative ApexCharts options (JSON only — no functions can survive the wire).
      const options = (props && props.options) || (data && data.options) || {};
      v.node.classList.add('chartbox');
      v.node.innerHTML = '<div class="chart"></div>';
      if (window.ApexCharts) {
        try {
          if (v.chart) { v.chart.updateOptions(options, true); }
          else { v.chart = new window.ApexCharts(v.node.firstChild, options); v.chart.render(); }
        } catch (e) { v.node.textContent = '[chart] ' + (e && e.message || e); }
      }
    } else if (type === 'svg') {
      const svg = String((props && props.svg) || (data && data.svg) || '').trim();
      if (!/^<svg[\s>]/i.test(svg)) { v.node.innerHTML = '<div class="vizerr">[svg] missing or invalid SVG markup</div>'; return; }
      const runner = '<script>window.render=function(d){var r=document.getElementById("root");if(r&&d&&d.svg)r.innerHTML=d.svg;}<' + '/script>';
      mountSandbox(v, runner, { svg: svg }, v.label, true);
    } else if (type === 'viz') {
      const code = (props && props.code) || '';
      if (hasExternal(code)) {
        v.node.innerHTML = '<div style="padding:10px;font-size:12px;color:#f0883e">[viz] external/CDN script blocked (egress-free). Inline the library source.</div>';
        return;
      }
      const dd = (props && props.data) || (data && data.data) || {};
      const body = code ? '<script>' + jsEscape(code) + '<' + '/script>' : '';
      mountSandbox(v, body, dd, (props && props.label) || v.label, true);
    } else {
      v.node.innerHTML = '<div class="vizerr">[surface] unknown widget type "' + esc(type) + '"</div>';
    }
  }

  // Mount a registered (agent-shipped) widget type: assets + type code in a
  // sandbox; initial props via vmrender, early data via vmdata.
  function mountRegistered(v, props, data) {
    const def = surface.getType(v.type);
    const assetTags = (def.assets || []).map(function (a) {
      const asset = surface.getAsset(a);
      if (!asset) return '';
      return /^text\/css/i.test(asset.mime)
        ? '<style>' + jsEscape(asset.source) + '</style>'
        : '<script>' + jsEscape(asset.source) + '<' + '/script>';
    }).join('');
    const body = assetTags
      + '<script>' + jsEscape(def.code || '') + '<' + '/script>';
    if (hasExternal(body)) { v.node.innerHTML = '<div style="padding:6px;font-size:12px;color:#f0883e">[widget] external script blocked (egress-free).</div>'; return; }
    mountSandbox(v, body, data || {}, (props && props.label) || v.label, false);
    // Deliver initial props once the frame is up (calls window.render(props)).
    if (props !== undefined) {
      const fr = v.iframe;
      (function (p, d) {
        fr.onload = function () {
          try { fr.contentWindow.postMessage({ type: 'vmrender', props: p || {} }, '*'); } catch (_) {}
          try { if (d !== undefined) fr.contentWindow.postMessage({ type: 'vmdata', data: d || {} }, '*'); } catch (_) {}
        };
      })(props, data);
    }
  }

  // ---- report render outcomes to the agent --------------------------------
  function report(key, ok, err) {
    const evs = surface.reportRender(key, ok, err);
    (evs || []).forEach(function (ev) {
      if (ev.event === 'render_result') sendUp({ type: 'render_result', key: ev.key, ok: ev.ok, error: ev.error });
    });
  }
  function sendUp(obj) {
    try { if (window.__agent && window.__agent.send) window.__agent.send(JSON.stringify(obj)); }
    catch (_) { /* channel may not be connected yet — caller may retry */ }
  }

  // Report the CURRENT surface (registered types + live widget keys) back to the
  // agent so it pushes to existing keys instead of re-registering/re-adding. This
  // is device->agent context (routed by the adapter), not a user turn.
  function reportState() {
    const st = surface.state;
    sendUp({ type: 'surface_state', state: { assets: st.assets, types: st.types, widgets: st.widgets } });
  }
  window.__reportSurfaceState = reportState;

  // Render feedback FROM the sandboxes. Each view's frame echoes vmroot (success)
  // or vimer (failure) with the rendered text; attribute by event.source so a
  // failing/crashing widget reports back without breaking its peers.
  function keyOfSource(source) {
    for (const k in views) {
      const fr = views[k] && views[k].iframe;
      if (fr && fr.contentWindow && fr.contentWindow === source) return k;
    }
    return null;
  }
  window.addEventListener('message', function (e) {
    const k = keyOfSource(e.source);
    if (!k) return; // not ours (could be renderer.js's viz frame — ignore)
    const d = e.data || {};
    if (d.type === 'vimer') report(k, false, String(d.text));
    else if (d.type === 'vmroot') {
      if (views[k]) views[k].rendered = String(d.text || '');
      if (views[k] && views[k].pendingFeedback) {
        views[k].pendingFeedback = false;
        report(k, true, undefined); // render feedback for an async test_widget mount
      }
    }
  });

  // ---- event handling ------------------------------------------------------
  function handleRenderEvent(ev) {
    let v = views[ev.key];
    if (!v) v = makeView(ev.key);
    v.type = ev.type;
    v.label = (ev.props && ev.props.label) || '';
    try {
      if (surface.getType(ev.type)) {
        // async mount -> render feedback arrives via the sandbox vmroot echo
        v.pendingFeedback = !!ev.test;
        mountRegistered(v, ev.props || {}, undefined);
      } else {
        feed(v, ev.props || {}, undefined);
        if (ev.test) report(ev.key, true, undefined); // sync builtin feedback
      }
    } catch (e) {
      console.error('[surface:render]', ev.key, e);
      v.pendingFeedback = false;
      report(ev.key, false, String(e && e.message || e));
    }
  }

  function teardownView(key) {
    const v = views[key];
    if (!v) return;
    try { if (v.node && v.node.parentNode) v.node.parentNode.removeChild(v.node); } catch (_) {}
    delete views[key];
  }

  function handleEvent(ev) {
    switch (ev.event) {
      case 'asset_ready':
      case 'type_ready':
        break; // materializable on demand via getAsset/getType
      case 'render': // add_widget OR test_widget
        handleRenderEvent(ev);
        break;
      case 'update': { // update_widget -> props-only, in place, one tile
        const v = views[ev.key];
        if (!v) break;
        if (surface.getType(v.type) && v.iframe) {
          try { v.iframe.contentWindow.postMessage({ type: 'vmrender', props: ev.props || {} }, '*'); } catch (_) {}
        } else {
          feed(v, ev.props || {}, undefined);
        }
        break;
      }
      case 'data': { // publish -> feed one tile in place, no peer repaint
        const v = views[ev.key];
        if (!v) break;
        if (surface.getType(v.type) && v.iframe) {
          try { v.iframe.contentWindow.postMessage({ type: 'vmdata', data: ev.data || {} }, '*'); } catch (_) {}
        } else {
          feed(v, undefined, ev.data || {});
        }
        break;
      }
      case 'destroy': // remove_widget
        teardownView(ev.key);
        break;
      case 'render_result':
        if (ev.ok === false) sendUp({ type: 'render_result', key: ev.key, ok: false, error: ev.error });
        break;
      case 'storage_warning':
        sendUp({ type: 'text', text: '[surface] storage cap: ' + ev.usage + '/' + ev.capacity });
        break;
      default:
        break;
    }
  }

  function applyOps(ops) {
    (ops || []).forEach(function (op) {
      // A test_widget probe is NOT added to the core registry, so a later
      // remove_widget on it produces no 'destroy' event. The host still owns the
      // DOM viewport, so it tears it down on any remove_widget regardless of the
      // registry verdict (surface-core stays authoritative for the registry; the
      // host only mirrors live tiles).
      if (op.op === 'remove_widget') {
        let events = [];
        try { events = surface.apply(op); } catch (e) { report(op.key, false, String(e && e.message || e)); return; }
        (events || []).forEach(handleEvent);
        teardownView(op.key);
        return;
      }
      let events = [];
      try { events = surface.apply(op); }
      catch (e) { report(op.key || op.name || '', false, String(e && e.message || e)); return; }
      (events || []).forEach(handleEvent);
    });
    // Keep the agent's view of the surface current after every applied batch.
    reportState();
  }

  // ---- bridge ---------------------------------------------------------------
  window.__agent.onMessage.push(function (data) {
    let m = data;
    if (typeof data === 'string') { try { m = JSON.parse(data); } catch (_) { return; } }
    if (m && m.type === 'surface' && Array.isArray(m.ops)) {
      try { applyOps(m.ops); } catch (e) { console.error('[surface]', e); }
    }
  });

  // Agent-facing introspection (for render feedback tooling / debugging).
  window.__surfaceState = function () { return surface.state; };
  window.__surfaceWidget = function (k) { return surface.getWidget(k); };
  window.__surfaceRender = function (k) { return views[k] ? views[k].rendered || '' : ''; };
})();
