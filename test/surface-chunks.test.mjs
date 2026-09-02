// surface-chunks.test.mjs — multi-chunk asset upload FAILURE modes.
//
// surface-assets covers the happy path (append counts, abandoned uploads can be
// unregistered). What was never covered is what happens when a chunked upload
// goes wrong half-way — and an asset that completes CORRUPT is worse than one
// that fails, because the agent then registers a widget type over broken bytes
// and only discovers it when the widget throws.
import { createSurface } from '../www/surface-core.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const b64 = (n, ch = 0x41) => Buffer.alloc(n, ch).toString('base64');
const failed = (ev) => ev.filter((e) => e.event === 'render_result' && e.ok === false);
const ready = (ev) => ev.some((e) => e.event === 'asset_ready');

// 1. Cap exceeded MID-STREAM must abort the whole upload, not just drop one chunk.
{
  const s = createSurface({ capacity: 1000 });
  s.apply({ op: 'register_asset', name: 'lib', mime: 'text/javascript', b64: b64(400), append: true });
  const rej = s.apply({ op: 'register_asset', name: 'lib', mime: 'text/javascript', b64: b64(700), append: true });
  ok(failed(rej).length === 1, 'oversize middle chunk is reported');
  ok(s.state.usage === 0, `aborted upload returns its bytes (usage ${s.state.usage}, want 0)`);
  const fin = s.apply({ op: 'register_asset', name: 'lib', mime: 'text/javascript', b64: b64(100) });
  // The final chunk of an aborted upload must NOT complete an asset missing its middle.
  ok(!s.state.assets.includes('lib') || s.state.usage === 100,
    'a final chunk after abort does not complete a corrupt asset');
  const rt = s.apply({ op: 'register_widget_type', name: 't', code: '', assets: ['lib'] });
  const corrupt = s.state.assets.includes('lib') && s.state.usage === 100 && !failed(rt).length && !failed(fin).length;
  // Either the asset is absent (type registration fails: missing asset) or the
  // final chunk was itself reported as an error; silent success is the bug.
  ok(failed(rt).length === 1 || failed(fin).length === 1 || !corrupt,
    'the agent is told the asset is unusable (missing asset / chunk error), never silent');
}

// 2. A REJECTED replacement must not destroy the existing good asset.
{
  const s = createSurface({ capacity: 1000 });
  s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(300) });
  const rej = s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(1200) });
  ok(failed(rej).length === 1, 'oversize replacement is reported');
  ok(s.state.assets.includes('a'), 'the previous good asset survives a rejected replacement');
  ok(s.state.usage === 300, `usage still reflects the surviving asset (${s.state.usage}, want 300)`);
  const rt = s.apply({ op: 'register_widget_type', name: 't', code: '', assets: ['a'] });
  ok(!failed(rt).length, 'a widget type can still depend on the surviving asset');
}

// 3. A replacement that fits only because the old bytes are freed must be accepted.
{
  const s = createSurface({ capacity: 1000 });
  s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(800) });
  const ev = s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(900) });
  ok(!failed(ev).length && ready(ev) && s.state.usage === 900,
    `replacement is judged against cap MINUS the old asset (usage ${s.state.usage}, want 900)`);
}

// 4. Chunks carry an optional seq; a gap or replay is rejected and aborts (transport
//    is ordered, but a sidecar retry after a dropped ack must not corrupt).
{
  const s = createSurface({ capacity: 10000 });
  s.apply({ op: 'register_asset', name: 'q', mime: 'text/plain', b64: b64(10), append: true, seq: 0 });
  const bad = s.apply({ op: 'register_asset', name: 'q', mime: 'text/plain', b64: b64(10), append: true, seq: 2 });
  ok(failed(bad).length === 1 && /seq/.test(failed(bad)[0].error || ''), 'out-of-order chunk (seq 2 after 0) is rejected with a seq error');
  ok(s.state.usage === 0, 'out-of-order upload is aborted and freed');
}
{
  const s = createSurface({ capacity: 10000 });
  s.apply({ op: 'register_asset', name: 'q', mime: 'text/plain', b64: b64(10), append: true, seq: 0 });
  s.apply({ op: 'register_asset', name: 'q', mime: 'text/plain', b64: b64(10), append: true, seq: 1 });
  const fin = s.apply({ op: 'register_asset', name: 'q', mime: 'text/plain', b64: b64(10), seq: 2 });
  ok(ready(fin) && s.state.usage === 30, 'in-order seq 0,1,2 completes (30 bytes)');
}

// 5. Empty / missing payloads are not silently accepted as zero-byte assets.
{
  const s = createSurface({ capacity: 1000 });
  const ev = s.apply({ op: 'register_asset', name: 'e', mime: 'text/plain' });
  ok(failed(ev).length === 1, 'register_asset without b64 is reported');
  ok(!s.state.assets.includes('e'), 'no zero-byte asset is registered');
}

// 6. The final chunk's decoded source is the concatenation, in order.
{
  const s = createSurface({ capacity: 10000 });
  const enc = (t) => Buffer.from(t, 'utf8').toString('base64');
  s.apply({ op: 'register_asset', name: 'txt', mime: 'text/plain', b64: enc('hello '), append: true });
  s.apply({ op: 'register_asset', name: 'txt', mime: 'text/plain', b64: enc('wörld'), append: true });
  s.apply({ op: 'register_asset', name: 'txt', mime: 'text/plain', b64: enc('!') });
  ok(s.getAssetSource('txt') === 'hello wörld!', `chunks decode in order incl. UTF-8 (${JSON.stringify(s.getAssetSource('txt'))})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
