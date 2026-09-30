/**
 * java-phone — the app's SHIPPED audio path, compiled from AgentChannelPlugin.java and run on
 * this Mac as a process the simulated channel can drive.
 *
 * WHY. "Muting silences the mic" and "Stop goes quiet" were filed as the handset's. Most of the
 * path is not: between the wire and the speaker (decodePlay → replyQueue → the reply thread →
 * AudioTrack.write, and the Stop flush) and between the microphone and the wire (encodeLoop →
 * seal → outbound, and setMicMuted) the code is ours, and it is plain Java. So the bodies are
 * lifted out of the shipped source — the text the APK is built from — and compiled with the
 * real Concentus Opus codec from the Gradle cache. Only the Android classes underneath are
 * stubbed, and the stubs model Android's DOCUMENTED contract rather than our expectations:
 *
 *   AudioTrack   a bounded hardware buffer (the size the code asks for) drained one 20ms frame
 *                at a time by a playback clock; write() BLOCKS while it is full, as MODE_STREAM
 *                does; flush() discards the buffer and is a no-op on a PLAYING track, as the
 *                AudioTrack docs say. What the clock drains is what the room hears — recorded.
 *   AudioRecord  a microphone in a room with a 440 Hz tone in it, paced at real time. In mode
 *                `ignore` it keeps hearing the tone whatever AudioManager says — the WORST case,
 *                hardware that does not honour setMicrophoneMute. In `honor` it goes silent.
 *   AudioManager records the mute call and exposes it as mMicMute.
 *   KoCrypto     seal() is the identity; the sim client does the real AEAD on the wire.
 *
 * Protocol on stdin:  A <b64 plaintext audio frame>   (what onFrame hands decodePlay)
 *                     C <json d of a control reply>    (what onFrame hands noteControlReply)
 *                     STOP  |  MICTOGGLE  |  MICSTART  |  DUMP  |  QUIT
 * On stdout:          UP <b64 plaintext uplink frame> | L <logcat line> | ST <json> | SPK <json>
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { methodBody } from './java-facts.mjs';

export const PLUGIN = new URL('../../android/app/src/main/java/com/agentmobile/agent/AgentChannelPlugin.java', import.meta.url).pathname;

export function concentusJar() {
  const base = join(homedir(), '.gradle/caches/modules-2/files-2.1/io.github.jaredmdobson/concentus');
  const r = spawnSync('find', [base, '-name', 'concentus-*.jar'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).sort().pop() || null;
}

const SHIPPED = [
  ['void decodePlay(byte[] pl)', 'decodePlay'],
  ['boolean beginReplyBurst()', 'beginReplyBurst'],
  ['void enqueuePreRoll(LinkedBlockingQueue<short[]> q)', 'enqueuePreRoll'],
  ['synchronized void ensureReplyPlayback()', 'ensureReplyPlayback'],
  ['int flushPlaybackActual()', 'flushPlaybackActual'],
  ['boolean stopGated()', 'stopGated'],
  ['void noteControlReply(JSONObject d)', 'noteControlReply'],
  ['void flushTrack(AudioTrack t)', 'flushTrack'],
  ['public void setMicMuted(boolean muted)', 'setMicMuted'],
  ['public void nativeToggleMic()', 'nativeToggleMic'],
  ['void notifyAudioState()', 'notifyAudioState'],
  ['void encodeLoop()', 'encodeLoop'],
  ['void emitMicLevel(int lvl)', 'emitMicLevel'],
  ['int rmsLevel(short[] pcm)', 'rmsLevel'],
  ['static void writeU32(byte[] b, int o, long v)', 'writeU32'],
  ['static void writeU64(byte[] b, int o, long v)', 'writeU64'],
];

const constant = (src, name) => {
  const m = new RegExp(`static final (?:int|long) ${name}\\s*=\\s*(\\d+)`).exec(src);
  if (!m) throw new Error(`constant ${name} not found in the shipped source`);
  return Number(m[1]);
};

/** The generated source, from the CURRENT shipped file. */
export function phoneSource(src = readFileSync(PLUGIN, 'utf8')) {
  const missing = [];
  const methods = SHIPPED.map(([sig, name]) => {
    const b = methodBody(src, name);
    if (b === null) missing.push(name);
    return `  ${sig} {${b}}`;
  }).join('\n');
  if (missing.length) throw new Error(`not in the shipped source: ${missing.join(', ')}`);
  const RATE = constant(src, 'AUDIO_RATE'), FRAME = constant(src, 'AUDIO_FRAME');
  const PREROLL = constant(src, 'REPLY_PREROLL');
  const GATE = constant(src, 'STOP_GATE_MAX_MS'), QUIET = constant(src, 'STOP_GATE_QUIET_MS');
  return `
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import io.github.jaredmdobson.OpusApplication;
import io.github.jaredmdobson.OpusDecoder;
import io.github.jaredmdobson.OpusEncoder;

class Clock { static final long T0 = System.nanoTime(); static long ms() { return (System.nanoTime() - T0) / 1000000L; } }
class Out { static synchronized void line(String s) { System.out.println(s); System.out.flush(); } }
class SystemClock { static long elapsedRealtime() { return Clock.ms() + 100000L; } }
class Log {
  static int i(String t, String m) { Out.line("L I " + t + ": " + m); return 0; }
  static int w(String t, String m) { Out.line("L W " + t + ": " + m); return 0; }
  static int w(String t, String m, Throwable e) { return w(t, m + " " + e); }
  static int e(String t, String m) { Out.line("L E " + t + ": " + m); return 0; }
  static int e(String t, String m, Throwable e) { return e(t, m + " " + e); }
}
/* org.json, as much of it as noteControlReply reads: a flat boolean lookup. */
class JSONObject { final String s; JSONObject(String s) { this.s = s; }
  boolean optBoolean(String k, boolean d) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\"" + k + "\\"\\s*:\\s*(true|false)").matcher(s);
    return m.find() ? Boolean.parseBoolean(m.group(1)) : d; } }
class JSObject { final Map<String, Object> m = new HashMap<>(); JSObject put(String k, Object v) { m.put(k, v); return this; } }
class AudioAttributes { static final int USAGE_MEDIA = 1, USAGE_VOICE_COMMUNICATION = 2, CONTENT_TYPE_SPEECH = 1;
  static class Builder { Builder setUsage(int u) { return this; } Builder setContentType(int c) { return this; }
    AudioAttributes build() { return new AudioAttributes(); } } }
class AudioFormat { static final int CHANNEL_OUT_MONO = 4, CHANNEL_IN_MONO = 16, ENCODING_PCM_16BIT = 2;
  static class Builder { Builder setSampleRate(int r) { return this; } Builder setEncoding(int e) { return this; }
    Builder setChannelMask(int c) { return this; } AudioFormat build() { return new AudioFormat(); } } }
class AudioManager { static final int AUDIO_SESSION_ID_GENERATE = 0; static volatile boolean hwMute;
  void setMicrophoneMute(boolean m) { hwMute = m; Out.line("ST {\\"mMicMute\\":" + m + "}"); } }
class Context { static final String AUDIO_SERVICE = "audio"; final AudioManager am = new AudioManager();
  Object getSystemService(String n) { return AUDIO_SERVICE.equals(n) ? am : null; } }
class Activity { void runOnUiThread(Runnable r) { r.run(); } }
class KoCrypto { static final int TYPE_AUDIO = 2; static class Channel { byte[] seal(int t, byte[] pl) { return pl; } } }
class UdpMedia { void sendFrame(int k, long s, long t, byte[] o) {} }

/* The speaker. Frames written sit in a bounded hardware buffer; a clock drains one per 20ms
 * while PLAYING. What it drains is what the room hears, with the time it was heard. */
class AudioTrack {
  static final int PLAYSTATE_STOPPED = 1, PLAYSTATE_PAUSED = 2, PLAYSTATE_PLAYING = 3, MODE_STREAM = 1;
  static final List<long[]> HEARD = Collections.synchronizedList(new ArrayList<>());
  static int getMinBufferSize(int r, int c, int e) { return 3840; }
  final ArrayDeque<short[]> hw = new ArrayDeque<>(); final int cap; volatile int state = PLAYSTATE_STOPPED;
  volatile boolean released;
  AudioTrack(AudioAttributes a, AudioFormat f, int bytes, int mode, int session) {
    cap = Math.max(1, bytes / (2 * ${FRAME}));
    Thread dac = new Thread(() -> {
      long next = System.nanoTime();
      while (!released) {
        next += 20_000_000L; long w = next - System.nanoTime();
        if (w > 0) { try { Thread.sleep(w / 1000000L, (int) (w % 1000000L)); } catch (InterruptedException e) { return; } }
        short[] fr = null;
        synchronized (this) { if (state == PLAYSTATE_PLAYING) { fr = hw.poll(); notifyAll(); } }
        if (fr != null) { long s = 0; for (short v : fr) s += (long) v * v;
          long rms = Math.round(Math.sqrt((double) s / Math.max(1, fr.length))); if (rms > 0) HEARD.add(new long[] { Clock.ms(), rms }); }
      }
    }, "dac"); dac.setDaemon(true); dac.start();
  }
  int getPlayState() { return state; }
  synchronized void play() { state = PLAYSTATE_PLAYING; notifyAll(); }
  synchronized void pause() { state = PLAYSTATE_PAUSED; }
  synchronized void stop() { state = PLAYSTATE_STOPPED; hw.clear(); }
  void release() { released = true; }
  void setVolume(float v) {}
  synchronized void flush() { if (state != PLAYSTATE_PLAYING) hw.clear(); }
  int write(short[] a, int off, int len) {
    short[] c = Arrays.copyOfRange(a, off, off + len);
    synchronized (this) {
      while (hw.size() >= cap && state == PLAYSTATE_PLAYING && !released) { try { wait(50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return 0; } }
      hw.add(c);
    }
    return len;
  }
}

/* The microphone, in a room with a tone in it. */
class AudioRecord {
  static volatile boolean honorMute;
  long next = 0; int phase = 0;
  int read(short[] pcm, int off, int n) {
    if (next == 0) next = System.nanoTime();
    next += (long) n * 1_000_000_000L / ${RATE}; long w = next - System.nanoTime();
    if (w > 0) { try { Thread.sleep(w / 1000000L, (int) (w % 1000000L)); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return 0; } }
    boolean silent = honorMute && AudioManager.hwMute;
    for (int i = 0; i < n; i++) { pcm[off + i] = silent ? 0 : (short) (8000 * Math.sin(2 * Math.PI * 440 * (phase++) / ${RATE})); }
    return n;
  }
}

public class PhoneAudio {
  private static final int AUDIO_RATE = ${RATE};
  private static final int AUDIO_FRAME = ${FRAME};
  private static final int REPLY_PREROLL = ${PREROLL};
  public interface AudioSink { void onAudio(boolean running); }
  private volatile boolean connected = true;
  private volatile boolean destroying;
  private volatile boolean micMuted;
  private volatile AudioSink audioSink;
  private final AtomicLong audioSeq = new AtomicLong();
  private final AtomicLong mediaSeq = new AtomicLong();
  private volatile UdpMedia media;
  private volatile boolean udpUp;
  private volatile short[] lastReplyPcm;
  private final short[] pcmOut = new short[AUDIO_FRAME];
  private final LinkedBlockingQueue<short[]> playQueue = new LinkedBlockingQueue<>();
  private final LinkedBlockingQueue<short[]> replyQueue = new LinkedBlockingQueue<>();
  private volatile long lastReplyEnqMs;
  private long decoded;
  private long lvlFrames = 0;
  private volatile AudioRecord recorder;
  private volatile AudioTrack track;
  private volatile OpusEncoder encoder;
  private volatile OpusDecoder decoder;
  private volatile boolean audioRunning;
  private volatile AudioTrack playTrack;
  private volatile OpusDecoder playDecoder;
  private volatile Thread replyThread;
  private volatile long replyActiveUntil;
  private volatile long stopGateUntil;
  private volatile long stopGateLastDrop;
  private static final long STOP_GATE_MAX_MS = ${GATE};
  private static final long STOP_GATE_QUIET_MS = ${QUIET};
  private volatile KoCrypto.Channel channel = new KoCrypto.Channel();
  private final Context ctx = new Context();
  Context getContext() { return ctx; }
  Activity getActivity() { return null; }
  void notifyListeners(String ev, JSObject o) {}
  private synchronized void outbound(byte[] frame) { Out.line("UP " + Base64.getEncoder().encodeToString(frame)); }

  /* ---- SHIPPED, verbatim from AgentChannelPlugin.java ---- */
${methods}
  /* ---- end shipped ---- */

  public static void main(String[] a) throws Exception {
    AudioRecord.honorMute = a.length > 0 && "honor".equals(a[0]);
    PhoneAudio p = new PhoneAudio();
    p.audioSink = (running) -> Out.line("ST {\\"micLive\\":" + running + "}");
    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
    String l;
    while ((l = in.readLine()) != null) {
      if (l.startsWith("A ")) p.decodePlay(Base64.getDecoder().decode(l.substring(2)));
      else if (l.equals("STOP")) { long t = Clock.ms(); int d = p.flushPlaybackActual(); Out.line("ST {\\"stopAt\\":" + t + ",\\"dropped\\":" + d + "}"); }
      else if (l.equals("MICTOGGLE")) p.nativeToggleMic();
      else if (l.startsWith("C ")) p.noteControlReply(new JSONObject(l.substring(2)));
      else if (l.equals("MARK")) Out.line("ST {\\"markAt\\":" + Clock.ms() + "}");
      else if (l.equals("MICSTART")) {
        p.encoder = new OpusEncoder(AUDIO_RATE, 1, OpusApplication.OPUS_APPLICATION_VOIP);
        p.recorder = new AudioRecord(); p.audioRunning = true;
        Thread t = new Thread(p::encodeLoop, "encode"); t.setDaemon(true); t.start();
      }
      else if (l.equals("DUMP")) {
        StringBuilder b = new StringBuilder("SPK {\\"now\\":" + Clock.ms() + ",\\"heard\\":[");
        synchronized (AudioTrack.HEARD) { for (int i = 0; i < AudioTrack.HEARD.size(); i++) {
          long[] h = AudioTrack.HEARD.get(i); if (i > 0) b.append(','); b.append('[').append(h[0]).append(',').append(h[1]).append(']'); } }
        Out.line(b.append("]}").toString());
      }
      else if (l.equals("QUIT")) break;
    }
    System.exit(0);
  }
}
`;
}

/** Compile into a fresh directory. @returns {{dir, cp, ok, err}} */
export function buildPhone({ src } = {}) {
  const jar = concentusJar();
  if (!jar) return { ok: false, err: 'Concentus jar not in the Gradle cache (build the APK once)' };
  const dir = mkdtempSync(join(tmpdir(), 'java-phone-'));
  let source;
  try { source = phoneSource(src); } catch (e) { return { ok: false, err: e.message }; }
  writeFileSync(join(dir, 'PhoneAudio.java'), source);
  const c = spawnSync('javac', ['-nowarn', '-cp', jar, '-d', join(dir, 'out'), join(dir, 'PhoneAudio.java')],
    { encoding: 'utf8', timeout: 180000 });
  if (c.status !== 0) return { ok: false, err: c.stderr || 'javac failed', dir };
  return { ok: true, dir, cp: `${join(dir, 'out')}:${jar}` };
}

export const haveJava = () => existsSync('/usr/bin/java') || spawnSync('java', ['-version']).status === 0;
