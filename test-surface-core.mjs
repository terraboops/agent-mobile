// Offline test for the display-surface op core (docs/display-surface.md).
import { createSurface } from './www/surface-core.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', msg); } };
const evs = (s, op) => s.apply(op);

// 1. Register an asset and a widget type that depends on it.
let s = createSurface({ capacity: 1024 });
let e = evs(s, { op: 'register_asset', name: 'lib/a.js', mime: 'text/javascript', b64: 'aGVsbG8=', append: false });
ok(e.length === 1 && e[0].event === 'asset_ready', 'asset registered');
ok(s.state.assets.includes('lib/a.js'), 'asset in state');
ok(s.state.usage > 0, 'usage tracks bytes');

e = evs(s, { op: 'register_widget_type', name: 'box', code: 'x', assets: ['lib/a.js'] });
ok(e.some(x => x.event === 'type_ready'), 'widget type registered when dep present');

// 2. A type whose dep is missing is refused + reported.
let s2 = createSurface();
let e2 = evs(s2, { op: 'register_widget_type', name: 'orphan', assets: ['lib/missing.js'] });
ok(e2.some(x => x.event === 'render_result' && x.ok === false && /missing/.test(x.error)), 'missing dep refused with feedback');

// 3. add / publish / update / remove on a live widget.
let s3 = createSurface();
evs(s3, { op: 'register_widget_type', name: 't', code: 'render=1' });
let a3 = evs(s3, { op: 'add_widget', key: 'w1', type: 't', props: { v: 1 } });
ok(a3.some(x => x.event === 'render' && x.key === 'w1'), 'add_widget emits render');
ok(s3.state.widgets.includes('w1'), 'widget in state');
let d3 = evs(s3, { op: 'publish', key: 'w1', data: { v: 2 } });
ok(d3.some(x => x.event === 'data' && x.key === 'w1' && x.data.v === 2), 'publish emits data to key');
let u3 = evs(s3, { op: 'update_widget', key: 'w1', props: { v: 3 } });
ok(u3.some(x => x.event === 'update' && x.key === 'w1'), 'update_widget emits update');
let r3 = evs(s3, { op: 'remove_widget', key: 'w1' });
ok(r3.some(x => x.event === 'destroy' && x.key === 'w1'), 'remove_widget emits destroy');
ok(!s3.state.widgets.includes('w1'), 'widget removed from state');

// 4. publish to a missing widget reports an error back.
let s4 = createSurface();
let e4 = evs(s4, { op: 'publish', key: 'nope', data: {} });
ok(e4.some(x => x.event === 'render_result' && x.ok === false), 'publish to missing widget yields render_result');

// 5. Storage cap is enforced.
let s5 = createSurface({ capacity: 10 });
let e5 = evs(s5, { op: 'register_asset', name: 'big', b64: 'aGVsbG8gd29ybGQhIQ==', append: false });
ok(e5.some(x => x.event === 'render_result' && x.ok === false && /cap/.test(x.error)), 'storage cap enforced with feedback');

// 6. Host-reported render success/failure round-trips as render_result.
let s6 = createSurface();
let back = s6.reportRender('probe_1', false, 'boom');
ok(back.some(x => x.event === 'render_result' && x.key === 'probe_1' && x.ok === false && x.error === 'boom'), 'reportRender surfaces errors');

// 7. register_widget_type with no assets is allowed (self-contained).
let s7 = createSurface();
let e7 = evs(s7, { op: 'register_widget_type', name: 'standalone', code: '1' });
ok(e7.some(x => x.event === 'type_ready'), 'self-contained type registers');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
