/**
 * stop-flush.test — Stop has to stop the audio that is ALREADY on the phone.
 *
 * WHAT THIS CAN AND CANNOT SHOW. It reads the native source and the web bridge and asserts the
 * interrupt path clears both playback queues and flushes the AudioTrack, in the right order,
 * without breaking the next reply. It cannot hear anything. Whether the audio actually stops,
 * and whether the following reply starts cleanly rather than clipped, is a fact about the
 * handset and stays on the device-acceptance list as one.
 *
 * WHY IT EXISTS. Stop sent {"cmd":"interrupt"} and nothing else. That stops the SENDER. The
 * playback queues here are deliberately unbounded — a fixed one silently dropped every reply
 * longer than its capacity — so the residue depended on the transport: about a frame on the
 * paced WebRTC downlink, but the WHOLE remainder on the WS fallback, which bursts. Stop appeared
 * not to work, for seconds.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodBody, callsMethod, javaCode } from './lib/java-facts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(REPO, 'android/app/src/main/java/com/agentmobile/agent/AgentChannelPlugin.java');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nstop-flush — what Stop does to audio already on the device\n');

const src = readFileSync(PLUGIN, 'utf8');
const bridge = readFileSync(join(REPO, 'www/bridge.js'), 'utf8');
const flushBody = methodBody(src, 'flushPlaybackActual');
const trackBody = methodBody(src, 'flushTrack');

/* ---- the native half exists and is reachable ------------------------------------------------ */
ok('the plugin exposes flushPlayback to the web layer',
  /@PluginMethod\s+public void flushPlayback\(/.test(javaCode(src)),
  'the web layer has nothing to call, so Stop is still only an interrupt');
ok('flushPlaybackActual exists', !!flushBody);
ok('flushTrack exists', !!trackBody);

/* ---- BOTH queues, because a reply can be in either ------------------------------------------
 * playQueue is the duplex path (mic running), replyQueue the reply-only path. A Stop during a
 * hands-free turn and a Stop during a typed turn go through different ones. */
ok('flush clears playQueue', /\bplayQueue\s*\.\s*clear\s*\(\s*\)/.test(javaCode(flushBody)),
  'the duplex path keeps playing after Stop');
ok('flush clears replyQueue', /\breplyQueue\s*\.\s*clear\s*\(\s*\)/.test(javaCode(flushBody)),
  'the reply-only path keeps playing after Stop — this is the WS-burst case, where the whole '
  + 'remainder of the reply can be queued');
ok('it reports how many frames it dropped',
  /\bdropped\b/.test(javaCode(flushBody)) && /playQueue\.size\(\)/.test(javaCode(flushBody)),
  'a flush that discards nothing and a flush that discards four seconds must be tellable apart '
  + 'in the log');

/* ---- clearing the queues is NOT enough ------------------------------------------------------
 * AudioTrack holds its own buffer. Without flushing it the last fraction of a second still
 * plays, and that is exactly the part someone notices. */
ok('flush also flushes the AudioTrack(s)',
  callsMethod(flushBody, 'flushTrack'),
  'the queues are emptied but the hardware buffer still plays out');
ok('BOTH tracks are flushed — duplex and reply-only',
  /flushTrack\(track\)/.test(javaCode(flushBody)) && /flushTrack\(playTrack\)/.test(javaCode(flushBody)),
  'one path would still play its buffer');
ok('flushTrack calls AudioTrack.flush()', /\.\s*flush\s*\(\s*\)/.test(javaCode(trackBody)));

/* ---- and it must not break the NEXT reply ---------------------------------------------------
 * flush() is only defined while paused or stopped, and a track left paused has nowhere to play.
 * This is the half that turns a fix into a regression. */
const t = javaCode(trackBody);
ok('flushTrack pauses before flushing', /\.\s*pause\s*\(\s*\)/.test(t),
  'AudioTrack.flush() is undefined while PLAYING');
ok('and resumes after', /\.\s*play\s*\(\s*\)/.test(t),
  'a track left paused means the next reply has nowhere to play — the fix would be worse than '
  + 'the gap');
ok('in that order: pause, flush, play',
  t.indexOf('.pause(') < t.indexOf('.flush(') && t.indexOf('.flush(') < t.indexOf('.play('),
  t.replace(/\s+/g, ' ').trim().slice(0, 140));
ok('flushTrack tolerates a null track',
  /if\s*\(\s*t\s*==\s*null\s*\)\s*return\s*;/.test(t),
  'playTrack is set to null by the reply thread when it exits, so Stop can race it');
ok('and a throwing track does not take the Stop down with it',
  /catch\s*\([^)]*\)\s*\{[^}]*Log\./.test(t),
  'an exception here would reject the plugin call and the interrupt would never be sent');

