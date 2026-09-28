// ux-audit.mjs — drives the real app at a Pixel 7 viewport and runs objective
// UI/UX + accessibility checks in-page. Emits JSON findings + screenshots.
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'test', 'audit', 'out'); mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css' };
const server = createServer((req,res)=>{ const p=join(ROOT,'www',decodeURIComponent(req.url.split('?')[0]));
  if(!existsSync(p)||!p.startsWith(join(ROOT,'www'))){res.statusCode=404;return res.end();}
  res.setHeader('content-type',MIME[extname(p)]||'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], reducedMotion: 'no-preference' });
const page = await ctx.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{ if(m.type()==='error') errors.push('console: '+m.text()); });
await page.goto(`${base}/index.html`); await page.waitForTimeout(400);

/* Captured while the page is still open — the baseline gate below runs after the browser has
 * been closed, and reading it there threw "Target page, context or browser has been closed". */
const AUDIT_BROWSER = {
  supportsContainer: await page.evaluate(() => CSS.supports('container-type: inline-size')),
  ua: await page.evaluate(() => navigator.userAgent),
};

// ---- in-page objective checks --------------------------------------------
const AUDIT = () => {
  const out = { issues: [], stats: {} };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width>0 && r.height>0 && cs.visibility!=='hidden' && cs.display!=='none' && cs.opacity!=='0'; };
  // 1. touch targets (WCAG 2.5.8 / Material: >=44-48px)
  const tappable = [...document.querySelectorAll('button,[role=button],a,[onclick],[tabindex]')].filter(vis);
  tappable.forEach(el=>{ const r=el.getBoundingClientRect();
    if (r.width<44||r.height<44) out.issues.push({sev:'high',cat:'touch-target',
      el: el.id?('#'+el.id):el.tagName.toLowerCase(), msg:`tap target ${Math.round(r.width)}x${Math.round(r.height)}px < 44px min`}); });
  // 2. accessible names on interactive controls
  tappable.forEach(el=>{ const name=(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim();
    if(!name) out.issues.push({sev:'high',cat:'a11y-name',el: el.id?('#'+el.id):el.tagName.toLowerCase(), msg:'interactive element has no accessible name'}); });
  // 3. tiny text (<12px is hard to read on mobile)
  // Decorative nodes (aria-hidden, or font-size:0 dots whose text is never painted)
  // are not text and must not be measured as text.
  const decorative=(el)=>el.closest('[aria-hidden="true"]')||parseFloat(getComputedStyle(el).fontSize)===0;
  const textEls=[...document.querySelectorAll('body *')].filter(el=>vis(el)&&!decorative(el)&&el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
  const tiny=new Set(); textEls.forEach(el=>{ const fs=parseFloat(getComputedStyle(el).fontSize); if(fs<12) tiny.add(`${el.id?'#'+el.id:el.tagName.toLowerCase()} ${fs}px`); });
  tiny.forEach(t=>out.issues.push({sev:'med',cat:'legibility',el:t.split(' ')[0],msg:`text ${t.split(' ')[1]} < 12px`}));
  // 4. contrast of text vs effective background (approx: walks up for a solid bg)
  const lum=(c)=>{const m=c.match(/\d+(\.\d+)?/g)||[0,0,0];const [r,g,b]=m.slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
  // Effective background: alpha-composite every translucent layer up the tree
  // (source-over) until an opaque one, falling back to the body colour.
  const parse=(c)=>{ const m=(c||'').match(/[\d.]+/g); if(!m) return [0,0,0,0]; const [r,g,b]=m.slice(0,3).map(Number); const a=m.length>3?Number(m[3]):1; return [r,g,b,a]; };
  const bgOf=(el)=>{ let e=el; const layers=[]; while(e){ const [r,g,b,a]=parse(getComputedStyle(e).backgroundColor); if(a>0){ layers.push([r,g,b,a]); if(a>=1) break; } e=e.parentElement; }
    let out=[0,0,0]; for(const [r,g,b,a] of layers.reverse()) out=[0,1,2].map(i=>[r,g,b][i]*a+out[i]*(1-a)); return `rgb(${out.map(Math.round).join(', ')})`; };
  const seen=new Set();
  textEls.slice(0,120).forEach(el=>{ const cs=getComputedStyle(el); const fg=cs.color; const bg=bgOf(el);
    const l1=lum(fg),l2=lum(bg); const ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05); const fs=parseFloat(cs.fontSize); const bold=parseInt(cs.fontWeight)>=700;
    const large = fs>=24||(fs>=18.66&&bold); const min= large?3:4.5; const key=(el.id||el.className||el.tagName)+'|'+fg;
    if(ratio<min && !seen.has(key)){ seen.add(key); out.issues.push({sev:ratio<3?'high':'med',cat:'contrast',el: el.id?('#'+el.id):el.tagName.toLowerCase()+(el.className?'.'+String(el.className).split(' ')[0]:''), msg:`contrast ${ratio.toFixed(2)}:1 < ${min}:1 (${fg} on ${bg})`}); } });
  // 5. reduced-motion respected?
  const css=[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch(e){return []}}).join('\n');
  out.stats.animations=(css.match(/@keyframes/g)||[]).length;
  out.stats.reducedMotionRule=/prefers-reduced-motion/.test(css);
  if(out.stats.animations>0 && !out.stats.reducedMotionRule) out.issues.push({sev:'med',cat:'motion',el:'stylesheet',msg:`${out.stats.animations} @keyframes but no prefers-reduced-motion rule`});
  // 6. focus visibility
  out.stats.focusVisibleRule=/:focus-visible|:focus\b/.test(css);
  if(!out.stats.focusVisibleRule) out.issues.push({sev:'med',cat:'a11y-focus',el:'stylesheet',msg:'no :focus-visible / :focus styling — keyboard/switch users cannot see focus'});
  // 7. landmarks / semantics
  out.stats.landmarks={main:!!document.querySelector('main'),header:!!document.querySelector('header'),h1:document.querySelectorAll('h1').length};
  if(!document.querySelector('[role=status],[aria-live]')) out.issues.push({sev:'med',cat:'a11y-live',el:'#status',msg:'live status strip (heard/working) has no aria-live region — screen readers get no updates'});
  // 7b. horizontal overflow — the body must never scroll sideways
  if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1) out.issues.push({sev:'high',cat:'overflow',el:'html',msg:`horizontal overflow ${document.documentElement.scrollWidth}px > ${document.documentElement.clientWidth}px viewport`});
  // 7c. clipped text — visible text nodes whose box is cut off by an overflow:hidden ancestor
  textEls.slice(0,200).forEach(el=>{ let a=el.parentElement; while(a&&a!==document.body){ const cs=getComputedStyle(a); if(/hidden|clip/.test(cs.overflow+cs.overflowX+cs.overflowY)){ const r=el.getBoundingClientRect(), ar=a.getBoundingClientRect(); if(r.right>ar.right+1||r.bottom>ar.bottom+1) out.issues.push({sev:'med',cat:'clipped',el: el.id?('#'+el.id):el.tagName.toLowerCase()+(el.className?'.'+String(el.className).split(' ')[0]:''), msg:`text clipped by ${a.id?'#'+a.id:a.tagName.toLowerCase()}`}); break; } a=a.parentElement; } });
  // 8. lang + viewport
  if(!document.documentElement.lang) out.issues.push({sev:'low',cat:'a11y',el:'html',msg:'missing lang attribute'});
  const vp=document.querySelector('meta[name=viewport]')?.content||''; if(/user-scalable=no|maximum-scale=1/.test(vp)) out.issues.push({sev:'high',cat:'a11y',el:'meta viewport',msg:'pinch-zoom disabled'});
  // 9. horizontal overflow
  if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1) out.issues.push({sev:'high',cat:'layout',el:'body',msg:`horizontal overflow ${document.documentElement.scrollWidth}>${document.documentElement.clientWidth}`});
  // ---- did anything actually RENDER? -------------------------------------------------------
  // Every check above hunts for elements WITH a problem, so a page showing nothing at all has
  // no problems and scores a perfect sheet. Verified: setting the whole UI to
  // visibility:hidden produced "21 states, 0 issues, exit 0" — a completely invisible app
  // passing an audit whose entire purpose is to look at it. A blank render is the most severe
  // UI defect there is and it was the one state that could not be reported.
  const visibleEls = [...document.querySelectorAll('body *')].filter(vis);
  const visibleText = visibleEls
    .map((el) => (el.children.length === 0 ? (el.textContent || '') : ''))
    .join(' ').replace(/\s+/g, ' ').trim();
  out.stats.visibleEls = visibleEls.length;
  out.stats.visibleTextLen = visibleText.length;
  // Thresholds measured, not guessed. Across all 21 real states the minimum visible text is 6
  // chars (the sparse idle/landscape screens); an all-hidden page gives 0. Element COUNT does
  // not separate them — hiding the UI still leaves the background canvas visible, so the blank
  // page reaches 10 elements against the sparsest real state's 11. Text is the clean signal.
  if (visibleText.length < 4) {
    out.issues.push({ sev: 'high', cat: 'blank-render', el: 'body',
      msg: `${visibleEls.length} visible element(s) and ${visibleText.length} chars of visible `
         + `text — the page rendered nothing readable` });
  }
  return out;
};

