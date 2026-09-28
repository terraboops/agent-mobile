/**
 * webview-baseline — does the surface use anything the target WebView might not have?
 *
 * WHY IT LIVES HERE RATHER THAN INSIDE ux-audit. This scan was one block of ux-audit, and
 * ux-audit has a single mutation-table entry: "noticing that the page rendered nothing". So the
 * 22 rendered states were covered and this gate — the whole host proof for the webview-render
 * acceptance item — was not. I red-proofed it twice by hand, but a manual red-proof is a memory,
 * not a guard, and this exact gate has already been decoration once: it printed a finding and
 * still reported ALL PASS, because the findings landed after the verdict array was built.
 *
 * A module with its own suite gets its own mutation entry. That is the only reason to split it.
 *
 * THE FLOOR IS DERIVED, NOT ASSERTED. The first version hardcoded "minSdk 24, Android 7, WebView
 * Chrome 51" and that premise turned out to be false — Android lint had never run, the Java was
 * already calling API 33, and minSdk is now 33. Deriving the floor from minSdkVersion means this
 * can never again be left arguing from a version nobody ships.
 *
 * WebView is updatable and only moves FORWARD, so the version in a release's system image is the
 * floor a device on that release can have.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './code-only.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** [minSdk, Chrome version in that release's system WebView] */
export const WEBVIEW_FLOOR = [
  [34, 115], [33, 107], [32, 96], [31, 93], [30, 83], [29, 74], [28, 66], [26, 58], [24, 51],
];

export function chromeFloorFor(minSdk) {
  for (const [api, chrome] of WEBVIEW_FLOOR) if (minSdk >= api) return chrome;
  return 51;
}

export function declaredMinSdk() {
  try {
    const g = readFileSync(join(REPO, 'android', 'variables.gradle'), 'utf8');
    const m = /minSdkVersion\s*=\s*(\d+)/.exec(g);
    return m ? Number(m[1]) : 24;
  } catch { return 24; }
}

export const MODERN_CSS = [
  { re: /@container[\s(]/, name: '@container', chrome: 105 },
  { re: /container-type\s*:/, name: 'container-type', chrome: 105 },
  { re: /:has\(/, name: ':has()', chrome: 105 },
  { re: /@layer[\s{]/, name: '@layer', chrome: 99 },
  { re: /\bcolor-mix\s*\(/, name: 'color-mix()', chrome: 111 },
  { re: /@scope[\s{]/, name: '@scope', chrome: 118 },
  { re: /\btext-wrap\s*:\s*balance/, name: 'text-wrap: balance', chrome: 114 },
  { re: /\bfield-sizing\s*:/, name: 'field-sizing', chrome: 123 },
];

export const MODERN_JS = [
  { re: /\?\?/, name: 'nullish coalescing (??)', chrome: 80 },
  /* `?.` glued to what follows. An earlier pattern used a negative lookbehind for a word char,
   * meaning to exclude ternaries — and it excluded `foo?.bar`, the commonest form there is, so
   * the gate silently passed a file salted with optional chaining. A ternary writes `a ? .5 : b`
   * WITH a space, so the absence of one is the real distinguisher. */
  { re: /\?\.(?=[A-Za-z_$[(])/, name: 'optional chaining (?.)', chrome: 80 },
  { re: /\bstructuredClone\s*\(/, name: 'structuredClone()', chrome: 98 },
  { re: /\.at\s*\(\s*-?\d/, name: 'Array.prototype.at()', chrome: 92 },
  { re: /\bObject\.hasOwn\s*\(/, name: 'Object.hasOwn()', chrome: 93 },
  { re: /\.replaceAll\s*\(/, name: 'String.replaceAll()', chrome: 85 },
  { re: /\bqueueMicrotask\s*\(/, name: 'queueMicrotask()', chrome: 71 },
  { re: /\bglobalThis\b/, name: 'globalThis', chrome: 71 },
  { re: /\{\s*\.\.\.[\w$]/, name: 'object spread', chrome: 60 },
];

/**
 * Scan one file's SOURCE for features above a floor.
 *
 * JS goes through codeOnly, which understands strings AND regex literals — an earlier version of
 * that scanner read the apostrophe inside `/[&<>"']/` as a string start and desynced for the rest
 * of the file. CSS/HTML use a plain comment strip, which is enough and avoids treating CSS as
 * JavaScript. Comments must go first either way: the prose explaining this gate names the very
 * features it looks for.
 */
export function scanSource(name, raw, floor) {
  const isJs = /\.js$/.test(name);
  const code = isJs
    ? codeOnly(raw, 'js')
    : raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const checks = isJs ? MODERN_JS : MODERN_CSS;
  const found = [];
  for (const { re, name: feat, chrome } of checks) {
    /* Only ABOVE the floor. Flagging what the floor already supports trains people to ignore
     * the gate, which is worse than not having one. */
    if (chrome > floor && re.test(code)) found.push({ file: name, feature: feat, chrome });
  }
  return found;
}

/** Scan every shipped www/ source. Returns {minSdk, floor, files, findings}. */
export function scanWww({ dir = join(REPO, 'www'), floor = null } = {}) {
  const minSdk = declaredMinSdk();
  const f = floor === null ? chromeFloorFor(minSdk) : floor;
  const files = readdirSync(dir).filter((x) => /\.(html|css|js)$/.test(x));
  const findings = [];
  for (const name of files) findings.push(...scanSource(name, readFileSync(join(dir, name), 'utf8'), f));
  return { minSdk, floor: f, files, findings };
}
