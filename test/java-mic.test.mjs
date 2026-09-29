/**
 * java-mic.test — the native half of issue #1, read from the Java.
 *
 * mic-mute proves the web layer's state machine against a stubbed bridge. It cannot see what the
 * Java does with the boolean it is handed, and that is where a one-character bug hides: write
 * `am.setMicrophoneMute(!muted)` and the ring still reads MUTED, the interrupt is still
 * suppressed, the reply still plays — every host assertion passes and only the microphone stays
 * live, which is issue #1 itself, surviving to the handset undetected.
 *
 * device-acceptance says this item is narrowed to "the syscall has no host equivalent". True of
 * the syscall. Not true of the argument.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodBody, callArg, callsMethod, javaCode } from './lib/java-facts.mjs';
import { haveJavac, runHarness, JSON_HELPERS } from './lib/java-exec.mjs';
import { micMuteEvents } from './lib/device-probe.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(REPO, 'android/app/src/main/java/com/agentmobile/agent/AgentChannelPlugin.java');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\njava-mic — what the native layer does with the boolean\n');

const src = readFileSync(PLUGIN, 'utf8');
const setBody = methodBody(src, 'setMicMuted');
const toggleBody = methodBody(src, 'nativeToggleMic');

ok('setMicMuted(boolean) exists in the plugin', !!setBody,
  'the method the web layer calls is gone or renamed; mic-mute would still pass against its stub');
ok('nativeToggleMic() exists', !!toggleBody);

/* ---- THE ARGUMENT ------------------------------------------------------------------------- */
const arg = callArg(setBody, 'setMicrophoneMute');
ok('setMicMuted calls AudioManager.setMicrophoneMute', arg !== null,
  'the mute is not performed at all — the ring would still read MUTED');
ok('it passes the parameter straight through, NOT negated',
  arg === 'muted',
  `passes ${JSON.stringify(arg)} — a negation here leaves the microphone live while every host `
  + 'assertion passes, because the ring reads the FIELD and the field is set correctly');
ok('it does not pass a constant',
  arg !== 'true' && arg !== 'false',
  `passes ${JSON.stringify(arg)} — a constant makes unmute or mute a no-op and the control wedges`);

/* ---- THE FIELD AND THE CALL MUST AGREE -----------------------------------------------------
 * The ring is driven from `micMuted`; the hardware from the call. If they take different
 * values the phone and the UI disagree, which is the state issue #1 presents as. */
ok('the tracked field is assigned the same parameter',
  /\bmicMuted\s*=\s*muted\s*;/.test(javaCode(setBody)),
  'micMuted is what the web layer reads back — if it and the hardware call disagree, the UI and '
  + 'the microphone are in different states and the phone is the one that is right');

/* ---- THE WEB LAYER HAS TO BE TOLD --------------------------------------------------------- */
ok('the state change is announced to the web layer',
  callsMethod(setBody, 'notifyAudioState'),
  'the native mute would not reach the ring, so the surface shows a live mic over a muted one');

/* ---- THE TOGGLE MUST TOGGLE --------------------------------------------------------------- */
ok('nativeToggleMic flips the current state rather than setting a constant',
  /setMicMuted\s*\(\s*!\s*micMuted\s*\)/.test(javaCode(toggleBody)),
  `body is ${JSON.stringify((toggleBody || '').trim())} — a constant here means the button mutes `
  + 'but never unmutes, which is the "control wedges" half of issue #1');

/* ---- FAILURE MUST NOT BE SILENT ------------------------------------------------------------ */
ok('a failing mute is logged, not swallowed',
  /catch\s*\([^)]*\)\s*\{[^}]*Log\./.test(javaCode(setBody)),
  'an exception from setMicrophoneMute would leave the ring reading MUTED with a live mic and '
  + 'nothing in logcat to find');

/* ---- POSITIVE CONTROLS ---------------------------------------------------------------------
 * Every assertion above passes on code that is already correct. Each is run again against a
 * fixture carrying the exact bug it names — otherwise a reader that returned null for
 * everything, or a regex that never matched, would look identical from here. */
