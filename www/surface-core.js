// surface-core.js — pure, testable core of the display-surface op model
// (see docs/display-surface.md). No DOM: this returns state + effect events, so the
// webview host renders from it and the same code is unit-testable in Node.
//
// State:
//   assets  { name -> { mime, chunks: [], size, complete } }   // shipped byte blobs
//   types   { name -> { code, assets: [] } }                    // widget type defs
//   widgets { key  -> { type, props } }                         // live tiles
//   usage   bytes of stored asset bytes (honors capacity cap)
//
// Effects (emitted as { event: ... }):
//   { event:'asset_ready',  name }
//   { event:'render',       key, type, props }        // instantiate a tile
//   { event:'update',       key, props }
//   { event:'data',         key, data }               // feed a tile in place
//   { event:'destroy',      key }                     // tear a tile down
//   { event:'render_result', key, ok, error? }        // render feedback to the agent
//   { event:'storage_warning', usage, capacity }

export function createSurface({ capacity = 100 * 1024 * 1024 } = {}) {
  let assets = {};
  let types = {};
  let widgets = {};
  let usage = 0;
  const emits = [];

  // accumulate an in-flight multi-chunk asset
  let pending = {}; // name -> { mime, chunks: [], bytes }

  function emit(ev) { emits.push(ev); }

  function base64Bytes(b64) {
    const s = (b64 || '').replace(/\s+/g, '');
    const pad = s.length % 4; const clean = s + '==='.slice(0, pad ? 4 - pad : 0);
    return Math.max(0, Math.floor((clean.length * 3) / 4));
  }

  // Decode a standard-API base64 string to UTF-8 text. Works in both the webview
  // (atob + TextDecoder) and Node (which has both globals), so a registered asset's
  // source can be materialized by whoever hosts the surface.
  function decodeB64(b64) {
    const s = (b64 || '').replace(/\s+/g, '');
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xE0) out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[++i] & 0x3F));
      else if (b < 0xF0) out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F));
    }
    return out;
  }

  function finishAsset(name) {
    const p = pending[name];
    delete pending[name];
    assets[name] = { mime: p.mime, chunks: p.chunks, complete: true, size: p.bytes };
    emit({ event: 'asset_ready', name, size: p.bytes });
    return true;
  }

  return {
    get state() {
      return {
        assets: Object.keys(assets), types: Object.keys(types),
        widgets: Object.keys(widgets), usage, capacity,
      };
    },

    // De-coded source of a fully-registered asset (bytes that were shipped base64).
    // The core is DOM-free, so materializing the bytes for the host to mount lives
    // here as a pure accessor; the host turns it into a <script>/<style>.
    getAssetSource(name) {
      const a = assets[name];
      if (!a || !a.complete) return null;
      if (typeof a.source === 'string') return a.source;
      a.source = a.chunks.map(decodeB64).join('');
      return a.source;
    },

    // Full registered asset: { mime, source } or null if not fully registered.
    getAsset(name) {
      const src = this.getAssetSource(name);
      if (src == null) return null;
      return { mime: assets[name].mime, source: src };
    },

    // The JS (and its asset deps) a widget type will run.
    getType(name) {
      const t = types[name];
      return t ? { code: t.code || '', assets: (t.assets || []).slice() } : null;
    },

    // Live props of a widget (what add_widget/update_widget has accumulated).
    getWidget(key) {
      const w = widgets[key];
      return w ? { type: w.type, props: Object.assign({}, w.props) } : null;
    },

    // Apply one surface op. Returns the events produced by this op.
    apply(op) {
      switch (op.op) {
        case 'register_asset': {
          const { name, mime, b64, append } = op;
          if (!pending[name]) pending[name] = { mime: mime || 'application/octet-stream', chunks: [], bytes: 0 };
          const bytes = base64Bytes(b64);
          if ((usage + bytes) > capacity) {
            emit({ event: 'render_result', ok: false, error: `storage cap exceeded (${usage}+${bytes}>${capacity})`, key: name });
            break;
          }
          pending[name].chunks.push(b64);
          pending[name].bytes += bytes;
          usage += bytes;
          if (!append) finishAsset(name);
          break;
        }
        case 'register_widget_type': {
          const { name, code, assets: deps } = op;
          const missing = (deps || []).find(d => !assets[d]);
          if (missing) {
            emit({ event: 'render_result', ok: false, error: `missing asset ${missing}`, key: op.testKey });
            break; // refuse to register until its deps exist (agent must ship + test first)
          }
          types[name] = { code: code || '', assets: deps || [] };
          emit({ event: 'type_ready', name });
          break;
        }
        case 'add_widget': {
          if (!types[op.type]) {
            emit({ event: 'render_result', ok: false, error: `unknown widget type ${op.type}`, key: op.key });
            break;
          }
          widgets[op.key] = { type: op.type, props: op.props || {} };
          emit({ event: 'render', key: op.key, type: op.type, props: op.props || {} });
          break;
        }
        case 'update_widget': {
          if (!widgets[op.key]) { emit({ event: 'render_result', ok: false, error: `no widget ${op.key}` }); break; }
          widgets[op.key].props = opts(widgets[op.key].props, op.props);
          emit({ event: 'update', key: op.key, props: op.props });
          break;
        }
        case 'publish': {
          if (!widgets[op.key]) { emit({ event: 'render_result', ok: false, error: `no widget ${op.key}`, key: op.key }); break; }
          emit({ event: 'data', key: op.key, data: op.data });
          break;
        }
        case 'remove_widget': {
          if (widgets[op.key]) { delete widgets[op.key]; emit({ event: 'destroy', key: op.key }); }
          break;
        }
        case 'test_widget': {
          if (!types[op.type]) {
            emit({ event: 'render_result', ok: false, error: `unknown widget type ${op.type}`, key: op.key });
            break;
          }
          emit({ event: 'render', key: op.key, type: op.type, props: op.props || {}, test: true });
          break;
        }
        default:
          emit({ event: 'render_result', ok: false, error: `unknown op ${op.op}`, key: op.key });
      }
      return emits.splice(0, emits.length);
    },

    // The webview host reports how a tile actually rendered.
    reportRender(key, ok, error) {
      emit({ event: 'render_result', key, ok, error });
      return emits.splice(0, emits.length);
    },
  };
}

function opts(prev, patch) {
  const o = Object.assign({}, prev);
  for (const k in patch) o[k] = patch[k];
  return o;
}
