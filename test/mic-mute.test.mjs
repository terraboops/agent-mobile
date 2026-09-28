/**
 * mic-mute.test — issue #1's state machine, offline.
 *
 * Issue #1 is "the mic control wedges / drifts", and its acceptance has two halves. The half that
 * genuinely needs the handset is whether AudioManager.setMicrophoneMute() silences the hardware —
 * only `adb shell dumpsys audio` can say that. The OTHER half is a state machine living in
 * www/bridge.js and www/renderer.js, and it needed no device at all; it was simply never tested.
 *
 * The claim that matters most, and the one the device stage is named after:
 *
 *     MUTING THE MIC MUST NOT STOP THE REPLY.
 *
 * They are separate directions on a duplex link — the agent's voice is downlink, the mic is
 * uplink — and conflating them is the bug users actually hit: you mute yourself to stop the room
 * hearing you, and the agent goes silent mid-sentence too. The inverse matters as much: Stop is an
 * interrupt of the REPLY and must not touch the mic, or stopping a long answer leaves you muted
 * without having asked for it.
 *
 * Driven through the real chain, not by poking the setters: a `{type:'status', speaking:true}`
 * message goes through renderer.js exactly as the sidecar sends it, and the mic is toggled through
 * window.__agent.audioToggle() exactly as the ring's click handler does. The native plugin is
 * stubbed, because the native plugin is the part that needs a phone.
 *
 * Run: npm run mic-mute
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.css': 'text/css' };

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

const server = createServer((req, res) => {
  const p = join(ROOT, 'www', decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p) || !p.startsWith(join(ROOT, 'www'))) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();

/* The native plugin, stubbed BEFORE bridge.js runs — its IIFE binds the control bar at load.
 *
 * The stub is deliberately faithful on the one point that matters: startAudio/stopAudio change
 * ONLY the mic's running state. That mirrors the real plugin, where setMicMuted touches
 * AudioManager.setMicrophoneMute and nothing else — it never reaches playback. If the web layer
 * were the thing stopping the reply, this test would catch it; if the native layer regressed, only
 * the device can. Both halves named so neither is mistaken for the other. */
await page.addInitScript(() => {
  window.__calls = { sent: [], startAudio: 0, stopAudio: 0 };
  let running = true;                       // mic live at boot, as after __ensureMicOn
  window.Capacitor = { Plugins: { AgentChannel: {
    isAudioRunning: () => Promise.resolve({ running }),
    startAudio: () => { window.__calls.startAudio++; running = true; return Promise.resolve({}); },
    stopAudio: () => { window.__calls.stopAudio++; running = false; return Promise.resolve({}); },
    send: ({ payload }) => { window.__calls.sent.push(String(payload)); return Promise.resolve({}); },
    connect: () => Promise.resolve({}),
    identify: () => Promise.resolve({}),
    addListener: () => ({ remove() {} }),
  } } };
  window.AGENT_URL = 'ws://127.0.0.1:1/never';
});

await page.goto(`${base}/index.html`);
await page.waitForTimeout(400);
/* Reflect the stub's state onto the controls the way a real connect does. */
await page.evaluate(() => window.__syncLiveCtl());
await page.waitForTimeout(150);

const ringClass = () => page.evaluate(() =>
  (document.getElementById('mic-ring') || {}).className || '(no ring)');
const speaking = () => page.evaluate(() => {
  const b = document.getElementById('agentSpeech');
  return !!(b && b.classList.contains('show'));
});
const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__calls)));
/* A status frame as the sidecar sends it, through the renderer's real handler chain. */
const status = (st) => page.evaluate((s) =>
  (window.__agent.onMessage || []).forEach((fn) => { try { fn(s); } catch (_) {} }),
  { type: 'status', ...st });

console.log('issue #1 state machine, no device attached\n');

/* ---- 1. the mic is live and the controls agree ---------------------------------------------- */
ok('the mic ring reads UNMUTED at boot', (await ringClass()).includes('unmuted'),
  await ringClass());

/* ---- 2. the agent starts speaking ------------------------------------------------------------ */
await status({ speaking: true });
await page.waitForTimeout(120);
ok('the agent-speaking widget shows when a reply starts', await speaking(),
  'the surface never indicated the reply began, so the mute test below would prove nothing');