const results = {};
async function snap(name, prep, arg){
  if(prep) await page.evaluate(prep, arg); await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, name+'.png') });
  results[name] = await page.evaluate(AUDIT);
}
// STATES
await snap('01-boot-matrix', null);
await snap('02-idle-matrix', () => { document.getElementById('boot').style.display='none'; document.getElementById('hb').classList.add('pulse'); });
const SAMPLE = () => {
  // Drive the REAL renderer path (what the sidecar sends), not a hand-mount —
  // otherwise the audit measures its own scaffolding instead of the app.
  const o={chart:{type:'area',height:220},series:[{name:'Temp',data:[9,8,7,6,5,4,4,5,7,10,13,15,16]}],xaxis:{categories:['00','02','04','06','08','10','12','14','16','18','20','22','24']}};
  const ui={title:'Nelson · next 24h',components:[{t:'chart',options:o},
    {t:'list',items:[{title:'Now',subtitle:'14°C'},{title:'Low',subtitle:'6°C'}]}]};
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui});}catch(_){}});
};
await snap('03-content-chart-matrix', SAMPLE);
await snap('04-working-matrix', () => { document.getElementById('work').classList.add('show'); });
await snap('05-idle-lcars', () => { document.getElementById('work').classList.remove('show'); (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui:{}});}catch(_){}}); location.hash=''; document.body.dataset.theme='lcars'; document.getElementById('ui').innerHTML=document.querySelector('#ui').innerHTML; });
await page.reload(); await page.waitForTimeout(400);
await snap('06-idle-hud', () => { document.getElementById('boot').style.display='none'; document.body.dataset.theme='hud'; });
await snap('07-idle-lcars', () => { document.body.dataset.theme='lcars'; });
// Per-theme CONTENT chrome (not just the header)
await snap('08-content-hud', () => { document.body.dataset.theme='hud'; });
await page.evaluate(SAMPLE); await snap('08-content-hud', null);
await snap('09-content-lcars', () => { document.body.dataset.theme='lcars'; });
// Landscape (Pixel 7 rotated): the pinned chrome must not eat the content
await page.setViewportSize({ width: 915, height: 412 });
await snap('10-landscape-content', () => { document.body.dataset.theme='matrix'; });
await snap('11-landscape-idle', () => { (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui:{}});}catch(_){}}); });
await page.setViewportSize({ width: 412, height: 915 });
// System font scaling: Android WebView applies the OS text zoom to every px
// font size. Emulate the accessibility 'largest' step (x1.6) on all text.
// Collect every computed size FIRST, then apply — writing inline sizes while
// walking the tree compounds through inheritance (a child of an inflated parent
// is inflated twice). Charts are re-rendered AFTER scaling so ApexCharts measures
// the scaled labels, as the WebView would.
const SCALE = () => { const m=[...document.querySelectorAll('body *')].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]); m.forEach(([el,fs])=>{ if(fs>0) el.style.fontSize=(fs*1.6)+'px'; }); };
await snap('12-fontscale-160', () => { document.body.dataset.theme='matrix'; });
await page.evaluate(SCALE); await snap('12-fontscale-160', null);
// Fresh page: scaling twice compounds through inheritance.
await page.reload(); await page.waitForTimeout(400);
await page.evaluate(() => { document.getElementById('boot').style.display='none'; document.body.dataset.theme='matrix'; });
await page.evaluate(SAMPLE); await page.waitForTimeout(250); await page.evaluate(SCALE); await page.evaluate(()=>window.dispatchEvent(new Event('resize'))); await snap('13-fontscale-160-content', null);

