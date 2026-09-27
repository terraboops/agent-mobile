/**
 * ctrlbar-shot — see the bottom bar the way the Pixel actually composites it.
 *
 * The mic is a native ImageView drawn OVER the webview, so every screenshot the UX audit takes
 * is missing it: CSS cannot see it, Playwright cannot render it, and the checker therefore
 * cannot judge the one piece of layout that issue #2 is about. This draws the native button's
 * real rect — size and margin read out of MainActivity.java, plus the window inset — on top of
 * the real page, so the composite bar can be looked at.
 *
 * This is a SIMULATION of the native overlay, not on-device proof. It renders the geometry the
 * Java constants specify; it cannot tell you libwebrtc works or that the tint is right. Its
 * purpose is to make a layout collision visible to a human before the APK goes on a phone.
 *
 * Run: npm run ctrlbar-shot   ->  test/audit/out/ctrlbar-<inset>.png
 */
import { chromium, devices } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = join(ROOT, 'test/audit/out');
const JAVA = join(ROOT, 'android/app/src/main/java/com/agentmobile/agent/MainActivity.java');
mkdirSync(OUTDIR, { recursive: true });

const java = readFileSync(JAVA, 'utf8');
const constOf = (n) => {
  const m = java.match(new RegExp(`static final int ${n}\\s*=\\s*(\\d+)\\s*;`));
  if (!m) throw new Error(`MainActivity.java no longer declares ${n}`);
  return Number(m[1]);
};
const MIC_SIZE = constOf('MIC_SIZE_DP');
const MIC_GAP = constOf('MIC_BOTTOM_GAP_DP');

/* Tints straight out of renderMic(): filled cyan = live, hollow slate = muted. */
const LIVE = '#22D3EE', MUTED = '#8B98A9';

const browser = await chromium.launch();

for (const inset of [0, 24]) {
  for (const micOn of [true, false]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    await page.goto('file://' + join(ROOT, 'www/index.html'));

    await page.evaluate(({ inset, micOn, MIC_SIZE, MIC_GAP, LIVE, MUTED }) => {
      /* env() cannot be driven from script — substitute the literal the device supplies. */
      const bar = parseFloat(getComputedStyle(document.querySelector('#ctrlbar')).paddingBottom);
      const body = parseFloat(getComputedStyle(document.body).paddingBottom);
      const s = document.createElement('style');
      s.textContent = `#ctrlbar{padding-bottom:${bar + inset}px!important}`
                    + `body{padding-bottom:${body + inset}px!important}`;
      document.head.appendChild(s);

      /* The navigation bar: not ours to draw, but the mic must clear it, so show it. */
      if (inset) {
        const nav = document.createElement('div');
        nav.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${inset}px;z-index:99;`
          + `background:rgba(0,0,0,.55);border-top:1px dashed rgba(255,255,255,.28);`;
        const pill = document.createElement('div');
        pill.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);`
          + `width:108px;height:4px;border-radius:2px;background:rgba(255,255,255,.55)`;
        nav.appendChild(pill);
        document.body.appendChild(nav);
      }

      /* The NATIVE mic button, at the rect MainActivity will place it:
       * bottomMargin = MIC_BOTTOM_GAP_DP + systemBars().bottom, gravity BOTTOM|CENTER_H. */
      const mic = document.createElement('div');
      mic.id = '__native_mic_sim';
      mic.style.cssText = `position:fixed;z-index:100;left:50%;transform:translateX(-50%);`
        + `bottom:${MIC_GAP + inset}px;width:${MIC_SIZE}px;height:${MIC_SIZE}px;border-radius:50%;`
        + `border:2px solid ${micOn ? LIVE : MUTED};`
        + `background:${micOn ? 'rgba(34,211,238,.18)' : 'transparent'};`
        + `box-shadow:${micOn ? '0 0 22px rgba(34,211,238,.45)' : 'none'};`
        + `display:flex;align-items:center;justify-content:center;`
        + `color:${micOn ? LIVE : MUTED};font:10px/1 monospace;letter-spacing:.08em;`;
      mic.textContent = 'NATIVE';
      document.body.appendChild(mic);
    }, { inset, micOn, MIC_SIZE, MIC_GAP, LIVE, MUTED });

    await page.waitForTimeout(400);
    const name = `ctrlbar-inset${inset}-mic${micOn ? 'on' : 'off'}.png`;
    /* Crop to the bar: a full-page shot buries the thing under test. */
    await page.screenshot({ path: join(OUTDIR, name),
      clip: { x: 0, y: 839 - 170, width: 412, height: 170 } });
    console.log(`  ${name}  (mic ${MIC_SIZE}dp @ ${MIC_GAP}+${inset} above screen bottom)`);
    await ctx.close();
  }
}

await browser.close();
console.log(`\nSIMULATED native overlay from MainActivity constants — not on-device proof.`);
console.log(`-> ${OUTDIR}`);