const FIX = `
  public void setMicMuted(boolean muted) {
    try {
      micMuted = muted;
      AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
      am.setMicrophoneMute(!muted);
      Log.i("AgentChannel", "mic");
    } catch (Exception e) { Log.w("AgentChannel", "x"); }
    notifyAudioState();
  }
  public void nativeToggleMic() { setMicMuted(true); }
`;
ok('control: a NEGATED argument is caught', callArg(methodBody(FIX, 'setMicMuted'), 'setMicrophoneMute') === '!muted',
  'the reader does not see the negation, so the assertion above proves nothing');
ok('control: a toggle that sets a constant is caught',
  !/setMicMuted\s*\(\s*!\s*micMuted\s*\)/.test(javaCode(methodBody(FIX, 'nativeToggleMic'))),
  'a constant toggle reads as a real one');
const NO_NOTIFY = FIX.replace('notifyAudioState();', '');
ok('control: a missing notifyAudioState is caught',
  !callsMethod(methodBody(NO_NOTIFY, 'setMicMuted'), 'notifyAudioState'));
const SWALLOWED = FIX.replace('catch (Exception e) { Log.w("AgentChannel", "x"); }',
                              'catch (Exception e) { }');
ok('control: a swallowed exception is caught',
  !/catch\s*\([^)]*\)\s*\{[^}]*Log\./.test(javaCode(methodBody(SWALLOWED, 'setMicMuted'))));
ok('control: a missing method reads as missing, not as correct',
  methodBody(FIX, 'noSuchMethodHere') === null && callArg(null, 'setMicrophoneMute') === null);

/* And the reader must not be fooled by prose. This file's own header talks about the negation. */
ok('control: a call named only in a COMMENT is not read as a call',
  callArg('/* we must never write .setMicrophoneMute(!muted) here */ int x = 1;',
          'setMicrophoneMute') === null,
  'comments mentioning the bug would read as the bug');
ok('control: a call named only in a STRING is not read as a call',
  callArg('Log.i("t", "calls .setMicrophoneMute(!muted) eventually");', 'setMicrophoneMute') === null);

/* ---- EXECUTED. The assertions above read the source; attacked with behaviour mutants that
 * keep the text, two defects passed every one of them:
 *   - `if (muted) am.setMicrophoneMute(muted);` — UNMUTE never reaches the hardware. The mic
 *     sticks muted for good while the call "passes the parameter straight through";
 *   - `if (!muted) notifyAudioState();` — a MUTE is never announced, so the page shows a live
 *     mic that is muted.
 * So the shipped setMicMuted / nativeToggleMic / notifyAudioState bodies are compiled against
 * AudioManager/Context/Activity/Log stubs and run. */