// Component states the earlier runs never touched: text/title/image/svg, and
// the live status strip (heard, working, mic level, agent speaking).
await page.setViewportSize({ width: 412, height: 915 });
await page.reload(); await page.waitForTimeout(400);
await page.evaluate(() => { document.getElementById('boot').style.display='none'; document.body.dataset.theme='matrix'; });
const COMPONENTS = () => {
  // 1x1 PNG pixel scaled up: a real <img> path through img-src data:
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect x="4" y="4" width="192" height="52" rx="6" fill="none" stroke="currentColor"/><polyline points="10,45 40,30 70,38 100,15 130,25 160,10 190,20" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const ui={title:'Golden retriever',components:[
    {t:'image',src:png,alt:'A golden retriever lying on a lawn (example image)'},
    {t:'text',text:'Retrievers were bred in the Scottish Highlands in the 1860s to recover waterfowl. Adults weigh 25–34 kg and live 10–12 years.'},
    {t:'svg',svg},
    {t:'list',items:[{title:'Weight',subtitle:'25–34 kg'},{title:'Lifespan',subtitle:'10–12 y'},{title:'Coat',subtitle:'double, water-repellent'}]}]};
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui});}catch(_){}});
};
await snap('14-components-matrix', COMPONENTS);
await snap('15-components-lcars', () => { document.body.dataset.theme='lcars'; });
await snap('16-status-live', () => { document.body.dataset.theme='matrix';
  const st={type:'status',hb:true,heard:'chart the weather in Nelson for the next twenty four hours please',level:.62,working:true,speaking:true};
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn(st);}catch(_){}}); });
for (const t of ['hud','lcars']) await snap(`17-status-${t}`, (t) => { document.body.dataset.theme=t; }, t);