/* ---- 3. THE CLAIM: mute mid-sentence, reply keeps playing ------------------------------------ */
const beforeMute = await calls();
await page.evaluate(() => window.__agent.audioToggle());
await page.waitForTimeout(250);
const afterMute = await calls();

ok('muting stopped the MIC (native stopAudio called once)',
  afterMute.stopAudio === beforeMute.stopAudio + 1,
  `stopAudio ${beforeMute.stopAudio} -> ${afterMute.stopAudio}`);
ok('the mic ring reads MUTED after the toggle', (await ringClass()).includes('muted'),
  await ringClass());
ok('the reply KEPT PLAYING while the mic was muted (issue #1)', await speaking(),
  'the agent-speaking widget was cleared by muting the mic — uplink and downlink are separate '
  + 'directions, and muting yourself must not silence the agent mid-sentence');
ok('muting sent NO interrupt to the agent',
  afterMute.sent.filter((p) => /"cmd"\s*:\s*"interrupt"/.test(p)).length === 0,
  `sent: ${JSON.stringify(afterMute.sent)} — muting the mic must not cancel the running turn`);

/* ---- 4. a muted mic must not keep showing input --------------------------------------------- */
await page.evaluate(() => window.__setMicLevel && window.__setMicLevel(0.9));
await page.waitForTimeout(120);
ok('a muted mic does not pulse on input level', !(await ringClass()).includes('pulse'),
  await ringClass() + ' — a meter that moves while muted tells the user they are being heard');
ok('the waveform is not "hot" while muted',
  !(await page.evaluate(() => {
    const s = document.getElementById('micwave');
    return !!(s && s.classList.contains('hot'));
  })),
  'the wave glows as if capturing while the mic is off');

/* ---- 5. the inverse: Stop interrupts the REPLY and leaves the mic alone ---------------------- */
await page.evaluate(() => window.__agent.audioToggle());     // unmute again
await page.waitForTimeout(250);
ok('the mic can be unmuted again (the control does not wedge — issue #1)',
  (await ringClass()).includes('unmuted'), await ringClass());

const beforeStop = await calls();
await page.evaluate(() => window.__agent.stop());
await page.waitForTimeout(250);
const afterStop = await calls();
ok('Stop sends an interrupt',
  afterStop.sent.filter((p) => /"cmd"\s*:\s*"interrupt"/.test(p)).length
    > beforeStop.sent.filter((p) => /"cmd"\s*:\s*"interrupt"/.test(p)).length,
  `sent: ${JSON.stringify(afterStop.sent)}`);
ok('Stop did NOT touch the mic',
  afterStop.startAudio === beforeStop.startAudio && afterStop.stopAudio === beforeStop.stopAudio,
  'interrupting a long reply must not mute the user as a side effect');
ok('the mic ring still reads UNMUTED after Stop', (await ringClass()).includes('unmuted'),
  await ringClass());

/* ---- 6. rapid taps must not double-flip (the wedge in issue #1) ------------------------------ */
const beforeRapid = await calls();
await page.evaluate(() => {
  /* Two taps in the same tick, exactly as a double-tap on the ring delivers them. The
   * re-entrancy guard in audioToggle must swallow the second while the first is in flight;
   * without it the state flips twice and the label drifts from the hardware — the original
   * symptom. */
  window.__agent.audioToggle();
  window.__agent.audioToggle();
});
await page.waitForTimeout(400);
const afterRapid = await calls();
const transitions = (afterRapid.startAudio - beforeRapid.startAudio)
  + (afterRapid.stopAudio - beforeRapid.stopAudio);
ok('a double tap causes exactly ONE native transition', transitions === 1,
  `${transitions} transitions (start ${beforeRapid.startAudio}->${afterRapid.startAudio}, `
  + `stop ${beforeRapid.stopAudio}->${afterRapid.stopAudio}) — the re-entrancy guard is what `
  + 'keeps the label from drifting off the hardware');
ok('the ring agrees with the native state after a double tap',
  (await ringClass()).includes('muted'), await ringClass());

/* ---- 7. and the reply is still unaffected by any of it --------------------------------------- */
ok('the reply survived every mic operation', await speaking(),
  'something in the mic path cleared the speaking indicator');
await status({ speaking: false });
await page.waitForTimeout(120);
ok('the speaking indicator clears when the reply actually ends', !(await speaking()),
  'the widget is stuck on, so the phone would show the agent talking forever');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