console.log('\n  executed: the shipped bodies, compiled with javac and run\n');
if (!haveJavac()) {
  ok('javac is available to execute the shipped mic code', false, 'no javac on PATH');
} else {
  const notifyBody = methodBody(src, 'notifyAudioState');
  ok('notifyAudioState is present in the shipped source', !!notifyBody);
  const harness = `
import java.util.*;
class Context { static final String AUDIO_SERVICE = "audio";
  Object getSystemService(String n) { return AUDIO_SERVICE.equals(n) ? Harness.am : null; } }
class AudioManager { final List<Boolean> calls = new ArrayList<>(); boolean refuse;
  void setMicrophoneMute(boolean m) { if (refuse) throw new SecurityException("MODIFY_AUDIO_SETTINGS denied"); calls.add(m); } }
class Activity { void runOnUiThread(Runnable r) { r.run(); } }
class Log { static final List<String> lines = new ArrayList<>();
  static int i(String t, String m) { lines.add("I " + t + ": " + m); return 0; }
  static int w(String t, String m) { lines.add("W " + t + ": " + m); return 0; }
  static int w(String t, String m, Throwable e) { return w(t, m); }
  static int e(String t, String m) { lines.add("E " + t + ": " + m); return 0; }
  static int e(String t, String m, Throwable e) { return e(t, m); } }
public class Harness {
  static AudioManager am = new AudioManager();
  public interface AudioSink { void onAudio(boolean running); }
  private volatile boolean micMuted;
  private volatile boolean connected = true;
  private volatile AudioSink audioSink;
  final List<Boolean> sunk = new ArrayList<>();
  final Context ctx = new Context(); Context getContext() { return ctx; }
  final Activity act = new Activity(); Activity getActivity() { return act; }
  public void setMicMuted(boolean muted) {${setBody}}
  public void nativeToggleMic() {${toggleBody}}
  private void notifyAudioState() {${notifyBody}}
${JSON_HELPERS}
  String dump(String name, Throwable err) {
    return "{\\"s\\":" + q(name) + ",\\"hw\\":" + list(am.calls) + ",\\"muted\\":" + micMuted
      + ",\\"sunk\\":" + list(sunk) + ",\\"err\\":" + (err == null ? "null" : q(err.toString()))
      + ",\\"log\\":" + list(Log.lines) + "}";
  }
  static Harness fresh() { am = new AudioManager(); Log.lines.clear(); Harness h = new Harness();
    h.audioSink = h.sunk::add; return h; }
  public static void main(String[] a) {
    Harness h; Throwable err;
    h = fresh(); err = null; try { h.setMicMuted(true); h.setMicMuted(false); } catch (Throwable e) { err = e; }
    System.out.println(h.dump("mute-unmute", err));
    h = fresh(); err = null; try { h.nativeToggleMic(); h.nativeToggleMic(); h.nativeToggleMic(); } catch (Throwable e) { err = e; }
    System.out.println(h.dump("toggle3", err));
    h = fresh(); am.refuse = true; err = null; try { h.setMicMuted(true); } catch (Throwable e) { err = e; }
    System.out.println(h.dump("refused", err));
  }
}
`;
  const run = runHarness(harness);
  ok('the shipped mic bodies COMPILE against the stubs', run.compiled, run.compileErr.split('\n').slice(0, 6).join('\n       '));
  ok('and RUN', run.ran, run.runErr.slice(0, 300));
  const mu = run.out['mute-unmute'] || {};
  ok('exec: mute then unmute reaches the HARDWARE both times, in order',
    JSON.stringify(mu.hw) === '[true,false]', `AudioManager saw ${JSON.stringify(mu.hw)}`);
  ok('exec: and the web layer is told both times — mic dead, then live',
    JSON.stringify(mu.sunk) === '[false,true]', `onAudio saw ${JSON.stringify(mu.sunk)}`);
  ok('exec: the tracked state ends unmuted', mu.muted === false);
  const ev = micMuteEvents((mu.log || []).map((l) => `09-29 00:00:00.000 1 1 ${l}`).join('\n'));
  ok('exec: the lines it LOGS are the ones device-verify parses, muted then unmuted',
    ev.length === 2 && ev[0].muted === true && ev[1].muted === false, JSON.stringify(mu.log));
  const t3 = run.out.toggle3 || {};
  ok('exec: the native button toggles — three taps are mute, unmute, mute',
    JSON.stringify(t3.hw) === '[true,false,true]' && t3.muted === true, JSON.stringify(t3));
  const rf = run.out.refused || {};
  ok('exec: a refused mute does not throw out of the plugin', rf.err === null, rf.err);
  ok('exec: a REFUSED mute is not recorded as muted — the hardware never took it',
    rf.muted === false && JSON.stringify(rf.hw) === '[]', JSON.stringify({ hw: rf.hw, muted: rf.muted }));
  ok('exec: and the page is told the mic is still LIVE, not that it went dead',
    JSON.stringify(rf.sunk) === '[true]',
    `onAudio saw ${JSON.stringify(rf.sunk)} — false means the badge says muted over a live mic`);
  ok('exec: and is logged', (rf.log || []).some((l) => /^W AgentChannel: setMicMuted:/.test(l)), JSON.stringify(rf.log));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