// Live widget tiles (surface ops): the shipped example widgets, in two themes —
// proves the token hand-off into sandboxed frames and the content-sized frame.
await page.reload(); await page.waitForTimeout(400);
const WIDGETS = { clock: readFileSync(join(ROOT,'widgets','clock-widget.js'),'utf8'), weather: readFileSync(join(ROOT,'widgets','weather-tile.js'),'utf8') };
await snap('18-widgets-matrix', (W) => {
  document.getElementById('boot').style.display='none'; document.body.dataset.theme='matrix';
  const ops=[{op:'register_widget_type',name:'clock',code:W.clock},{op:'register_widget_type',name:'weather',code:W.weather},
    {op:'add_widget',key:'c',type:'clock',props:{text:'14:32'}},
    {op:'add_widget',key:'w',type:'weather',props:{title:'Castlegar'}},
    {op:'publish',key:'w',data:{now:9,min:2,max:12,cond:'clear',hourly:[{h:'00',t:9},{h:'02',t:8},{h:'04',t:7},null,{h:'08',t:6},{h:'10',t:10}]}}];
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'surface',ops});}catch(_){}});
}, WIDGETS);
await page.waitForTimeout(500); await snap('18-widgets-matrix', null);
await snap('19-widgets-lcars', () => { document.body.dataset.theme='lcars'; });

// Error surfaces: the agent's mistakes must be VISIBLE, themed, and readable.
await page.reload(); await page.waitForTimeout(400);
await snap('20-errors-matrix', () => {
  document.getElementById('boot').style.display='none'; document.body.dataset.theme='matrix';
  const ui={title:'When the agent gets it wrong',components:[
    {t:'text',text:'Each line below is a mistake the agent can make; none may vanish silently.'},
    {t:'svg',svg:'<div />'},
    {t:'viz',code:'<script src="https://cdn.example.com/lib.js"></script>'},
    {t:'viz',code:'window.render=function(){ throw new Error("widget blew up"); };'},
    {t:'gauge',value:42}]};
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui});}catch(_){}});
});
await page.waitForTimeout(500); await snap('20-errors-matrix', null);

