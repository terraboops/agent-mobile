#!/usr/bin/env node
/**
 * java-flush — the Stop flush, EXECUTED. The shipped Java method bodies, compiled and run.
 *
 * WHY. stop-flush proves the flush by reading source: `playQueue.clear()` appears, `flush()`
 * comes after `pause()`, and so on. It was the weakest host proof in the device-verify set, and
 * attacking it showed why — two mutants that break the behaviour and keep the text survived all
 * 24 of its assertions:
 *
 *   - the dropped COUNT taken after playQueue was cleared. The log line then lies, and that
 *     number is what device-verify reads to tell the burst WS path from the paced one, so on the
 *     handset a forced-WS run would have failed as "the force did not take" — or a paced one
 *     passed as bursting — with the fix itself fine;
 *   - `replyQueue.clear()` made unreachable (`if (dropped < 0) ...`). The regex still matched.
 *     On the reply-only path — mic off — Stop would have left the whole reply queued.
 *
 * So this lifts flushPlaybackActual, flushTrack and beginReplyBurst OUT OF THE SHIPPED SOURCE —
 * the text that is compiled into the APK, not a copy — and compiles them with javac against
 * stubs of the three Android classes they touch (AudioTrack, Log, SystemClock). A mutation to
 * the real file is a mutation to what runs here. The stubs record calls; they decide nothing.
 *
 * THE LIMIT: the stubs are not Android. That AudioTrack.flush() on a real device empties the
 * hardware buffer, and that the result is silence, stays the handset's.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodBody } from './lib/java-facts.mjs';
import { flushEvents } from './lib/device-probe.mjs';
import { haveJavac, runHarness, JSON_HELPERS } from './lib/java-exec.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = join(REPO, 'android/app/src/main/java/com/agentmobile/agent/AgentChannelPlugin.java');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

if (!haveJavac()) {
  console.log('  no javac on PATH — this suite executes the shipped Java and cannot run without one');
  process.exit(1);
}

const src = readFileSync(JAVA, 'utf8');
const bodies = {
  flushPlaybackActual: methodBody(src, 'flushPlaybackActual'),
  flushTrack: methodBody(src, 'flushTrack'),
  beginReplyBurst: methodBody(src, 'beginReplyBurst'),
};
for (const [k, v] of Object.entries(bodies)) ok(`${k} is present in the shipped source`, !!v);
if (Object.values(bodies).some((v) => !v)) { console.log(`\n${pass} passed, ${fails.length} failed`); process.exit(1); }

/* The harness. Fields carry the SAME types as the plugin's; the three methods are the plugin's
 * text verbatim. Each scenario prints one JSON line. */
const harness = `
import java.util.*;
import java.util.concurrent.*;

class AudioTrack {
  static final int PLAYSTATE_STOPPED = 1, PLAYSTATE_PAUSED = 2, PLAYSTATE_PLAYING = 3;
  final List<String> calls = new ArrayList<>();
  int state; boolean throwOnFlush;
  AudioTrack(int s) { state = s; }
  int getPlayState() { return state; }
  void pause() { calls.add("pause"); state = PLAYSTATE_PAUSED; }
  /* Only defined on a paused or stopped track — the reason flushTrack pauses first. A flush on a
   * PLAYING track is recorded as a no-op, which is what Android does with it. */
  void flush() { if (throwOnFlush) throw new IllegalStateException("boom");
                 calls.add(state == PLAYSTATE_PLAYING ? "flush-IGNORED" : "flush"); }
  void play() { calls.add("play"); state = PLAYSTATE_PLAYING; }
}
class Log {
  static final List<String> lines = new ArrayList<>();
  static int i(String t, String m) { lines.add("I " + t + ": " + m); return 0; }
  static int w(String t, String m) { lines.add("W " + t + ": " + m); return 0; }
  static int w(String t, String m, Throwable e) { return w(t, m); }
  static int e(String t, String m) { lines.add("E " + t + ": " + m); return 0; }
  static int e(String t, String m, Throwable e) { return e(t, m); }
}
class SystemClock { static long now = 10000; static long elapsedRealtime() { return now; } }

public class Harness {
  private static final int AUDIO_FRAME = 480;
  private final LinkedBlockingQueue<short[]> playQueue = new LinkedBlockingQueue<>();
  private final LinkedBlockingQueue<short[]> replyQueue = new LinkedBlockingQueue<>();
  private volatile long lastReplyEnqMs;
  private volatile AudioTrack track;
  private volatile AudioTrack playTrack;
  private volatile long replyActiveUntil;
  private volatile long stopGateUntil;
  private volatile long stopGateLastDrop;
  private static final long STOP_GATE_MAX_MS = 30000;

  int flushPlaybackActual() {${bodies.flushPlaybackActual}}
  private void flushTrack(AudioTrack t) {${bodies.flushTrack}}
  private boolean beginReplyBurst() {${bodies.beginReplyBurst}}

${JSON_HELPERS}
  void fill(int p, int r) { for (int i = 0; i < p; i++) playQueue.offer(new short[AUDIO_FRAME]);
                            for (int i = 0; i < r; i++) replyQueue.offer(new short[AUDIO_FRAME]); }
  String state(String name, int ret, Throwable err) {
    return "{\\"s\\":" + q(name) + ",\\"ret\\":" + ret + ",\\"play\\":" + playQueue.size()
      + ",\\"reply\\":" + replyQueue.size() + ",\\"stamp\\":" + lastReplyEnqMs + ",\\"gate\\":" + replyActiveUntil
      + ",\\"track\\":" + (track == null ? "null" : list(track.calls)) + ",\\"trackState\\":" + (track == null ? 0 : track.state)
      + ",\\"playTrack\\":" + (playTrack == null ? "null" : list(playTrack.calls)) + ",\\"playTrackState\\":" + (playTrack == null ? 0 : playTrack.state)
      + ",\\"err\\":" + (err == null ? "null" : q(err.toString())) + ",\\"log\\":" + list(Log.lines) + "}";
  }
  static String run(String name, Harness h) {
    Log.lines.clear(); int ret = -1; Throwable err = null;
    try { ret = h.flushPlaybackActual(); } catch (Throwable e) { err = e; }
    return h.state(name, ret, err);
  }

  public static void main(String[] a) {
    Harness h;
    h = new Harness(); h.fill(5, 7); h.track = new AudioTrack(AudioTrack.PLAYSTATE_PLAYING);
    h.playTrack = new AudioTrack(AudioTrack.PLAYSTATE_PLAYING); h.lastReplyEnqMs = 9990; h.replyActiveUntil = 10900;
    System.out.println(run("both-playing", h));

    h = new Harness(); h.fill(0, 9); h.playTrack = new AudioTrack(AudioTrack.PLAYSTATE_PLAYING);
    System.out.println(run("reply-only", h));

    h = new Harness(); h.fill(3, 0);
    System.out.println(run("no-tracks", h));

    h = new Harness(); h.fill(2, 2); h.track = new AudioTrack(AudioTrack.PLAYSTATE_PLAYING); h.track.throwOnFlush = true;
    h.playTrack = new AudioTrack(AudioTrack.PLAYSTATE_PLAYING);
    System.out.println(run("track-throws", h));

    h = new Harness(); h.track = new AudioTrack(AudioTrack.PLAYSTATE_PAUSED);
    System.out.println(run("track-paused", h));

    /* Mid-reply: a frame 10ms after the last is NOT a new burst. Stop, then a frame 10ms later
     * again — the next reply — must be, or it starts under-primed and clips. */
    h = new Harness(); SystemClock.now = 10000; h.beginReplyBurst(); SystemClock.now = 10010;
    boolean mid = h.beginReplyBurst();
    h.flushPlaybackActual(); SystemClock.now = 10020;
    boolean after = h.beginReplyBurst();
    System.out.println("{\\"s\\":\\"repad\\",\\"mid\\":" + mid + ",\\"after\\":" + after + "}");
  }
}
`;

