/**
 * ctrlbar-geometry — issue #2: Stop and the native mic must not collide.
 *
 * The bottom bar is drawn by TWO layout engines that cannot see each other:
 *   - the NATIVE mic button, added to android.R.id.content by MainActivity.installMicButton()
 *   - the WEB Stop button, laid out by #ctrlbar in www/index.html
 * targetSdkVersion 36 forces edge-to-edge, so the native side spans the navigation bar and
 * only stays aligned if it adds the same inset the CSS gets from env(safe-area-inset-bottom).
 * That agreement is the thing this test pins down: it reads the real constants out of the Java
 * source, measures the real CSS box in a Pixel 7 viewport, and fails if they drift apart.
 *
 * All vertical numbers are dp measured UP FROM THE TOP OF THE NAVIGATION BAR, so the assertions
 * hold whether or not Capacitor insets the webview (either way Stop lands in the same band).
 *
 * Run: npm run ctrlbar-geometry
 */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = join(ROOT, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');

/* Pixel 7 gesture-nav inset. Tested at 0 too: a device with hardware keys reports 0 and the
 * pair must still line up, which is exactly what a hard-coded margin gets wrong. */
const INSETS = [0, 24];
const MIN_TAP = 48;   // Material minimum touch target
const VIEWPORT_W = 412;

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* --- the native side: read the contract, do not restate it ------------------------------- */
const java = readFileSync(JAVA, 'utf8');
const constOf = (name) => {
  const m = java.match(new RegExp(`static final int ${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!m) throw new Error(`MainActivity.java no longer declares ${name} — the geometry contract moved`);
  return Number(m[1]);
};
const MIC_SIZE = constOf('MIC_SIZE_DP');
const MIC_GAP = constOf('MIC_BOTTOM_GAP_DP');

console.log(`native mic: ${MIC_SIZE}dp square, ${MIC_GAP}dp above the nav bar`);

/* The margin must be built from the inset, not a bare dp(). Guard the regression directly: a
 * future edit that drops the listener silently reintroduces issue #2 on every gesture-nav phone. */
ok('native mic margin is inset-aware (setOnApplyWindowInsetsListener present)',
  /setOnApplyWindowInsetsListener/.test(java) &&
  /dp\(MIC_BOTTOM_GAP_DP\)\s*\+\s*navBottom/.test(java),
  'installMicButton must add the systemBars bottom inset to the margin');
ok('native mic reads the systemBars inset',
  /WindowInsetsCompat\.Type\.systemBars\(\)/.test(java));

const micRect = {            // dp, up from the top of the nav bar
  left: (VIEWPORT_W - MIC_SIZE) / 2,
  right: (VIEWPORT_W + MIC_SIZE) / 2,
  bottom: MIC_GAP,
  top: MIC_GAP + MIC_SIZE,
};
const micCenterY = MIC_GAP + MIC_SIZE / 2;

/* --- the web side: measure, do not assume ------------------------------------------------- */
const browser = await chromium.launch();

for (const inset of INSETS) {
  console.log(`\n--- safe-area-inset-bottom = ${inset}dp ---`);
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto('file://' + join(ROOT, 'www/index.html'));
  /* env() cannot be driven from script, so substitute the literal the device would supply.
   * The substitution mirrors the two calc()s under test; if either loses its env() term this
   * override stops matching and the alignment assertion below is what catches it. */
  const applied = await page.evaluate((i) => {
    const bar = getComputedStyle(document.querySelector('#ctrlbar')).paddingBottom;
    const body = getComputedStyle(document.body).paddingBottom;
    const s = document.createElement('style');
    s.textContent = `#ctrlbar{padding-bottom:${parseFloat(bar) + i}px!important}`
                  + `body{padding-bottom:${parseFloat(body) + i}px!important}`;
    document.head.appendChild(s);
    return { bar: parseFloat(bar), body: parseFloat(body) };
  }, inset);
  await page.waitForTimeout(150);

  const m = await page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom,
               display: getComputedStyle(e).display };
    };
    return { vh: innerHeight, vw: innerWidth, stop: r('#ctl-stop'), ring: r('#mic-ring'),
             bodyPad: parseFloat(getComputedStyle(document.body).paddingBottom) };
  });

  ok(`viewport is Pixel 7 width (${VIEWPORT_W})`, m.vw === VIEWPORT_W, `got ${m.vw}`);
  ok('web mic ring stays hidden (native is the single source of truth, issue #1)',
    m.ring && m.ring.display === 'none');

  /* Convert the CSS box into the shared frame: up from the top of the nav bar. When the inset
   * is applied inside the page, the page bottom IS the screen bottom, so subtract it back out. */
  const stop = {
    left: m.stop.x, right: m.stop.right,
    bottom: m.vh - m.stop.bottom - inset,
    top: m.vh - m.stop.y - inset,
  };
  const stopCenterY = (stop.bottom + stop.top) / 2;
  console.log(`  stop: x ${stop.left}->${stop.right}, y ${stop.bottom}->${stop.top} (centre ${stopCenterY})`);
  console.log(`  mic : x ${micRect.left}->${micRect.right}, y ${micRect.bottom}->${micRect.top} (centre ${micCenterY})`);

  /* Acceptance, straight from the issue: distinct, non-overlapping, own tap target. */
  const hGap = stop.left - micRect.right;
  ok('mic and Stop do not overlap horizontally', hGap > 0, `gap ${hGap}dp`);
  ok('mic and Stop are separated by at least 8dp', hGap >= 8, `gap ${hGap}dp`);

  const vOverlap = Math.min(stop.top, micRect.top) - Math.max(stop.bottom, micRect.bottom);
  ok('mic and Stop share the same band (they read as one row)', vOverlap > 0,
    `vertical overlap ${vOverlap}dp`);
  ok('mic and Stop are centred on each other (within 1dp)',
    Math.abs(stopCenterY - micCenterY) <= 1,
    `stop centre ${stopCenterY} vs mic centre ${micCenterY}`);

  /* The bug this fix exists for: nothing may reach into the system gesture strip. */
  ok('native mic clears the navigation bar entirely', micRect.bottom > 0,
    `mic bottom ${micRect.bottom}dp above nav bar`);
  ok('Stop clears the navigation bar entirely', stop.bottom > 0,
    `stop bottom ${stop.bottom}dp above nav bar`);

  ok(`Stop tap target is at least ${MIN_TAP}dp tall`, m.stop.h >= MIN_TAP, `${m.stop.h}dp`);
  ok(`mic tap target is at least ${MIN_TAP}dp`, MIC_SIZE >= MIN_TAP, `${MIC_SIZE}dp`);

  /* Scrolled content must end above the TALLER of the two controls — the native one, which CSS
   * cannot measure. This is the assertion that catches a mic resize made without touching CSS. */
  const reserve = m.bodyPad - inset;
  ok('body reserve clears the native mic, not just #ctrlbar', reserve >= micRect.top,
    `reserve ${reserve}dp vs mic top ${micRect.top}dp`);

  await ctx.close();
}