writeFileSync(join(OUT,'findings.json'), JSON.stringify({errors, results}, null, 2));
await browser.close(); server.close();
// summary
// ---- WebView baseline: no CSS or JS the target WebView might not have ----------------------
// This gate exists because a question sat open as a COMMENT for weeks: index.html used
// `container-type: inline-size` + `@container` and `:has()`, all Chrome 105+, with no check of
// any kind. A flag is not a finding, and nothing failed while it was unresolved.
//
// THE FLOOR IS DERIVED FROM minSdk, not hardcoded — and that correction matters, because the
// first version of this gate hardcoded "minSdk 24, Android 7, WebView Chrome 51" and that premise
// turned out to be false. Android lint had never been run; when it was, the Java was calling API
// 33 (Arrays.compareUnsigned in the AEAD handshake path), so minSdk 24 was a promise the code
// could not keep and is now 33. Deriving the floor means this gate cannot be left arguing from a
// version nobody ships.
//
// WebView is updatable and only moves FORWARD, so the version in the system image is the floor a
// device can have. Mapping below.
//
// Consequence worth stating plainly: at minSdk 33 the floor is Chrome ~107, so @container and
// :has() would in fact have been safe. Removing them was still right on its own merits — the
// media query is exactly equivalent (the bar's content box is W/2 - 66, a pure function of
// viewport width) and the old @container threshold was mistuned, hiding a label at 320px that
// fit exactly. But the VERSION argument for removing them was wrong, and saying so here is
// cheaper than someone re-deriving it.
const WEBVIEW_FLOOR = [
  // [minSdk, Chrome version in that release's system WebView]
  [34, 115], [33, 107], [32, 96], [31, 93], [30, 83], [29, 74], [28, 66], [26, 58], [24, 51],
];
function chromeFloorFor(minSdk) {
  for (const [api, chrome] of WEBVIEW_FLOOR) if (minSdk >= api) return chrome;
  return 51;
}
const MIN_SDK = (() => {
  try {
    const gradle = readFileSync(join(ROOT, 'android', 'variables.gradle'), 'utf8');
    const m = /minSdkVersion\s*=\s*(\d+)/.exec(gradle);
    return m ? Number(m[1]) : 24;
  } catch { return 24; }
})();
const CHROME_FLOOR = chromeFloorFor(MIN_SDK);