/* ---- the PRE-ROLL must be re-armed ----------------------------------------------------------
 * beginReplyBurst() pads the start of a reply when it sees a gap over 250ms. After a flush the
 * next frame may arrive immediately, so the stamp is zeroed to force a re-pad — otherwise the
 * reply after a Stop starts on an under-primed buffer, which is the clipping bug this project
 * already fixed once. */
ok('the pre-roll stamp is reset so the next reply re-pads',
  /lastReplyEnqMs\s*=\s*0\s*;/.test(javaCode(flushBody)),
  'the reply after a Stop would start under-primed and clip');
ok('the echo gate is released too',
  /replyActiveUntil\s*=\s*0\s*;/.test(javaCode(flushBody)),
  'the mic would stay gated waiting for a reply that was just cancelled');
const burst = methodBody(src, 'beginReplyBurst');
ok('a zeroed stamp really does force a pad',
  /lastReplyEnqMs\s*==\s*0\s*\|\|/.test(javaCode(burst)),
  `beginReplyBurst no longer treats 0 as "pad now": ${javaCode(burst).replace(/\s+/g, ' ').slice(0, 120)}`);

/* ---- the web half calls it, and calls it FIRST ---------------------------------------------- */
const stopFn = (bridge.match(/stop:\s*function\s*\(\)\s*\{[\s\S]*?\n    \},/) || [])[0] || '';
ok('the Stop control has a stop() handler to inspect', stopFn.length > 40, stopFn.slice(0, 80));
ok('Stop calls flushPlayback', /flushPlayback\s*\(/.test(stopFn),
  'the web layer sends the interrupt and nothing else — the original gap');
ok('Stop still sends the interrupt', /cmd":"interrupt/.test(stopFn),
  'flushing locally without telling the agent leaves it talking to itself');
ok('the local flush goes BEFORE the wire round trip',
  stopFn.indexOf('flushPlayback') < stopFn.indexOf('interrupt'),
  'the interrupt is a round trip; the buffered audio would keep playing for its duration, which '
  + 'is the part a person actually hears');
ok('a missing native method does not break Stop',
  /P\s*&&\s*P\.flushPlayback/.test(stopFn),
  'an older APK with a newer surface would throw here and never send the interrupt');
ok('and a rejected flush does not swallow the interrupt',
  /\.catch\(/.test(stopFn) && stopFn.indexOf('.catch(') < stopFn.indexOf('interrupt'),
  'an unhandled rejection would surface as an error toast on every Stop');

/* ---- the bundled surface must carry it too --------------------------------------------------
 * www/ is the source; the APK ships a copy. apk-installable compares them byte for byte, but
 * only for the APK it was pointed at — this says the SOURCE has the fix at all. */
ok('the shipped bridge in www/ is the one with the flush',
  /flushPlayback/.test(readFileSync(join(REPO, 'www/bridge.js'), 'utf8')));

/* ---- the limit, stated in the file that asserts it ------------------------------------------ */
console.log('\n  These assertions read source. They do not hear anything: whether the audio');
console.log('  actually stops, and whether the next reply starts cleanly rather than clipped,');
console.log('  is a fact about the handset and stays on the device-acceptance list as one.');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
