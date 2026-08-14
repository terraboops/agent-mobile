// test-surface-integration.mjs — proves the ADAPTER's `__surface__` op shape
// (docs/display-surface.md Phase 3) plugs into the real HOST engine:
//   adapter _publish_surface -> {type:'surface', ops} -> surface-core.apply()
//   -> effect events (render / data) + render_result feedback (reportRender).
//
// It builds a full weather-tile batch (register_widget_type -> add_widget ->
// publish -> test_widget) and asserts the host's event sequence, using the same
// createSurface the webview host runs. Green = the widget ops the agent emits
// will render in place and report back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurface } from './www/surface-core.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; } else { failed++; console.log(`FAIL: ${name}`); } }

const weatherCode = load('widgets/weather-tile.js');
const clockCode = load('widgets/clock-widget.js');

// --- A: weather tile, full register -> test -> add -> publish -----------------
{
  const s = createSurface({ capacity: 1_000_000 });
  const evsByName = (name) => events.filter(e => e.event === name);

  let events = s.apply({ op: 'register_widget_type', name: 'weather_tile', code: weatherCode, assets: [] });
  events.forEach(e => {}); events = []; // (collected below per call)
  // capture all calls in order by wrappers:
  const log = [];
  const apply = s.apply.bind(s);
  const A = (op) => { const es = apply(op); es.forEach(e => log.push(e)); return es; };

  A({ op: 'register_widget_type', name: 'weather_tile', code: weatherCode, assets: [] });
  ok(log.some(e => e.event === 'type_ready' && e.name === 'weather_tile'), 'register_widget_type -> type_ready');

  // test probe first (render-feedback loop)
  A({ op: 'test_widget', key: 'probe_1', type: 'weather_tile', props: { title: 'probe' } });
  ok(log.some(e => e.event === 'render' && e.key === 'probe_1' && e.test === true), 'test_widget -> render(test)');

  // host reports the probe rendered
  const fb = s.reportRender('probe_1', true);
  ok(fb.length === 1 && fb[0].event === 'render_result' && fb[0].key === 'probe_1' && fb[0].ok === true,
     'reportRender -> render_result ok');

  // real tile
  A({ op: 'add_widget', key: 'w_weather', type: 'weather_tile', props: { title: 'Castlegar' } });
  ok(log.some(e => e.event === 'render' && e.key === 'w_weather' && e.type === 'weather_tile'), 'add_widget -> render');

  // in-place feed (no peer repaint)
  A({ op: 'publish', key: 'w_weather', data: { now: 9, min: 2, max: 12, cond: 'clear',
      hourly: [{ h: '00', t: 9 }, { h: '01', t: 8 }, { h: '02', t: 7 }] } });
  ok(log.some(e => e.event === 'data' && e.key === 'w_weather' && e.data.now === 9), 'publish -> data(in place)');

  // update props in place
  A({ op: 'update_widget', key: 'w_weather', props: { title: 'Castlegar BC' } });
  ok(log.some(e => e.event === 'update' && e.key === 'w_weather'), 'update_widget -> update');

  // remove
  A({ op: 'remove_widget', key: 'w_weather' });
  ok(log.some(e => e.event === 'destroy' && e.key === 'w_weather'), 'remove_widget -> destroy');

  // guards: unknown op / unknown type emit render_result failure
  let es = s.apply({ op: 'nope' });
  ok(es.some(e => e.event === 'render_result' && e.ok === false), 'unknown op -> render_result fail');
  es = s.apply({ op: 'add_widget', key: 'x', type: 'nope' });
  ok(es.some(e => e.event === 'render_result' && e.ok === false), 'unknown type -> render_result fail');
}

// --- B: register_widget_type with a missing asset is refused -------------------
{
  const s = createSurface({ capacity: 1_000_000 });
  const es = s.apply({ op: 'register_widget_type', name: 'needy', code: 'x', assets: ['lib/missing.js'] });
  ok(es.some(e => e.event === 'render_result' && e.ok === false && /missing asset/.test(e.error)),
     'register_widget_type refuses missing asset');
}

// --- C: storage cap enforced ----------------------------------------------------
{
  const s = createSurface({ capacity: 100 });           // tiny cap
  const es = s.apply({ op: 'register_asset', name: 'lib/big.js', mime: 'text/javascript',
                       b64: Buffer.from('a'.repeat(200)).toString('base64') });
  ok(es.some(e => e.event === 'render_result' && e.ok === false && /storage cap/.test(e.error)),
     'register_asset over cap -> render_result storage cap fail');
}

// --- D: asset + widget combo (register_asset -> register_widget_type w/ dep) ----
{
  const s = createSurface({ capacity: 1_000_000 });
  const spent = [];
  const B = (op) => { const es = s.apply(op); es.forEach(e => spent.push(e)); return es; };
  B({ op: 'register_asset', name: 'lib/help.js', mime: 'text/javascript', b64: Buffer.from('window.HELP=true').toString('base64') });
  B({ op: 'register_widget_type', name: 'clock', code: clockCode, assets: ['lib/help.js'] });
  B({ op: 'add_widget', key: 'c1', type: 'clock', props: { label: '--:--' } });
  B({ op: 'publish', key: 'c1', data: { text: '14:32' } });
  ok(spent.some(e => e.event === 'asset_ready' && e.name === 'lib/help.js'), 'register_asset -> asset_ready');
  ok(spent.some(e => e.event === 'type_ready' && e.name === 'clock'), 'asset then type -> type_ready');
  ok(s.getAsset('lib/help.js') && s.getAsset('lib/help.js').source === 'window.HELP=true', 'asset decodes to source');
  ok(spent.some(e => e.event === 'render' && e.key === 'c1' && e.type === 'clock'), 'clock add_widget -> render');
  ok(spent.some(e => e.event === 'data' && e.key === 'c1'), 'clock publish -> data');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