const MODERN_CSS = [
  { re: /@container[\s(]/, name: '@container', chrome: 105 },
  { re: /container-type\s*:/, name: 'container-type', chrome: 105 },
  { re: /:has\(/, name: ':has()', chrome: 105 },
  { re: /@layer[\s{]/, name: '@layer', chrome: 99 },
  { re: /\bcolor-mix\s*\(/, name: 'color-mix()', chrome: 111 },
  { re: /@scope[\s{]/, name: '@scope', chrome: 118 },
  { re: /\btext-wrap\s*:\s*balance/, name: 'text-wrap: balance', chrome: 114 },
  { re: /\bfield-sizing\s*:/, name: 'field-sizing', chrome: 123 },
];
// The same question applies to the JAVASCRIPT, and nothing was asking it. The CSS scan was
// added first because that is where the open comment was; the surface's JS had never been
// checked against any engine baseline at all. It turned out clean (nothing newer than arrow
// functions and class syntax, both Chrome 49), which is worth KEEPING clean — one `?.` typed
// tomorrow would break the same devices, silently, with no rule to stop it.
const MODERN_JS = [
  { re: /\?\?/, name: 'nullish coalescing (??)', chrome: 80 },
  /* `?.` glued to what follows. My first attempt used a negative lookbehind for a word char,
   * meaning to exclude ternaries — and it excluded `foo?.bar`, the commonest form there is, so
   * the gate silently passed a file I had just salted with optional chaining. A ternary writes
   * `a ? .5 : b` WITH a space, so the absence of one is the real distinguisher. */
  { re: /\?\.(?=[A-Za-z_$[(])/, name: 'optional chaining (?.)', chrome: 80 },
  { re: /\bstructuredClone\s*\(/, name: 'structuredClone()', chrome: 98 },
  { re: /\.at\s*\(\s*-?\d/, name: 'Array.prototype.at()', chrome: 92 },
  { re: /\bObject\.hasOwn\s*\(/, name: 'Object.hasOwn()', chrome: 93 },
  { re: /\.replaceAll\s*\(/, name: 'String.replaceAll()', chrome: 85 },
  { re: /\bqueueMicrotask\s*\(/, name: 'queueMicrotask()', chrome: 71 },
  { re: /\bglobalThis\b/, name: 'globalThis', chrome: 71 },
  { re: /\{\s*\.\.\.[\w$]/, name: 'object spread', chrome: 60 },
];
const baselineFindings = [];
{
  const { readdirSync } = await import('node:fs');
  const { codeOnly } = await import('../lib/code-only.mjs');
  const wwwDir = join(ROOT, 'www');
  const files = readdirSync(wwwDir).filter((f) => /\.(html|css|js)$/.test(f));
  for (const f of files) {
    const raw = readFileSync(join(wwwDir, f), 'utf8');
    const isJs = f.endsWith('.js');
    /* JS goes through codeOnly, which understands strings AND regex literals — an earlier
     * version of that scanner read the apostrophe inside `/[&<>"']/` as a string start and
     * desynced for the rest of the file. CSS/HTML use a plain comment strip, which is enough
     * for them and avoids treating CSS as JavaScript. */
    const code = isJs
      ? codeOnly(raw, 'js')
      : raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const checks = isJs ? MODERN_JS : MODERN_CSS;
    for (const { re, name, chrome } of checks) {
      /* Only flag what is ABOVE the floor this minSdk guarantees. A feature the floor already
       * supports is not a finding, and treating it as one trains people to ignore the gate. */
      if (chrome > CHROME_FLOOR && re.test(code)) {
        baselineFindings.push({ sev: 'high', cat: 'webview-baseline', el: f,
          msg: `${f} uses ${name}, which needs Chrome ${chrome}. minSdk ${MIN_SDK} guarantees `
             + `only Chrome ${CHROME_FLOOR} (the WebView in that release's system image), and `
             + `the Pixel's actual WebView version has never been recorded. Remove it, raise `
             + `minSdk, or establish support from the device's own report first.` });
      }
    }
  }
  results['00-webview-baseline'] = { issues: baselineFindings, stats: {
    filesScanned: files.length,
    featuresChecked: MODERN_CSS.length + MODERN_JS.length,
    /* Recorded so the report says what the AUDIT browser supports — which is NOT the phone,
     * and is labelled that way so the two are never confused. */
    auditBrowserSupportsContainer: AUDIT_BROWSER.supportsContainer,
    auditBrowserUA: AUDIT_BROWSER.ua,
    minSdk: MIN_SDK,
    chromeFloor: CHROME_FLOOR,
    deviceWebViewUA: 'UNRECORDED — no handset has reported one; see test/audit/out/device/',
  } };
  console.log(`webview baseline: ${files.length} file(s) scanned, ${baselineFindings.length} `
    + `finding(s) — minSdk ${MIN_SDK} => WebView floor Chrome ${CHROME_FLOOR}`);
}

const all=[]; for(const [st,r] of Object.entries(results)) r.issues.forEach(i=>all.push({state:st,...i}));
const by=(k)=>all.reduce((m,i)=>(m[i[k]]=(m[i[k]]||0)+1,m),{});

// Console/page errors were COUNTED and printed and nothing more — so a brand-new runtime
// error still left the summary reading "issues by severity: {}", i.e. clean. A number nobody
// asserts on is not a check. Everything not on this allowlist is now a finding.
//
// The one intentional entry: `webrtc` is a FIREFOX-only CSP directive, deliberately present in
// the page's policy. Chromium does not know it and says so on every load. Keeping the
// allowlist an exact-match list (not a fuzzy filter) means a DIFFERENT CSP complaint still
// surfaces instead of being absorbed by a loose pattern.
const BENIGN_ERRORS = [
  "console: Unrecognized Content-Security-Policy directive 'webrtc'.",
];

const unexpected = errors.filter((e) => !BENIGN_ERRORS.includes(String(e).trim()));
const benignCount = errors.length - unexpected.length;

console.log('states:',Object.keys(results).length,'| page errors:',errors.length,
            `(${benignCount} expected, ${unexpected.length} UNEXPECTED)`);
console.log('issues by severity:',JSON.stringify(by('sev')));
console.log('issues by category:',JSON.stringify(by('cat')));
console.log('stats(boot):',JSON.stringify(results['01-boot-matrix'].stats));

if (unexpected.length) {
  const seen = new Map();
  for (const e of unexpected) seen.set(String(e).trim(), (seen.get(String(e).trim())||0)+1);
  console.log('\nUNEXPECTED page errors:');
  for (const [e,n] of seen) console.log(`  ${n}x ${e}`);
}
// Exit non-zero on anything real, so a run cannot be mistaken for a pass at a glance.
const bad = all.length + unexpected.length;
console.log(bad ? `\nFAIL: ${all.length} issue(s), ${unexpected.length} unexpected page error(s)`
                : '\nALL PASS');
process.exit(bad ? 1 : 0);
