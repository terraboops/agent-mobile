/**
 * font-stack.test — which typeface the Pixel will actually render, decided here.
 *
 * This is the "font stack" clause of device-acceptance's webview-render item. It was carried as
 * device-only on the grounds that the WebView's fonts differ from desktop Chromium's. They do,
 * and no host can change that. What a host CAN do is make the difference deterministic and
 * bounded instead of unexamined, which is what these assertions are for.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontCustomProps, resolveOn, endsInGeneric, unknownFamilies, familiesOf }
  from './lib/font-stack.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const html = readFileSync(join(REPO, 'www/index.html'), 'utf8');
const stacks = fontCustomProps(html);
const PLATFORMS = ['apple', 'android', 'windows'];

console.log('\nfont-stack — what the surface asks for, and what each platform gives it\n');
for (const [n, s] of Object.entries(stacks)) console.log(`  ${n}: ${s}`);
console.log();

/* ---- the surface declares stacks at all ---------------------------------------------------- */
ok('the surface declares font stacks as custom properties',
  Object.keys(stacks).length >= 2, JSON.stringify(Object.keys(stacks)));
ok('both a sans and a mono stack are declared',
  !!stacks['--sans'] && !!stacks['--mono'], JSON.stringify(Object.keys(stacks)));

/* ---- every stack must end somewhere ---------------------------------------------------------
 * A list with no generic tail can resolve to NOTHING on a platform that has none of its named
 * families, and the engine then falls back to its default — which is a different answer on every
 * device and is the one outcome no test here could predict. */
for (const [name, stack] of Object.entries(stacks)) {
  ok(`${name}: ends in a generic family`, endsInGeneric(stack),
    `"${stack}" — without a generic tail the fallback is whatever the engine happens to default `
    + 'to, which differs per device and cannot be reasoned about from here');
  ok(`${name}: names no family this project does not know`,
    unknownFamilies(stack).length === 0,
    `unrecognised: ${unknownFamilies(stack).join(', ')} — add it to FAMILY_PLATFORMS with the `
    + 'platforms that actually ship it, or the resolution below is a guess');
}

/* ---- THE CLAIM: the same family name everywhere ---------------------------------------------
 * The rendered FACE still differs (SF Pro here, Roboto on the Pixel) and only a bundled font
 * could change that. What must not also differ is which entry in the list gets picked: two
 * platforms taking different branches is a second variable on top of the unavoidable one. */
for (const [name, stack] of Object.entries(stacks)) {
  const picks = PLATFORMS.map((p) => resolveOn(stack, p));
  ok(`${name}: resolves to the SAME family on every platform (${picks[0]})`,
    picks.every((p) => p !== null) && new Set(picks).size === 1,
    PLATFORMS.map((p, i) => `${p}=${picks[i]}`).join(' ')
    + ' — a platform-specific family ahead of the generic means the audit host and the handset '
    + 'take different branches of the same list');
}
ok('--sans resolves to system-ui, the platform UI face', resolveOn(stacks['--sans'], 'android') === 'system-ui');
ok('--mono resolves to ui-monospace', resolveOn(stacks['--mono'], 'android') === 'ui-monospace');

/* ---- and the indirection resolves too --------------------------------------------------------
 * --display is defined per theme as var(--sans) or var(--mono); a typo there yields an invalid
 * font shorthand, which drops the WHOLE declaration (size and line-height with it). */
const displays = [...html.matchAll(/--display\s*:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]);
ok('--display is defined for every theme that uses it', displays.length >= 3,
  `found ${displays.length} definitions: ${displays.join(', ')}`);
ok('every --display points at a stack that exists',
  displays.every((d) => !!stacks[d]),
  `dangling: ${displays.filter((d) => !stacks[d]).join(', ')} — var() with no definition makes `
  + 'the whole `font:` shorthand invalid, so size and line-height are dropped as well');
const usesDisplay = (html.match(/var\(--display\)/g) || []).length;
ok('--display is actually used, so the check above is not idle', usesDisplay > 0, `${usesDisplay} uses`);

/* ---- POSITIVE CONTROLS ---------------------------------------------------------------------
 * The assertions above pass on stacks that are already correct, so each one is run against a
 * stack that is definitely wrong. Without this the whole file could be measuring nothing. */
ok('control: a stack with no generic tail is REJECTED',
  !endsInGeneric('-apple-system, "SF Mono"'), 'the generic check does not fire');
ok('control: an Apple-only stack resolves to NOTHING on Android',
  resolveOn('-apple-system, "SF Mono", Menlo', 'android') === null,
  'the platform table thinks Android ships an Apple font');
ok('control: an Apple-first stack is caught diverging',
  resolveOn('-apple-system, system-ui, sans-serif', 'apple') !== resolveOn('-apple-system, system-ui, sans-serif', 'android'),
  'this is the exact stack this surface shipped until tonight, and it must read as divergent');
/* An UNKNOWN family reaching resolveOn. The `where &&` guard had nothing behind it: every test
 * resolved stacks made of families the table knows, so dropping the guard — which would throw on
 * `undefined.includes` — changed nothing. A stack naming a font nobody has listed is exactly the
 * case the guard is for. */
ok('an unknown family does not throw, it is skipped',
  resolveOn('Comic Sans MS, sans-serif', 'android') === 'sans-serif',
  'resolveOn would crash on a family the platform table does not list');
ok('a stack of ONLY unknown families resolves to nothing rather than throwing',
  resolveOn('Comic Sans MS, Wingdings', 'android') === null);

ok('control: an unknown family is reported',
  unknownFamilies('Comic Sans MS, sans-serif').join() === 'comic sans ms');
ok('control: quotes and case do not change the answer',
  familiesOf('"SF Mono" , MENLO').join() === 'sf mono,menlo');

/* ---- why the audit\'s pixel measurements still transfer --------------------------------------
 * The face differs, so advance widths differ by a few percent. ctrlbar-geometry proves clearance
 * across a font-scale RANGE, and if that range is wide enough the metric difference is inside
 * it. That is the actual argument for retiring this clause, so the range is asserted rather than
 * remembered. */
const geom = readFileSync(join(REPO, 'test/ctrlbar-geometry.test.mjs'), 'utf8');
const scales = [...geom.matchAll(/\b1\.(\d)\b/g)].map((m) => Number(`1.${m[1]}`));
const maxScale = scales.length ? Math.max(...scales) : 0;
ok('the geometry proof covers a font-scale range that dwarfs a metric-font swap',
  maxScale >= 1.3,
  `ctrlbar-geometry's widest font scale is ${maxScale || 'none found'} — a typeface swap moves `
  + 'advance widths by single-digit percent, so a proof that holds to 1.3x or more contains it. '
  + 'If this drops below 1.3 the webview-render argument in device-acceptance loses its basis');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
