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
  const textEls=[...document.querySelectorAll('body *')].filter(el=>vis(el)&&el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
  const tiny=new Set(); textEls.forEach(el=>{ const fs=parseFloat(getComputedStyle(el).fontSize); if(fs<12) tiny.add(`${el.id?'#'+el.id:el.tagName.toLowerCase()} ${fs}px`); });
  tiny.forEach(t=>out.issues.push({sev:'med',cat:'legibility',el:t.split(' ')[0],msg:`text ${t.split(' ')[1]} < 12px`}));
  // 4. contrast of text vs effective background (approx: walks up for a solid bg)
  const lum=(c)=>{const m=c.match(/\d+(\.\d+)?/g)||[0,0,0];const [r,g,b]=m.slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
  const bgOf=(el)=>{ let e=el; while(e){ const bg=getComputedStyle(e).backgroundColor; if(bg&&!/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg)&&bg!=='transparent') return bg; e=e.parentElement;} return 'rgb(0,0,0)'; };
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
  // 8. lang + viewport
  if(!document.documentElement.lang) out.issues.push({sev:'low',cat:'a11y',el:'html',msg:'missing lang attribute'});
  const vp=document.querySelector('meta[name=viewport]')?.content||''; if(/user-scalable=no|maximum-scale=1/.test(vp)) out.issues.push({sev:'high',cat:'a11y',el:'meta viewport',msg:'pinch-zoom disabled'});
  // 9. horizontal overflow
  if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1) out.issues.push({sev:'high',cat:'layout',el:'body',msg:`horizontal overflow ${document.documentElement.scrollWidth}>${document.documentElement.clientWidth}`});
  return out;
};

const results = {};
async function snap(name, prep){
  if(prep) await page.evaluate(prep); await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, name+'.png') });
  results[name] = await page.evaluate(AUDIT);
}
// STATES
await snap('01-boot-matrix', null);
await snap('02-idle-matrix', () => { document.getElementById('boot').style.display='none'; document.getElementById('hb').classList.add('pulse'); });
await snap('03-content-chart-matrix', () => {
  // Drive the REAL renderer path (what the sidecar sends), not a hand-mount —
  // otherwise the audit measures its own scaffolding instead of the app.
  const o={chart:{type:'area',height:220},series:[{name:'Temp',data:[9,8,7,6,5,4,4,5,7,10,13,15,16]}],xaxis:{categories:['00','02','04','06','08','10','12','14','16','18','20','22','24']}};
  const ui={title:'Nelson · next 24h',components:[{t:'chart',options:o},
    {t:'list',items:[{title:'Now',subtitle:'14°C'},{title:'Low',subtitle:'6°C'}]}]};
  (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui});}catch(_){}});
});
await snap('04-working-matrix', () => { document.getElementById('work').classList.add('show'); });
await snap('05-idle-lcars', () => { document.getElementById('work').classList.remove('show'); (window.__agent.onMessage||[]).forEach(fn=>{try{fn({type:'render',ui:{}});}catch(_){}}); location.hash=''; document.body.dataset.theme='lcars'; document.getElementById('ui').innerHTML=document.querySelector('#ui').innerHTML; });
await page.reload(); await page.waitForTimeout(400);
await snap('06-idle-hud', () => { document.getElementById('boot').style.display='none'; document.body.dataset.theme='hud'; });
await snap('07-idle-lcars', () => { document.body.dataset.theme='lcars'; });

writeFileSync(join(OUT,'findings.json'), JSON.stringify({errors, results}, null, 2));
await browser.close(); server.close();
// summary
const all=[]; for(const [st,r] of Object.entries(results)) r.issues.forEach(i=>all.push({state:st,...i}));
const by=(k)=>all.reduce((m,i)=>(m[i[k]]=(m[i[k]]||0)+1,m),{});
console.log('states:',Object.keys(results).length,'| page errors:',errors.length);
console.log('issues by severity:',JSON.stringify(by('sev')));
console.log('issues by category:',JSON.stringify(by('cat')));
console.log('stats(boot):',JSON.stringify(results['01-boot-matrix'].stats));