const run = runHarness(harness);
ok('the shipped method bodies COMPILE against the stubs', run.compiled, run.compileErr.split('\n').slice(0, 6).join('\n       '));
ok('and RUN', run.ran, run.runErr.slice(0, 300));
const S = run.out;

const b = S['both-playing'] || {};
ok('flush: BOTH queues are empty afterwards', b.play === 0 && b.reply === 0, JSON.stringify({ play: b.play, reply: b.reply }));
ok('flush: the count is what WAS queued — 5 + 7, taken before anything was cleared', b.ret === 12, `returned ${b.ret}`);
ok('flush: the duplex track was paused, FLUSHED while paused, then resumed',
  JSON.stringify(b.track) === '["pause","flush","play"]', JSON.stringify(b.track));
ok('flush: so was the reply-only track', JSON.stringify(b.playTrack) === '["pause","flush","play"]', JSON.stringify(b.playTrack));
ok('flush: both tracks are left PLAYING, so the next reply has somewhere to go',
  b.trackState === 3 && b.playTrackState === 3, `${b.trackState}/${b.playTrackState}`);
ok('flush: the pre-roll stamp and the echo gate are zeroed', b.stamp === 0 && b.gate === 0, `${b.stamp}/${b.gate}`);
const ev = flushEvents((b.log || []).map((l) => `09-29 00:00:00.000 1 1 ${l}`).join('\n'));
ok('flush: the line it LOGS is the one device-verify parses, with the same number',
  ev.length === 1 && ev[0].dropped === b.ret, JSON.stringify(b.log));

const r = S['reply-only'] || {};
ok('reply-only (mic off): the reply queue is emptied', r.reply === 0 && r.ret === 9, JSON.stringify({ reply: r.reply, ret: r.ret }));
ok('reply-only: its track is flushed', JSON.stringify(r.playTrack) === '["pause","flush","play"]', JSON.stringify(r.playTrack));

const n = S['no-tracks'] || {};
ok('no tracks yet: the queues still clear and nothing throws', n.err === null && n.play === 0 && n.ret === 3, JSON.stringify(n));

const t = S['track-throws'] || {};
ok('a track that throws does not take the Stop down', t.err === null, t.err);
ok('and the OTHER track is still flushed', JSON.stringify(t.playTrack) === '["pause","flush","play"]', JSON.stringify(t.playTrack));
ok('and the queues are still cleared', t.play === 0 && t.reply === 0);

const p = S['track-paused'] || {};
ok('an already-paused track is flushed without a redundant pause', JSON.stringify(p.track) === '["flush","play"]', JSON.stringify(p.track));

const rp = S.repad || {};
ok('mid-reply a frame is NOT treated as a new burst (control)', rp.mid === false, JSON.stringify(rp));
ok('the reply AFTER a Stop re-pads, even 10ms later', rp.after === true, JSON.stringify(rp));

console.log('\n  Stubs are not Android: that flush() empties the hardware buffer, and that the room goes');
console.log('  quiet, is still the handset\'s.');
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
