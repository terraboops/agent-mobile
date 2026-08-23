// surface-assets.test.mjs — storage-cap accounting (L4): replacing an asset or unregistering
// one (complete or abandoned append) returns its bytes; usage can no longer only grow.
import { createSurface } from '../www/surface-core.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const b64 = (n) => Buffer.alloc(n, 0x41).toString('base64');
const s = createSurface({ capacity: 1000 });
s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(300) });
ok(s.state.usage === 300, 'usage counts the asset (300)');
s.apply({ op: 'register_asset', name: 'a', mime: 'text/javascript', b64: b64(400) });
ok(s.state.usage === 400, 'replacing an asset frees the old bytes first (400, not 700)');
s.apply({ op: 'register_asset', name: 'big', mime: 'text/javascript', b64: b64(300), append: true });
ok(s.state.usage === 700, 'an in-flight append counts');
const ev = s.apply({ op: 'unregister_asset', name: 'big' });
ok(s.state.usage === 400 && ev.some((e) => e.event === 'asset_removed' && e.freed === 300), 'abandoned append can be unregistered (bytes returned)');
s.apply({ op: 'unregister_asset', name: 'a' });
ok(s.state.usage === 0 && !s.state.assets.includes('a'), 'unregister_asset removes a complete asset and frees its bytes');
const full = s.apply({ op: 'register_asset', name: 'x', mime: 'text/javascript', b64: b64(1200) });
ok(full.some((e) => e.event === 'render_result' && e.ok === false), 'cap still enforced');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
