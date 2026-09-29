/**
 * font-stack — which typeface the surface will actually get, per platform.
 *
 * WHY THIS EXISTS. device-acceptance's `webview-render` item says the host cannot settle
 * rendering because the WebView differs from desktop Chromium in "version, font stack, inset
 * behaviour". Version was settled by webview-baseline (nothing newer than the minSdk floor is
 * used) and insets by ctrlbar-geometry. The font clause was never examined, and it turns out to
 * be sharper than the sentence suggests:
 *
 *     --sans: -apple-system, system-ui, "Segoe UI", sans-serif;
 *
 * On the machine ux-audit measures on, that resolves to `-apple-system` — SF Pro. On the Pixel
 * it resolves to `system-ui` — Roboto. So the audit is not measuring the same typeface the
 * device renders, and SF Pro and Roboto differ in advance width and x-height. Every geometry
 * and legibility number ux-audit produces is taken in a font the handset will never use.
 *
 * That does NOT make the numbers worthless, and this module exists to say why precisely rather
 * than leaving it as a shrug: the resolution on each platform is deterministic and computable
 * from the stack, and the geometry claims were proven across a 1.0-1.6x font-scale range, which
 * is an order of magnitude more variation than a metric-font swap introduces. What must hold is
 * that every stack ENDS in a generic, that the Android resolution is a real family rather than
 * a fallthrough nobody predicted, and that no rule depends on a family Android does not ship.
 */

/** Where each named family actually exists. Generic families exist everywhere by definition. */
export const FAMILY_PLATFORMS = {
  '-apple-system': ['apple'],
  'blinkmacsystemfont': ['apple'],
  'sf mono': ['apple'],
  'sf pro': ['apple'],
  'menlo': ['apple'],
  'monaco': ['apple'],
  'helvetica neue': ['apple'],
  'segoe ui': ['windows'],
  'consolas': ['windows'],
  'calibri': ['windows'],
  'roboto': ['android'],
  'roboto mono': ['android'],
  'noto sans': ['android'],
  'droid sans': ['android'],
  'droid sans mono': ['android'],
  /* CSS generics and system keywords: honoured by every engine this ships to. */
  'system-ui': ['apple', 'windows', 'android', 'generic'],
  'ui-monospace': ['apple', 'windows', 'android', 'generic'],
  'ui-sans-serif': ['apple', 'windows', 'android', 'generic'],
  'sans-serif': ['apple', 'windows', 'android', 'generic'],
  'serif': ['apple', 'windows', 'android', 'generic'],
  'monospace': ['apple', 'windows', 'android', 'generic'],
  'cursive': ['apple', 'windows', 'android', 'generic'],
};

export const GENERICS = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
                                 'system-ui', 'ui-monospace', 'ui-sans-serif', 'ui-serif']);

/** Split a CSS font list into normalised family names. */
export function familiesOf(stack) {
  return String(stack || '')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean);
}

/** Does this list end in a generic, so the browser always has something to fall back to? */
export function endsInGeneric(stack) {
  const f = familiesOf(stack);
  return f.length > 0 && GENERICS.has(f[f.length - 1]);
}

/**
 * The first family in the list that the given platform actually has.
 * @returns {string|null} null when nothing in the list exists there — a stack with no generic.
 */
export function resolveOn(stack, platform) {
  for (const f of familiesOf(stack)) {
    const where = FAMILY_PLATFORMS[f];
    if (where && where.includes(platform)) return f;
  }
  return null;
}

/** Families in the list that exist on NO platform this ships to — dead entries. */
export function unknownFamilies(stack) {
  return familiesOf(stack).filter((f) => !FAMILY_PLATFORMS[f]);
}

/**
 * Custom properties in a stylesheet whose value is a font list.
 * Returns {name: stack}. A value is treated as a font list when it names a generic.
 */
export function fontCustomProps(css) {
  const out = {};
  for (const m of String(css || '').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const [, name, value] = m;
    if (!familiesOf(value).some((f) => GENERICS.has(f))) continue;
    out[name] = value.trim();
  }
  return out;
}