/* --- the horizontal invariant, across widths AND Android font scales -------------------- *
 * The mic is CENTRED and Stop is right-aligned and grows with the system font scale, so the
 * clearance between them shrinks on narrow screens. Before #ctrlbar reserved the mic's band,
 * 320dp at scale 1.6 overlapped by 9.5dp — and the people who set a large font are exactly the
 * ones who can least afford a mis-tap between Stop and the mic. 412dp alone never showed it. */
const WIDTHS = [320, 360, 393, 412, 480];   // 320 covers split-screen / small phones
const SCALES = [1, 1.3, 1.6, 2.0];          // Android font size, default .. largest
const MIN_GAP = 8;

console.log('\n--- horizontal clearance across widths x font scales ---');
for (const w of WIDTHS) {
  for (const scale of SCALES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 },
      deviceScaleFactor: 2, isMobile: true });
    const page = await ctx.newPage();
    await page.goto('file://' + join(ROOT, 'www/index.html'));
    await page.evaluate((s) => {
      document.documentElement.style.fontSize = (16 * s) + 'px';
      document.querySelector('#ctl-stop').style.fontSize = (14 * s) + 'px';
    }, scale);
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      const e = document.querySelector('#ctl-stop');
      const b = e.getBoundingClientRect();
      const lbl = document.querySelector('#ctl-stop .lbl');
      return { x: b.x, w: b.width, h: b.height,
               labelShown: !!lbl && getComputedStyle(lbl).display !== 'none',
               name: e.getAttribute('aria-label') || e.getAttribute('title') || '' };
    });
    const gap = r.x - (w + MIC_SIZE) / 2;
    const tag = `${w}dp @ font x${scale}`;
    ok(`${tag}: Stop clears the mic by >= ${MIN_GAP}dp`, gap >= MIN_GAP, `gap ${gap.toFixed(1)}dp`);
    ok(`${tag}: Stop keeps a ${MIN_TAP}dp tap target`, r.w >= MIN_TAP && r.h >= MIN_TAP,
      `${r.w.toFixed(1)}x${r.h.toFixed(1)}`);
    /* When the label is dropped for space the control must still announce itself. */
    ok(`${tag}: Stop is still named when the label is hidden`,
      r.labelShown || /stop/i.test(r.name), `label=${r.labelShown} name="${r.name}"`);
    await ctx.close();
  }
}

await browser.close();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
console.log('ALL PASS');
