/**
 * webview-baseline.test — the surface must not need a WebView newer than minSdk guarantees.
 *
 * This was a block inside ux-audit, and ux-audit has ONE mutation-table entry covering "the page
 * rendered nothing". So its 22 rendered states were guarded and this gate — the entire host proof
 * for the webview-render acceptance item — was not. Split out so it earns its own entry.
 *
 * It has already been decoration once, which is the reason to be careful with it: the first
 * version printed its finding and still reported ALL PASS, because the findings landed after the
 * verdict array was built. A gate that reports without failing is not a gate.
 *
 * TWO CLAIMS, and the second is the one that matters. "www/ is clean" is satisfied by a scanner
 * that can never find anything — which is exactly what a broken comparison would produce. So a
 * POSITIVE CONTROL runs beside it: a fixture containing known-modern features must be flagged,
 * with the right feature names and the right versions. Same lesson as discover-live, where
 * "nothing open" was unfalsifiable until a stub proved the sweep could say DETECTED.
 *
 * Run: npm run webview-baseline
 */
import { scanWww, scanSource, chromeFloorFor, declaredMinSdk, WEBVIEW_FLOOR, MODERN_CSS,
         MODERN_JS } from './lib/webview-baseline.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const minSdk = declaredMinSdk();
const floor = chromeFloorFor(minSdk);
console.log(`minSdk ${minSdk} => WebView floor Chrome ${floor}\n`);

/* ---- the floor is derived, and derived correctly -------------------------------------------- */
ok('minSdkVersion was read from android/variables.gradle', Number.isInteger(minSdk) && minSdk > 0,
  String(minSdk));
ok('the floor is derived from minSdk, not hardcoded', floor === chromeFloorFor(minSdk)
  && chromeFloorFor(24) === 51 && chromeFloorFor(33) === 107 && chromeFloorFor(30) === 83,
  `24->${chromeFloorFor(24)} 30->${chromeFloorFor(30)} 33->${chromeFloorFor(33)}`);
ok('an unknown-future minSdk floors to the highest known entry',
  chromeFloorFor(99) === WEBVIEW_FLOOR[0][1], String(chromeFloorFor(99)));
ok('a minSdk below every entry falls back rather than throwing', chromeFloorFor(1) === 51,
  String(chromeFloorFor(1)));

/* ---- THE POSITIVE CONTROL: the scanner must be able to FIND things --------------------------
 * Without this, "0 findings" is indistinguishable from a scanner that matches nothing. */
{
  const css = `.a { color: color-mix(in srgb, red 50%, blue); }
               body:has(.x) .y { display: none; }
               @container (max-width: 96px) { .z { display: none; } }
               .w { container-type: inline-size; text-wrap: balance; }`;
  const hits = scanSource('fixture.html', css, 51);
  const names = hits.map((h) => h.feature).sort();
  ok('the CSS scanner flags known-modern features', hits.length >= 5, names.join(', '));
  for (const want of ['color-mix()', ':has()', '@container', 'container-type', 'text-wrap: balance']) {
    ok(`  flags ${want}`, names.includes(want), names.join(', '));
  }
  /* And the version attached must be the real one, since the floor comparison depends on it. */
  const cm = hits.find((h) => h.feature === 'color-mix()');
  ok('a finding carries the Chrome version it needs', cm && cm.chrome === 111,
    JSON.stringify(cm));
}
{
  const js = "const a = x ?? y; const b = obj?.prop; const c = {...src}; const d = arr.at(-1);\n"
           + "const e = structuredClone(o); const f = s.replaceAll('a','b');";
  const hits = scanSource('fixture.js', js, 51);
  const names = hits.map((h) => h.feature).sort();
  ok('the JS scanner flags known-modern features', hits.length >= 5, names.join(', '));
  for (const want of ['nullish coalescing (??)', 'optional chaining (?.)', 'object spread',
                      'Array.prototype.at()', 'structuredClone()']) {
    ok(`  flags ${want}`, names.includes(want), names.join(', '));
  }
}

/* ---- the floor must actually gate, in BOTH directions --------------------------------------- */
{
  const css = '.a { color: color-mix(in srgb, red 50%, blue); }';   // needs 111
  ok('a feature ABOVE the floor is flagged', scanSource('f.html', css, 107).length === 1);
  ok('a feature AT OR BELOW the floor is NOT flagged', scanSource('f.html', css, 111).length === 0,
    'flagging what the floor already supports trains people to ignore the gate');
}

/* ---- comments must not be scanned ------------------------------------------------------------
 * The prose in index.html names these features repeatedly while explaining why they were
 * removed. An early version matched inside a comment; so did the probe that produced the
 * measurements behind that removal, and it silently ate a CSS rule. */
{
  const commented = '/* we removed color-mix() and :has() because ... */\n.a { color: red; }';
  ok('features named only in a CSS comment are not flagged',
    scanSource('f.html', commented, 51).length === 0,
    JSON.stringify(scanSource('f.html', commented, 51)));
  const jsComment = "// we avoid ?? and obj?.prop here\nconst a = 1;";
  ok('features named only in a JS comment are not flagged',
    scanSource('f.js', jsComment, 51).length === 0,
    JSON.stringify(scanSource('f.js', jsComment, 51)));
  /* A regex containing a quote used to desync the JS scanner for the rest of the file. */
  const afterRegex = "const esc = /[&<>\"']/g; // ?? not real\nconst ok2 = 1;";
  ok('a regex containing a quote does not desync the JS scan',
    scanSource('f.js', afterRegex, 51).length === 0,
    JSON.stringify(scanSource('f.js', afterRegex, 51)));
}

/* ---- and finally: the shipped surface is clean ---------------------------------------------- */
const res = scanWww();
ok('scanned a meaningful number of shipped files', res.files.length >= 5,
  `${res.files.length}: ${res.files.join(', ')}`);
ok('no shipped www/ source needs a WebView newer than the floor', res.findings.length === 0,
  res.findings.map((f) => `${f.file} uses ${f.feature} (needs Chrome ${f.chrome}, floor `
    + `${res.floor})`).join('\n       ')
  + '\n       Remove it, raise minSdk, or establish support from the device\'s own report.');

console.log(`\n  ${res.files.length} files scanned, ${MODERN_CSS.length + MODERN_JS.length} `
  + `features checked, ${res.findings.length} finding(s)`);
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
