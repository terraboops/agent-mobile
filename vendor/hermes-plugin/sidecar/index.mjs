#!/usr/bin/env node
// agentmob sidecar — the phone-facing encrypted transport edge for the Hermes
// platform adapter. Reuses the validated agent-mobile AEAD/Opus wire protocol
// (agent-mobile/proto.js + transport/wsframes.js) so no bespoke crypto is
// rewritten and the Android app keeps working unchanged.
//
// Responsibilities:
//   * WS server on AGENTMOB_PORT — the phone connects here.
//   * Mutual X25519 + ChaCha20-Poly1305 handshake via proto.js (PROTOCOL v2:
//     persistent server identity, transcript MAC, client confirm, per-host client
//     allowlist / pairing mode; type byte AAD + per-stream anti-replay in the channel).
//   * Text commands (the app's `__agent.send`) -> relayed to Python as a
//     "turn"; the agent's reply returns as a reply to that command id.
//   * Opus audio frames -> buffered per utterance, decoded to a 16k mono WAV
//     via ffmpeg, then handed to Python for speech-to-text (faster-whisper).
//   * Loopback TCP control socket (AGENTMOB_SIDECAR_PORT / token) to the
//     Hermes adapter — NDJSON both ways.
//
// Env:
//   AGENTMOB_PORT            phone-facing WS port (default 8123). IS the service: if it is
//                            already in use this process logs a named FATAL and exits 69.
//   AGENTMOB_BIND            bind address (default 0.0.0.0)
//   AGENTMOB_SIDECAR_PORT    loopback ctl port to the adapter (default 8790). NOTE the name —
//                            it is NOT AGENTMOB_CTL_PORT. Optional: if it is taken, the
//                            sidecar keeps serving the phone without the ctl channel.
//   AGENTMOB_SIDECAR_TOKEN   shared secret for that ctl socket
//   AGENTMOB_ALLOWED_CLIENTS comma-separated client ids/SPKIs. UNSET = pairing mode (any
//                            client). Pinning a stale id locks the phone out.
//   AGENTMOB_ICE             comma-separated stun:/turn: urls ('-'/'none' = no ICE). Unset =
//                            a public STUN default. TURN may carry inline credentials:
//                            turn:user:pass@host:3478
//   AGENTMOB_NO_TAILNET_ICE  1 = do not advertise this host's tailnet address as an ICE host
//                            candidate (it is advertised by default; a REMOTE phone needs it)
//   AGENTMOB_ICE_DEADLINE_MS how long after the answer before declaring ICE failed (20000)
//   AGENTMOB_NO_PARENT_WATCH 1 = disable the parent-death watchdog.
//
// >>> RUNNING THIS BY HAND <<<
// Normally the Hermes adapter spawns and owns this process. If you start it yourself from a
// shell, know that it EXITS as soon as its parent goes away (it watches for being reparented
// to init). That watchdog exists so a killed gateway cannot leave an orphan holding the port —
// but it also means backgrounding it and closing the terminal kills it. For a long-lived
// manual run, set AGENTMOB_NO_PARENT_WATCH=1:
//
//   AGENTMOB_NO_PARENT_WATCH=1 AGENTMOB_PORT=8899 AGENTMOB_SIDECAR_PORT=8898 node index.mjs
//
// Use a spare port too, or you will collide with the sidecar the gateway is already running.

import { WebSocketServer } from '/Users/terra/Developer/agent-mobile/node_modules/ws/wrapper.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, networkInterfaces as osNetworkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { genIdentity, identityId, serverHandshake, verifyConfirm, PROTO_VERSION } from '/Users/terra/Developer/agent-mobile/proto.js';
import { fileURLToPath } from 'node:url';
import { pack, unpack, T, unpackAudio } from '/Users/terra/Developer/agent-mobile/transport/wsframes.js';
import { UdpMedia } from '/Users/terra/Developer/agent-mobile/transport/udp-media.js';
import { createWebRtcSignal } from './webrtc-media.mjs';
import { sendFrame, wsState } from './wire.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const OpusScript = require('opusscript'); // wasm libopus: raw packet decode (no compiler/native)
const { WebRtcPeer } = createWebRtcSignal();
// WebRTC audio is negotiated at 48 kHz; our VAD + reply-pcm pipeline is 24 kHz.
const wrtcEnc48 = new OpusScript(48000, 1);   // downlink reply encoder
const wrtcDec48 = new OpusScript(48000, 1);   // uplink phone decoder
const WEBRTC_PREROLL = 8; // 8 x 20ms = 160ms silence before each reply, so the
// phone's WebRTC renderer is running before the first speech syllable arrives
// (otherwise the track's startup latency cuts the beginning of the greeting).
function up48(pcm24) { // 480 smp @24k -> 960 smp @48k, linear interpolation
  // (benchmark: sample-hold [old] adds a zero-order-hold comb and halves the
  // repeat band; linear interpolation between neighbours is the minimum clean
  // resampler and audibly removes the coarse "garbled/robotic" tint.)
  const n = pcm24.length / 2; const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const x0 = pcm24.readInt16LE(i * 2);
    const x1 = (i + 1 < n) ? pcm24.readInt16LE((i + 1) * 2) : x0;
    out.writeInt16LE(x0, i * 4);                // even sample = original
    out.writeInt16LE((x0 + x1) >> 1, i * 4 + 2); // odd sample = linear midpoint
  }
  return out;
}
function down24(pcm48) { // 960 smp @48k -> 480 smp @24k
  // Naive decimate-by-picking (old) aliases the 12-24 kHz band into speech
  // (Nyquist = 12k) and degrades the VAD/whisper uplink. Baseline practice is a
  // low-pass BEFORE decimation; use the minimal half-band [1,2,1]/4 then /2.
  const nin = pcm48.length / 2;              // 960 samples @48k (20ms)
  const nout = nin / 2;                       // 480 samples @24k
  const out = Buffer.alloc(nout * 2);
  for (let m = 0; m < nout; m++) {
    const b = 2 * m;
    const x0 = pcm48.readInt16LE((b === 0 ? 0 : b - 1) * 2);
    const x1 = pcm48.readInt16LE(b * 2);
    const x2 = pcm48.readInt16LE(Math.min(b + 1, nin - 1) * 2);
    out.writeInt16LE((x0 + (x1 << 1) + x2) >> 2, m * 2); // /4, integer
  }
  return out;
}
function softenPeaks(pcm24) { // keep peaks ~ -1.4 dBFS (0.85 fs): headroom so the
  // opus encoder + downstream never hard-clip a full-scale (0 dBFS) TTS peak,
  // which is a common cause of harsh/garbled render. Only scales DOWN.
  let peak = 0;
  for (let i = 0; i < pcm24.length; i += 2) { const v = Math.abs(pcm24.readInt16LE(i)); if (v > peak) peak = v; }
  const cap = Math.round(32767 * 0.85);
  if (peak <= cap) return pcm24;
  const g = cap / peak;
  const out = Buffer.alloc(pcm24.length);
  for (let i = 0; i < pcm24.length; i += 2) {
    const v = Math.round(pcm24.readInt16LE(i) * g);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
  }
  return out;
}

const PORT = Number(process.env.AGENTMOB_PORT || 8123);
const BIND = process.env.AGENTMOB_BIND || '0.0.0.0';
const CTL_PORT = Number(process.env.AGENTMOB_SIDECAR_PORT || 8790);
const TOKEN = process.env.AGENTMOB_SIDECAR_TOKEN || 'dev';
const SILENCE_MS = 5000; // end-of-utterance pause before the agent responds (user trails off)
// Mean-absolute PCM amplitude (16-bit) above which a 20ms frame counts as
// speech. Voice in a typical room sits far above ambient noise here.
const SPEECH_RMS = 700;
// Consecutive speech frames required before an utterance actually starts.
// Filters ambient noise blips (1-3 frames) so we don't STT silence.
const MIN_SPEECH_FRAMES = 6;
// Absolute cap on one utterance before we force a flush (10s of captured audio).
const MAX_UTTERANCE_MS = 30000; // safety cap, NOT a sentence cut-off (was 10s)
// A valid utterance must contain at least this much real speech (~0.4s).
// Shorter "utterances" are ambient noise blips that faster-whisper happily
// hallucinates into confident nonsense ("mishearing") — reject them.
const MIN_FLUSH_FRAMES = 20;
// Onset pre-roll: a bounded ring that keeps low-energy leading consonants ("TH" in
// "three", which sit just under the VAD `speech` threshold) so the first syllable is
// never clipped into "REE". Cleared only after a real silence gap.
const PRE_ROLL_FRAMES = 9;   // ~180ms
const TRAIL_FRAMES = 10;     // trailing non-speech frames appended inside one utterance (~200ms of word pause)
// ---------------------------------------------------------------------------
// Bridge to the Hermes adapter (NDJSON over loopback TCP)
// ---------------------------------------------------------------------------
let bridge = null;
const queued = [];
let pcmEncoder = null; // opusscript encoder for outbound reply audio
function toBridge(evt) {
  const line = JSON.stringify(evt) + '\n';
  if (bridge && !bridge.destroyed) bridge.write(line);
  else queued.push(line);
  log(`→ bridge ${JSON.stringify(evt)}`);
}
function flushQueued() {
  while (bridge && !bridge.destroyed && queued.length) bridge.write(queued.shift());
}

// Parent-death watchdog.
//
// The adapter reaps us on every shutdown path it can intercept, but it cannot intercept a
// SIGKILL of the gateway — and an orphan that keeps holding :8123 is what blocks the NEXT
// sidecar from ever starting. So we also watch from this side: when our parent dies we are
// reparented to init (ppid 1), which is unambiguous and costs one syscall every few seconds.
//
// Exit 0: being reaped with our parent is orderly shutdown, not a failure.
// Set AGENTMOB_NO_PARENT_WATCH=1 when running the sidecar by hand from a shell you intend to
// close (the tests spawn it from a live parent, so they are unaffected).
if (!/^(1|true|yes)$/i.test(process.env.AGENTMOB_NO_PARENT_WATCH || '')) {
  const startPpid = process.ppid;
  const watch = setInterval(() => {
    let ppid;
    try { ppid = process.ppid; } catch { return; }
    if (ppid === 1 || (startPpid !== 1 && ppid !== startPpid)) {
      log(`parent process ${startPpid} is gone (ppid now ${ppid}) — exiting so the port is not `
        + `left held by an orphan`);
      clearInterval(watch);
      process.exit(0);
    }
  }, 2000);
  if (watch.unref) watch.unref();
}

const ctl = createServer((sock) => {
  let authed = false, buf = '';
  sock.setNoDelay(true);
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    if (!authed) {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      if (buf.slice(0, nl).trim() !== TOKEN) { sock.destroy(); return; }
      buf = buf.slice(nl + 1);
      authed = true;
      bridge = sock;
      sock.on('close', () => { if (bridge === sock) bridge = null; });
      flushQueued();
      // FALL THROUGH — do not return. TCP does not preserve write boundaries, so a message
      // written straight after the token arrives in the SAME segment. Returning here left it
      // sitting in `buf` unparsed until some later message happened to arrive. The adapter
      // flushes its queued replies immediately after authenticating, so that is exactly the
      // shape of the real traffic: a reply held across a sidecar restart was written, accepted
      // by the socket, and then silently never processed.
    }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      handleBridgeMessage(m);
    }
  });
});

// ---------------------------------------------------------------------------
// Phone connections
// ---------------------------------------------------------------------------
const connections = new Set(); // { ws, channel, pending:Set, opusChunks, deadline }

const wss = new WebSocketServer({ port: PORT, host: BIND });

// An unhandled 'error' on this server kills the process with a raw stack — and the adapter
// respawns us every 3s, so the log fills with identical stack traces and nothing says WHY.
// That is the same shape as the ctl-port bug fixed below, but it bites harder: this IS the
// service, so we cannot "continue without it".
//
// EADDRINUSE here almost always means a STALE sidecar still owns the port. That is a real
// state, not a hypothetical: a gateway stop does NOT take the sidecar with it — `launchctl
// bootout` leaves it orphaned and still listening on 8123, which is exactly how this was
// found. Exiting with a named reason lets the adapter's existing respawn act as the retry, so
// the moment the orphan goes away the next respawn succeeds.
wss.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`FATAL: port ${PORT} is already in use on ${BIND} — another agentmob sidecar is still `
      + `listening (most likely an orphan: stopping the gateway does NOT stop the sidecar). `
      + `This instance cannot serve the phone, so it is exiting; the adapter will respawn and `
      + `retry, and will succeed once the stale process is gone. To clear it by hand: `
      + `lsof -nP -iTCP:${PORT} -sTCP:LISTEN   then   pkill -f agentmob/sidecar/index.mjs`);
    process.exit(69);            // EX_UNAVAILABLE — the port, not the code, is the problem
  }
  log(`FATAL: websocket server error on ${BIND}:${PORT} — ${(e && e.code) || ''} `
    + `${(e && e.message) || e}`);
  process.exit(71);              // EX_OSERR — something else went wrong at the socket layer
});

// PERSISTENT server identity. Under protocol v2 the phone PINS this key on first
// pairing; a fresh key each process start would look like an impostor after every
// restart (phone shows IDENTITY MISMATCH and refuses). Stored base64 (der) in a
// gitignored file next to the sidecar, 0600. Override path with AGENTMOB_IDENTITY_FILE.
const IDENTITY_FILE = process.env.AGENTMOB_IDENTITY_FILE
  || fileURLToPath(new URL('./.identity.json', import.meta.url));
function loadOrCreateIdentity() {
  try {
    if (existsSync(IDENTITY_FILE)) {
      const j = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
      if (j && j.publicKey && j.privateKey) {
        return { publicKey: Buffer.from(j.publicKey, 'base64'), privateKey: Buffer.from(j.privateKey, 'base64') };
      }
    }
  } catch (e) { log(`identity load failed (${e.message}); regenerating`); }
  const id = genIdentity();
  try {
    writeFileSync(IDENTITY_FILE, JSON.stringify({
      publicKey: id.publicKey.toString('base64'), privateKey: id.privateKey.toString('base64'),
    }), { mode: 0o600 });
    chmodSync(IDENTITY_FILE, 0o600);
  } catch (e) { log(`WARNING: could not persist identity to ${IDENTITY_FILE}: ${e.message}`); }
  return id;
}
const identity = loadOrCreateIdentity();

// Client allowlist. AGENTMOB_ALLOWED_CLIENTS = comma-separated client ids (8 hex) and/or
// SPKI base64. Empty -> PAIRING MODE: accept any client and log its id so it can be pinned.
const _allowSet = new Set((process.env.AGENTMOB_ALLOWED_CLIENTS || '')
  .split(',').map((x) => x.trim()).filter(Boolean));
const clientAllow = _allowSet.size
  ? (pub, id) => _allowSet.has(id) || _allowSet.has(Buffer.from(pub).toString('base64'))
  : null;

// ICE servers advertised to the phone (hello `ice`) AND used by the sidecar's own WebRTC
// peer. AGENTMOB_ICE = comma-separated stun:/turn: urls (set '-' or 'none' to force NO ICE).
// DEFAULT: a public STUN server. Android libwebrtc does NOT enumerate the Tailscale
// userspace-TUN 100.x as a host candidate, so with zero ICE servers the phone's ICE stalls
// at `connecting` and never connects -> no mic uplink, no voice downlink (regression the
// H4 "no STUN" change caused; confirmed in agent.log: `webrtc st connecting -> closed`).
// STUN here is discovery-only (no relay); point AGENTMOB_ICE at a tailnet STUN to stay
// fully egress-free. (The webview can't touch WebRTC at all — that egress path is closed
// separately by the CSP + sandbox realm hardening, unaffected here.)
//
// A TURN entry may carry credentials inline: turn:user:pass@host:3478[?transport=tcp].
// They are split off here because RTCIceServer wants them as separate fields, and because a
// url with an embedded password must never be logged or handed to the phone verbatim.
const _iceRaw = process.env.AGENTMOB_ICE;
const _parseIce = (raw) => raw.split(',').map((x) => x.trim())
  .filter((u) => /^(stun|turn|turns):/.test(u))
  .map((u) => {
    const m = u.match(/^(turns?):([^:@/]+):([^@]*)@(.+)$/i);
    if (!m) return { urls: u };
    return { urls: `${m[1]}:${m[4]}`, username: m[2], credential: m[3] };
  });
const ICE_SERVERS = (_iceRaw === undefined || _iceRaw === '')
  ? [{ urls: 'stun:stun.l.google.com:19302' }]      // STUN-only stays the default
  : (/^(-|none)$/i.test(_iceRaw.trim()) ? [] : _parseIce(_iceRaw));
// What the phone is told, and what gets logged: never the credential.
const ICE_URLS = ICE_SERVERS.map((s) => (Array.isArray(s.urls) ? s.urls[0] : s.urls));

// The tailnet address, gathered as an ADDITIONAL host candidate.
//
// Neither side enumerates it on its own: the Tailscale interface is a point-to-point utun,
// which ICE host-candidate enumeration skips (the phone's Android libwebrtc has the same blind
// spot — see above). So a REMOTE phone sees only this Mac's LAN candidate, which it cannot
// route to, and a STUN srflx candidate that only works if both NATs cooperate. When Tailscale
// itself reports "direct connection not established" it has already failed to punch that NAT,
// and WebRTC has no DERP to fall back on — ICE stalls at `connecting` and the downlink
// silently falls back to the WebSocket.
//
// The phone CAN route 100.x through its own Tailscale, so advertising this address gives it a
// pair it can actually complete. 100.64.0.0/10 is the CGNAT range Tailscale allocates from.
// Set AGENTMOB_NO_TAILNET_ICE=1 to opt out.
function tailnetAddresses() {
  if (/^(1|true|yes)$/i.test(process.env.AGENTMOB_NO_TAILNET_ICE || '')) return [];
  const out = [];
  try {
    const ifs = osNetworkInterfaces();
    for (const addrs of Object.values(ifs)) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;
        const o = a.address.split('.').map(Number);
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) out.push(a.address);
      }
    }
  } catch (e) { log('tailnet ice lookup failed: ' + (e && e.message || e)); }
  return out;
}
const ICE_HOST_ADDRS = tailnetAddresses();
// Consecutive inbound frames whose handler threw before saying so loudly. Reset by one
// success, so an occasional bad frame stays a single line.
const RX_FAIL_ESCALATE = Number(process.env.AGENTMOB_RX_FAIL_ESCALATE || 5);
// How long after sending the answer to wait before declaring ICE a failure.
const ICE_DEADLINE_MS = Number(process.env.AGENTMOB_ICE_DEADLINE_MS || 20000);

/* FORCING THE WS FALLBACK, so the device run can exercise the path that hides a bug.
 *
 * The WebRTC downlink is PACED at 20ms/frame; the WS one is BURST (a setImmediate yield every
 * 128 frames). That difference is why Stop behaved differently on each: on WebRTC the phone's
 * queue is about one frame deep, on WS the whole remainder of a reply can already be sitting on
 * the device. The flush fix landed for the WS case, and a device run negotiates WebRTC — so the
 * run would exercise the easy path and report a pass over the case the fix was for.
 *
 * Two ways in, because they serve different callers:
 *   AGENTMOB_FORCE_WS_DOWNLINK=1  for a scoped instance or an e2e run, read once at startup
 *   a marker FILE next to this script for the live sidecar, which the device run creates and
 *     removes around the phase that needs it — no gateway restart, and reversible if the run
 *     dies holding it.
 *
 * Checked at most once a second: a reply is hundreds of frames and this must not become a stat
 * per frame. */
/* Overridable, so a second sidecar started from this directory for a test does not share the
 * LIVE sidecar's marker — forcing the test one would otherwise force this one too. */
const FORCE_WS_FILE = process.env.AGENTMOB_FORCE_WS_FILE
  || join(dirname(fileURLToPath(import.meta.url)), '.force-ws-downlink');
const FORCE_WS_ENV = /^(1|true|yes)$/i.test(process.env.AGENTMOB_FORCE_WS_DOWNLINK || '');
let _forceWsSeen = false;
let _forceWsAt = 0;
let _forceWs = FORCE_WS_ENV;
function forceWsDownlink() {
  const now = Date.now();
  if (now - _forceWsAt > 1000) {
    _forceWsAt = now;
    let onDisk = false;
    try { onDisk = existsSync(FORCE_WS_FILE); } catch { /* unreadable == not forced */ }
    _forceWs = FORCE_WS_ENV || onDisk;
  }
  /* Say it once, loudly. A forced fallback that nobody notices is a run whose result means
   * something other than what the reader thinks. */
  if (_forceWs && !_forceWsSeen) {
    _forceWsSeen = true;
    log(`WS DOWNLINK FORCED (${FORCE_WS_ENV ? 'env' : 'marker file'}) — WebRTC will NOT carry `
      + 'replies. This is a diagnostic mode: the WS path BURSTS a reply instead of pacing it.');
  }
  if (!_forceWs && _forceWsSeen) { _forceWsSeen = false; log('WS downlink no longer forced'); }
  return _forceWs;
}

log(`agent id ${identityId(identity)} ws://${BIND}:${PORT} ctl :${CTL_PORT} `
  + `[${clientAllow ? 'allowlist ' + _allowSet.size : 'PAIRING MODE — accepting any client'}]`
  + (ICE_URLS.length ? ` ice=${ICE_URLS.join(',')}` : '')
  + (ICE_HOST_ADDRS.length ? ` tailnet-ice=${ICE_HOST_ADDRS.join(',')}` : ' tailnet-ice=none'));

wss.on('connection', (ws) => {
  const conn = { ws, channel: null, pending: new Set(), frames: [], pre: [], deadline: null, firstTs: 0, tailing: false, decoder: null, pcmTimer: null, lastRxSeq: null, lost: 0, utteranceLossy: false, media: null, webrtc: null, webrtcSeq: 0 };
  connections.add(conn);
  log('phone connected');

  ws.on('message', (data) => {
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // --- protocol v2 handshake: hello -> reply(mac) -> confirm --------------
      if (!conn.channel) {
        let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; } // sealed frame pre-auth: ignore
        if (!conn.hs) {
          let hs;
          try { hs = serverHandshake(identity, msg, { allow: clientAllow }); }
          catch (e) {
            if (e.message === 'unknown_client') log(`REJECT unknown client ${msg && msg.client_id} (${msg && msg.client_identity})`);
            else log(`handshake reject: ${e.message}`);
            try { conn.ws.send(JSON.stringify({ v: PROTO_VERSION, error: e.message })); } catch {}
            try { conn.ws.close(4003, e.message); } catch {}
            return;
          }
          conn.hs = hs;
          if (!clientAllow) log(`PAIRING: client ${hs.clientId} identity=${hs.clientIdentity.toString('base64')} — add to AGENTMOB_ALLOWED_CLIENTS to pin`);
          // Bind the per-connection UDP media socket now so we can advertise its
          // port in the reply (audio moves off TCP onto UDP + adaptive jitter).
          startMedia(conn, hs.channel).then((mediaPort) => {
            if (conn.ws.readyState !== conn.ws.OPEN) return;
            // MUST be a TEXT frame (string): the Android client parses the reply as
            // JSON; a binary frame would be mis-routed into the sealed-frame handler.
            conn.ws.send(JSON.stringify(Object.assign({}, hs.reply, {
              media_port: mediaPort,
              ice: ICE_URLS,
            })));
          }).catch((e) => log(`media start err ${e.message}`));
          return;
        }
        // second text message must be the confirm MAC
        if (!verifyConfirm(conn.hs.expectedConfirm, msg)) {
          log(`handshake confirm FAILED for ${conn.hs.clientId}`);
          try { conn.ws.send(JSON.stringify({ v: PROTO_VERSION, error: 'bad_confirm' })); } catch {}
          try { conn.ws.close(4003, 'bad_confirm'); } catch {}
          return;
        }
        conn.channel = conn.hs.channel;
        conn.clientId = conn.hs.clientId;
        conn.hs = null;
        log(`handshake confirmed ${conn.clientId}`);
        return;
      }
      // --- authenticated frames ---------------------------------------------
      const { type, nonce, tag, ct } = unpack(buf);
      const ptb = conn.channel.recvBytes({ type, nonce, ct, tag }); // type is AAD; per-stream anti-replay
      if (ptb === null) { log('AEAD auth/replay FAILED'); return; }

      // A FAILING HANDLER IS NOT A BROKEN CHANNEL — the same rule the adapter's read loop
      // follows, and it matters more here: the adapter can rebuild its bridge in ~110ms, but
      // tearing down an AEAD channel costs the phone its whole SESSION (re-handshake, new
      // media socket, lost turn). So a frame the handler chokes on is dropped and the channel
      // is kept, deliberately.
      //
      // The dispatch is its own try for that reason. The outer catch below stays for the
      // handshake path above it, but it no longer doubles as a catch-all that reports every
      // failure as an indistinguishable 'rx err'.
      try {
        if (type === T.ping) ws.send(pack(T.pong, conn.channel.send(Buffer.alloc(0), T.pong)));
        else if (type === T.cmd) handleCmd(conn, ptb);
        else if (type === T.audio) handleAudio(conn, ptb);
        else {
          // Previously fell through in silence. The phone and the sidecar ship separately, so
          // a frame type this build does not know is a real way for them to drift apart.
          log(`rx: unknown frame type ${type} (${ptb.length}b) — dropped, channel kept. `
            + `The phone may be newer than this sidecar.`);
        }
        conn.rxFails = 0;
      } catch (e) {
        conn.rxFails = (conn.rxFails || 0) + 1;
        const where = (e && e.stack || '').split('\n')[1] || '';
        log(`rx handler FAILED on type ${type} (${(e && e.message) || e})${where ? ' at' + where : ''}`
          + ` — frame dropped, channel KEPT (${conn.rxFails} in a row)`);
        if (conn.rxFails === RX_FAIL_ESCALATE) {
          log(`RX HANDLER WEDGED: ${conn.rxFails} consecutive frames from ${conn.clientId} `
            + `failed to process. The phone is connected and the channel is healthy, but `
            + `nothing it sends is getting through — this is a handler bug, not a link problem.`);
        }
      }
    } catch (e) {
      // Reached only by the handshake/decode path above; dispatch has its own handler.
      log(`rx frame undecodable (${(e && e.message) || e}) — dropped, channel kept`);
    }
  });

  ws.on('close', () => {
    connections.delete(conn);
    if (conn.media) { try { conn.media.close(); } catch {} conn.media = null; }
    if (conn.webrtc) { try { conn.webrtc.close(); } catch {} conn.webrtc = null; }
    if (conn.deadline) clearTimeout(conn.deadline);
    if (conn.decoder) { try { conn.decoder.delete(); } catch {} conn.decoder = null; }
    log('phone disconnected');
  });
});

function handleCmd(conn, ptb) {
  let obj;
  try {
    obj = JSON.parse(ptb.toString('utf8'));
  } catch (e) {
    // Was a silent `return`. This payload decrypted and authenticated correctly, so it really
    // came from the paired phone — malformed JSON here means the two sides disagree about the
    // wire format, which is worth knowing and used to be invisible.
    log(`cmd payload is not JSON (${ptb.length}b, ${(e && e.message) || e}) — dropped`);
    return;
  }
  const { i, d } = obj;
  // Webrtc media control (SDP/candidate) — handled here, never relayed to the
  // agent loop as a message. The native send() encodes d as a quoted string, so
  // accept both the object and JSON-string forms on the wire.
  const _w = typeof d === 'object' ? d : (() => { try { return JSON.parse(d); } catch { return null; } })();
  if (_w && _w.cmd === 'webrtc') return handleWebrtc(conn, i, _w);
  // Reserved control: the phone can ask the current agent turn to stop.
  // We do NOT relay this into the agent loop as a message. The native send()
  // encodes d as a quoted string, so accept both the object and JSON-string
  // forms on the wire.
  const _isInterrupt = typeof d === 'object'
    ? Boolean(d && d.cmd === 'interrupt')
    : (typeof d === 'string' && /"cmd"\s*:\s*"interrupt"/.test(d));
  if (_isInterrupt) {
    toBridge({ type: 'interrupt' });
    // Stop an in-flight paced downlink so the phone stops hearing the (now
    // stale) reply within NetEQ's small buffer. Without this the rest of the
    // current reply kept playing after Stop.
    if (conn.pcmCancel) conn.pcmCancel.cancelled = true;
    const ack = pack(T.cmd, conn.channel.send(Buffer.from(
      JSON.stringify({ i, d: { type: 'text', text: 'Stopped.', interrupted: true } })), T.cmd));
    /* interrupted:true is the edge the app's Stop gate waits for: the WS channel is ordered, so
     * every reply frame sent before this point reaches the phone BEFORE this ack. */
    conn.ws.send(ack);
    log('→ phone interrupt ack');
    return;
  }
  // Render feedback from the webview host (docs/display-surface.md). It is a
  // DEVICE->AGENT signal, NOT a user turn: relay it as its own event so the
  // adapter can hand it back to the agent without dispatching or speaking it.
  const _dstr = typeof d === 'string' ? d : (typeof d === 'object' && d !== null ? JSON.stringify(d) : '');
  try {
    const jo = JSON.parse(_dstr);
    if (jo && jo.type === 'render_result') {
      toBridge({ type: 'render_result', i, key: jo.key, ok: !!jo.ok, error: jo.error });
      // Ack so the webview's send() promise resolves (no agent reply is expected).
      conn.ws.send(pack(T.cmd, conn.channel.send(Buffer.from(JSON.stringify({ i, d: { type: 'ack' } })), T.cmd)));
      log(`→ phone render_result ${jo.key}=${!!jo.ok}`);
      return;
    }
    // Surface STATE report — registers/types/widgets now on the phone. Device->agent
    // context so agents PUSH to existing keys instead of re-registering; not a turn.
    if (jo && jo.type === 'surface_state') {
      toBridge({ type: 'surface_state', state: (jo.state && typeof jo.state === 'object') ? jo.state : {} });
      conn.ws.send(pack(T.cmd, conn.channel.send(Buffer.from(JSON.stringify({ i, d: { type: 'ack' } })), T.cmd)));
      log('→ phone surface_state');
      return;
    }
  } catch { /* not JSON — falls through to a normal turn */ }
  conn.pending.add(i);
  toBridge({ type: 'turn', i, text: typeof d === 'string' ? d : JSON.stringify(d) });
  if (conn.deadline) { clearTimeout(conn.deadline); conn.deadline = null; }
  flushNow(conn);
}

// WebRTC media control channel. The phone drives an offer/answer over the SAME
// authenticated WS we already trust (DTLS fingerprints travel on it), then audio
// flows over DTLS-SRTP. Uplink opus -> the shared VAD; downlink reply opus ->
// writeReply. Pure add-on: if never invoked, the legacy WS/UDP path is untouched.
async function handleWebrtc(conn, i, w) {
  if (!conn.webrtc) {
    conn.webrtc = new WebRtcPeer(
      { onUtterance: (opus) => {
          // Phone sends 48 kHz opus; decode to 48k PCM, resample to the VAD's 24k.
          try {
            const p48 = wrtcDec48.decode(opus, 960, 's16');
            if (p48 && p48.length >= 1920) {
              // Live mic meter from the actual WebRTC uplink (same helper as the
              // legacy UDP/WS path; the phone uses this path almost always now).
              let _s = 0; for (let _i = 0; _i < p48.length; _i += 2) { const v = p48.readInt16LE(_i); _s += v < 0 ? -v : v; }
              maybeLevel(conn, _s / (p48.length / 2));
              // Feed one 20ms frame per VAD step (960 smp @48k = 1920 B). If a
              // packet decoded to multiple frames, slice so the 20ms cadence and
              // utterance framing stay correct.
              const FB = 1920;
              for (let off = 0; off + FB <= p48.length; off += FB) {
                feedUtteranceFrame(conn, { seq: conn.webrtcSeq++, tsMs: Date.now(), pcm: down24(p48.subarray(off, off + FB)), concealed: false });
              }
            }
          } catch { /* drop bad frame */ }
        },
        onState: (s) => {
          log('webrtc st ' + s);
          // Say it ONCE, loudly, when ICE gives up without ever connecting. Until now this
          // failure was only inferable by noticing that later replies carried a
          // "via WS (webrtc ready=false)" suffix — which is precisely how H3 stayed broken
          // unnoticed for weeks. A remote phone with no routable candidate fails exactly this
          // way, so it gets its own line instead of a silent downgrade.
          if (s === 'connected') {
            conn.webrtcEverConnected = true;
            if (conn.iceDeadline) { clearTimeout(conn.iceDeadline); conn.iceDeadline = null; }
            // WHICH PATH, not just that there is one. "connected" over a LAN pair and
            // "connected" over the tailnet look identical from here, and only one of them is
            // the thing this project claims. Logged once, on the transition.
            const np = conn.webrtc && conn.webrtc.nominatedPair && conn.webrtc.nominatedPair();
            log(np ? `webrtc ICE pair remote=${np.remote} local=${np.local || 'n/a'}`
                   : 'webrtc ICE pair unknown (werift did not expose a nominated pair)');
          }
          // Deliberately does NOT report a failure here. A transition to closed/failed is
          // indistinguishable from an ordinary disconnect — the phone backgrounding, or a
          // diagnostic probe hanging up — so reporting on it cries wolf every time. The
          // DEADLINE above is the honest detector: it asks "is ICE still not up while the
          // client is still here?", which only a real failure answers yes to.
        } },
      // ICE servers from AGENTMOB_ICE only (operator-controlled, e.g. a stun on the
      // tailnet); default none = host candidates over Tailscale/LAN. No third-party
      // STUN egress (matches the phone-side H4 fix). The phone gets the same list via
      // the hello `ice` field.
      { iceServers: ICE_SERVERS,
        // makes the tailnet address a host candidate the phone can route to
        iceAdditionalHostAddresses: ICE_HOST_ADDRS.length ? ICE_HOST_ADDRS : undefined }
    );
  }
  // A lost ack is worse than a lost status: the PHONE is waiting on this reply and will sit
  // through its timeout with no idea whether the host is slow, broken, or gone. Never quiet.
  const ack = (d) => {
    let frame;
    try {
      frame = pack(T.cmd, conn.channel.send(Buffer.from(JSON.stringify({ i, d })), T.cmd));
    } catch (e) {
      log(`ack i=${i} encrypt FAILED: ${(e && e.message) || e}`);
      return false;
    }
    return sendFrame(conn, frame, `ack i=${i}`, log);
  };
  try {
    if (w.sdp_type === 'offer' && w.sdp) {
      const ans = await conn.webrtc.handleOffer(w.sdp);
      ack({ webrtc: { rtype: 'answer', sdp: ans.sdp } });
      log(`webrtc answer sent opusPT=${conn.webrtc.opusPT}`);
      // Report the failure on a DEADLINE, not on a state transition. A peer with no routable
      // candidate does not transition to `failed` — it sits at `connecting` indefinitely, and
      // the transition to `closed` only arrives when the phone disconnects, long after every
      // reply has quietly gone out over the WS fallback. Measured: an offer carrying only an
      // unroutable candidate stayed at `connecting` for 60s with no further state at all.
      if (conn.iceDeadline) clearTimeout(conn.iceDeadline);
      conn.iceDeadline = setTimeout(() => {
        // A connection that has already gone away never had a chance to finish ICE, so calling
        // that a failure is a false alarm. It fires for every run of the ice-candidates probe,
        // which deliberately never applies the answer — and an alert that cries wolf on its own
        // diagnostic tooling is the fastest way to teach everyone to ignore it.
        if (!connections.has(conn)) return;
        if (!conn.webrtcFailLogged && !(conn.webrtc && conn.webrtc.ready)) {
          conn.webrtcFailLogged = true;
          log(`webrtc ICE FAILED (never reached connected) — voice falls back to WS/UDP. `
            + `ice=${ICE_URLS.join(',') || 'none'} tailnet-ice=${ICE_HOST_ADDRS.join(',') || 'none'}`);
        }
      }, ICE_DEADLINE_MS);
      if (conn.iceDeadline.unref) conn.iceDeadline.unref();
    } else if (w.sdp_type === 'candidate' && w.candidate) {
      conn.webrtc.addRemoteCandidate(w.candidate);
      ack({ webrtc: { rtype: 'candidate_ack' } });
    }
  } catch (e) {
    log('webrtc err ' + e.message);
    ack({ webrtc: { rtype: 'error', error: e.message } });
  }
}

const ZERO_FRAME = Buffer.alloc(960); // 480 samples @ 24k s16 = one silence frame

function decodeSpeech(conn, op) {
  if (!conn.decoder) conn.decoder = new OpusScript(24000, 1);
  const pcm = Buffer.from(conn.decoder.decode(op, 480, 's16')); // 960B = 480 LE s16
  let sum = 0;
  for (let i = 0; i < 480; i++) { const v = pcm.readInt16LE(i * 2); sum += v < 0 ? -v : v; }
  maybeLevel(conn, sum / 480); // live mic pickup meter -> phone status strip
  return { pcm, speech: sum / 480 > SPEECH_RMS };
}

// Deliver a { type:'status' } message to the phone (i=-1 push; the app's native
// 'message' listener routes it to the webview status strip). Transport-level
// signals live here (heartbeat, mic level); semantic ones (heard/working) come
// from the adapter over the same `push` channel.
function pushStatus(conn, d) {
  // quietWhenClosed: status runs several times a second while speaking, so a disconnected
  // phone would otherwise fill the log. The first drop and every 50th are still reported —
  // the point is that a dead socket never looks like a healthy one, not that it is silent.
  let frame;
  try {
    frame = pack(T.cmd, conn.channel.send(
      Buffer.from(JSON.stringify({ i: -1, d: Object.assign({ type: 'status' }, d) })), T.cmd));
  } catch (e) {
    // Encrypting failed — that is the channel, not the socket, and it is never routine.
    log(`status encrypt FAILED: ${(e && e.message) || e}`);
    return false;
  }
  return sendFrame(conn, frame, `status ${Object.keys(d || {}).join(',') || '(empty)'}`, log,
                   { quietWhenClosed: true });
}
const _lvlTs = new Map();
function maybeLevel(conn, mean) {
  const now = Date.now();
  if ((_lvlTs.get(conn) || 0) > now - 120) return; // throttle ~8/s while speaking
  _lvlTs.set(conn, now);
  // mean is average |amplitude| over 480 @24k (0..~15000 loud). Map onto 0..1.
  const level = Math.min(1, Math.round((mean / 13000) * 100) / 100);
  pushStatus(conn, { level });
}
// Heartbeat: proves the channel is alive and updates the phone's pulse dot at
// near-silent cost, independent of any agent activity.
setInterval(() => {
  for (const c of connections) {
    if (c.ws && c.ws.readyState === c.ws.OPEN && c.channel) pushStatus(c, { hb: true });
  }
}, 3000).unref();


function _arm(conn) {
  if (conn.deadline) clearTimeout(conn.deadline);
  conn.deadline = setTimeout(() => flushUtterance(conn), SILENCE_MS);
}

// Barge-in: while the agent's reply is still streaming downlink, a NEW user
// utterance onset means the user is talking over the reply. In the WebRTC
// uplink the mic is live during playback (AEC cancels the agent's own voice),
// so this onset is genuine speech, not the agent's echo. Match LiveKit's
// per-utterance cooperative interrupt: cancel the in-flight reply token AND
// forward an interrupt to the agent so it stops the current turn and the new
// user input becomes the next turn. Fires at most once per reply (the cancel
// token flips to cancelled, and a fresh reply installs a fresh token).
function maybeBargeIn(conn) {
  const tok = conn.pcmCancel;
  if (tok && !tok.cancelled) {
    tok.cancelled = true;               // stop the paced/burst downlink now
    toBridge({ type: 'interrupt' });    // signal the agent turn to stop too
    log('→ barge-in on user speech (cancel in-flight reply)');
  }
}

// Shared entry for WS and UDP media: feed one 20ms frame into the VAD. Frames
// are stored as decoded PCM, so a concealed (lost) frame becomes a silence
// frame and the utterance is flagged `lossy` (the agent is told the clip may be
// incomplete) instead of dropping the frame and chopping the speech.
function feedUtteranceFrame(conn, a) {
  if (conn.firstTs === 0) conn.firstTs = a.tsMs;
  if (a.tsMs - conn.firstTs >= MAX_UTTERANCE_MS && conn.frames.length) {
    conn.firstTs = 0; conn.tailing = false; conn.speechStreak = 0; conn.silenceStreak = 0;
    return flushUtterance(conn);
  }
  let pcm, speech;
  if (a.pcm) {
    // Pre-decoded 24k s16 frame (WebRTC uplink arrived as 48k and was resampled).
    pcm = a.pcm; speech = false;
    let sum = 0; const cnt = a.pcm.length / 2;
    for (let i = 0; i < cnt; i++) sum += Math.abs(a.pcm.readInt16LE(i * 2));
    speech = sum / cnt > SPEECH_RMS;
  } else if (a.concealed || !a.opus) {
    pcm = ZERO_FRAME; speech = false;
    if (conn.frames.length) conn.utteranceLossy = true; // gap inside an open utterance
  } else {
    const d = decodeSpeech(conn, a.opus); pcm = d.pcm; speech = d.speech;
  }

  if (conn.frames.length > 0) {
    // Utterance already open: append; keep it armed while speech, and allow a few
    // trailing non-speech frames so brief word pauses don't punch a hole in audio.
    conn.frames.push(pcm);
    if (speech) { conn.trail = 0; conn.tailing = true; _arm(conn); }
    else if (conn.trail < TRAIL_FRAMES) { conn.trail++; _arm(conn); }
    else { conn.tailing = false; }
    return;
  }

  // Pre-roll (utterance not open yet): keep a bounded ring of the last frames,
  // speech or not, so a soft leading consonant is preserved for onset. Open the
  // utterance only after sustained voiced speech; clear the ring only on real silence.
  conn.pre.push(pcm);
  if (conn.pre.length > PRE_ROLL_FRAMES) conn.pre.shift();
  if (speech) {
    conn.speechStreak = (conn.speechStreak || 0) + 1;
    conn.silenceStreak = 0;
    if (conn.speechStreak >= MIN_SPEECH_FRAMES) {
      // A fresh utterance opens here (pre-roll satisfied). If the agent is
      // still speaking, that is barge-in: cancel the in-flight reply + tell
      // the agent to stop, so the user's speech becomes the next turn.
      maybeBargeIn(conn);
      conn.frames = conn.pre; conn.pre = []; conn.tailing = true;
      conn.speechStreak = 0; conn.trail = 0; _arm(conn);
    }
  } else {
    conn.speechStreak = 0;
    // Near-silence? build toward clearing the pre-roll. Low-energy transients (a
    // leading fricative) have real RMS and are kept, so onset isn't dropped.
    if (frameRms(pcm) < 140) {
      conn.silenceStreak = (conn.silenceStreak || 0) + 1;
      if (conn.silenceStreak > PRE_ROLL_FRAMES) { conn.pre = []; conn.silenceStreak = 0; }
    } else {
      conn.silenceStreak = 0;
    }
  }
}

// RMS (0..32767) of one 20ms frame of 24k s16le PCM (960 samples, 1920 bytes).
function frameRms(buf) {
  let sum = 0;
  const n = buf.length / 2;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

// WS audio frames (control path / non-UDP clients) route through the VAD too.
function handleAudio(conn, ptb) {
  const a = unpackAudio(ptb);
  if (conn.lastRxSeq !== null) {
    const gap = (a.seq - conn.lastRxSeq) >>> 0;
    if (gap > 1) { conn.lost += gap - 1; log(`LOST ${gap - 1} audio frames (seq ${conn.lastRxSeq} -> ${a.seq})`); }
  }
  conn.lastRxSeq = a.seq;
  feedUtteranceFrame(conn, { seq: a.seq, tsMs: a.tsMs, opus: a.opus, concealed: false });
}

async function flushUtterance(conn) {
  conn.deadline = null;
  if (!conn.frames.length) return;
  const frames = conn.frames;
  conn.frames = []; conn.firstTs = 0; conn.tailing = false;
  const lossy = conn.utteranceLossy; conn.utteranceLossy = false;
  // Reject noise blips BEFORE STT: whisper invents text from near-silence.
  if (frames.length < MIN_FLUSH_FRAMES) {
    log(`dropped ${frames.length}-frame utterance (noise blip)`);
    return;
  }
  try {
    const pcm = Buffer.concat(frames); // already decoded 24k s16 PCM
    const dir = mkdtempSync(join(tmpdir(), 'agentmob-'));
    const raw = join(dir, 'u.s16');
    const wav = join(dir, 'u.wav');
    writeFileSync(raw, pcm);
    await ffmpeg(['-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1',
      '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    unlinkSync(raw);
    toBridge({ type: 'audio', path: wav, bytes: pcm.length, lossy });
    log(`utterance -> ${wav} (${frames.length} frames, ${pcm.length}B pcm)${lossy ? ' LOSSY' : ''}`);
  } catch (e) {
    log('audio decode err ' + e.message);
  }
}

async function startMedia(conn, channel) {
  // Trust the AEAD channel, not the source address. Node WS often reports the
  // peer as ::ffff:x.x.x.x while UDP rinfo.address is plain x.x.x.x, and the
  // phone's WS and UDP sockets can bind different local addresses/NATs — so a
  // strict address match rejects legitimate datagrams. A datagram without the
  // session key fails channel.recvBytes regardless of source, so the OLD address
  // gate bought nothing security-wise anyway. We learn the reply peer from the
  // first authenticated datagram (which is also what drives the probe/ack).
  const media = new UdpMedia({
    channel: channel || conn.channel,
    allow: () => true,
  });
  conn.media = media;
  await media.start({ host: BIND, port: 0 });
  log(`media port ${media.port} (UDP audio, AEAD-authenticated)`);
  media.on('media', (f) => {
    if (!conn.channel) return; // ignore any datagram that arrives before the confirm completes
    if (f.kind === 0) feedUtteranceFrame(conn, { seq: f.seq, tsMs: f.tsMs, opus: f.frame, concealed: f.concealed });
  });
  media.on('rcv', (f) => log(`udp rcv kind=${f.kind} seq=${f.seq} from=${f.from.address}:${f.from.port}`));
  media.on('probe', (f) => log(`udp probe kind=2 seq=${f.seq} from=${f.from.address}:${f.from.port} -> ack sent, learnedPeer`));
  return media.port;
}

function flushNow(conn) {
  // Drop any partially-buffered audio when a text command arrives (push-to-talk-ish).
  conn.frames = [];
  conn.pre = [];
  conn.utteranceLossy = false;
  if (conn.deadline) { clearTimeout(conn.deadline); conn.deadline = null; }
}

// ---------------------------------------------------------------------------
// Bridge -> phone outbound
// ---------------------------------------------------------------------------
function handleBridgeMessage(m) {
  if (m.type === 'reply') {
    for (const c of connections) {
      if (c.pending.has(m.i)) {
        c.pending.delete(m.i);
        const d = m.d === undefined ? { type: 'text', text: m.text } : m.d;
        c.ws.send(pack(T.cmd, c.channel.send(Buffer.from(JSON.stringify({ i: m.i, d })), T.cmd)));
        log(`→ phone reply i=${m.i}`);
        return;
      }
    }
    log(`reply for unknown i=${m.i}`);
  } else if (m.type === 'push') {
    for (const c of connections) {
      const d = m.d === undefined ? { type: 'text', text: m.text } : m.d;
      c.ws.send(pack(T.cmd, c.channel.send(Buffer.from(JSON.stringify({ i: -1, d })), T.cmd)));
      log('→ phone push');
      return;
    }
  } else if (m.type === 'pcm') {
    // Reply speech as raw 24k s16 PCM -> encode into discrete 20ms Opus
    // packets (the phone's Concentus decodes ONE packet per T.audio frame).
    // BURST delivery (not real-time pacing): the phone's play queue is
    // unbounded and its AudioTrack drains at real time, so pushing the whole
    // reply in a burst lets the phone PRE-BUFFER it and play continuously —
    // immune to network jitter. Real-time pacing kept the queue nearly empty,
    // so any jitter gap made the phone write a silence frame mid-reply
    // ("choppy hearing you").
    const pcm = softenPeaks(Buffer.from(m.pcm_b64, 'base64'));
    if (!pcmEncoder) pcmEncoder = new OpusScript(24000, 1);
    const frame = 480; // 20ms @ 24k
    const n = Math.floor(pcm.length / 2 / frame);
    if (n === 0) return;
    const conns = [...connections];
    if (!conns.length) return;
    const target = conns[0];
    // Prefer UDP media (spotty-cellular path) once the phone has announced its
    // media endpoint via an uplink datagram; fall back to WS/TCP otherwise.
    const useUdp = !!(target.media && target.media.learnedPeer);
    const peer = useUdp ? target.media.learnedPeer : null;
    // Cancel any still-delivering previous reply (collapses overlapping
    // double-synthesis); a newer synthesis wins.
    const tok = { cancelled: false };
    if (target.pcmCancel) target.pcmCancel.cancelled = true;
    target.pcmCancel = tok;
    let f = 0;
    const viaW = !forceWsDownlink() && !!(target.webrtc && target.webrtc.ready);
    /* START, as well as the finish line below. The only record of a reply used to be written by
     * finish() — when the send was DONE — and device-verify waited on it as "audio is playing",
     * then tapped the mic "mid-sentence". It could never be mid-sentence: on the paced WebRTC
     * downlink that line lands when the reply is over. Found by driving the device test against
     * this sidecar and a simulated app: the Stop tap arrived five seconds after the last frame. */
    log(`→ phone pcm START ${pcm.length}b (${n} frames) via ${viaW ? 'WebRTC' : (useUdp ? 'UDP' : 'WS')}`
        + (!viaW && forceWsDownlink() ? ' [FORCED]' : ''));
    // This line is the ONLY record of which transport actually served the downlink, so it has
    // to survive a truncated playback too. Every early return below used to skip it, which is
    // why a reply cut short by a disconnect, an ICE drop or a newer synthesis left no trace of
    // whether it went over WebRTC or fell back — the exact question H3 turns on. `sent` is
    // reported so a truncation is visible as such rather than looking like a clean send.
    let logged = false;
    const finish = (note) => {
      if (logged) return;
      logged = true;
      if (target.pcmCancel === tok) target.pcmCancel = null;
      log(`→ phone pcm ${pcm.length}b -> ${n} opus packets via ${viaW ? 'WebRTC' : (useUdp ? 'UDP' : 'WS')}` +
          (!viaW && forceWsDownlink() ? ' [FORCED]' : '') +
          (viaW ? '' : ` (webrtc ready=${!!(target.webrtc && target.webrtc.ready)})`) +
          (note ? ` [${note}]` : ''));
    };
    if (viaW) {
      // WebRTC downlink: pace at real-time 20 ms/frame. NetEQ does its OWN jitter
      // buffering, so bursting all frames at once (as the raw UDP/WS paths need)
      // overflows the SRTP send socket / drops UDP -> NetEQ packet-loss
      // concealment repeats them -> "glitchy, skips back". Pacing is the
      // benchmark-aligned approach (LiveKit/aiortc feed one 20ms frame per step).
      const sil = Buffer.alloc(960 * 2);
      const sendW = (i) => {
        // stop on interrupt/ICE drop/disconnect — but still record what was sent
        if (tok.cancelled || !target.webrtc || !target.webrtc.connected) {
          return finish(`cut short after ${i}/${n} frames: `
            + (tok.cancelled ? 'superseded or interrupted' : 'peer gone (ICE drop/disconnect)'));
        }
        try {
          const chunk = pcm.subarray(i * frame * 2, (i + 1) * frame * 2);
          if (i === 0) for (let k = 0; k < WEBRTC_PREROLL; k++) target.webrtc.writeReply(wrtcEnc48.encode(sil, 960));
          target.webrtc.writeReply(wrtcEnc48.encode(up48(chunk), 960));
        } catch (e) { log('webrtc reply err ' + e.message); }
        if (i + 1 < n) setTimeout(() => sendW(i + 1), 20);
        else finish();
      };
      sendW(0);
      return;
    }
    const sendChunk = () => {
      if (tok.cancelled) return finish(`cut short after ${f}/${n} frames: superseded or interrupted`);
      const start = Date.now();
      for (; f < n; f++) {
        try {
          const chunk = pcm.subarray(f * frame * 2, (f + 1) * frame * 2);
          const packet = pcmEncoder.encode(chunk, frame);
          if (useUdp) {
            target.media.send({ kind: 1, seq: f, tsMs: Date.now() + f, opus: packet, addr: peer.address, port: peer.port });
          } else {
            const pl = Buffer.alloc(4 + 8 + packet.length);
            pl.writeUInt32BE(seq(), 0);
            pl.writeBigUInt64BE(BigInt(Date.now() + f), 4);
            packet.copy(pl, 12);
            target.ws.send(pack(T.audio, target.channel.send(pl, T.audio)));
          }
          // Yield to let the socket drain every ~50ms of encode work.
          if ((f & 0x7f) === 0 && Date.now() - start > 40) { f += 1; setImmediate(sendChunk); return; }
        } catch (e) { log('pcm encode err ' + e.message); }
      }
      finish();
    };
    setImmediate(sendChunk);
  }
}

let _seq = 0;
function seq(n) { return _seq = (_seq + 1) >>> 0; }

// ---------------------------------------------------------------------------
function ffmpeg(args) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err || `ffmpeg rc=${code}`))));
  });
}

function log(m) { console.error('[sidecar] ' + m); }

// The ctl socket is an OPTIONAL side channel (local control/introspection). The
// sidecar's real job — the AEAD WebSocket on PORT — is already listening by now.
// An unhandled 'error' here (EADDRINUSE when a stale or second sidecar still holds
// 8790) crashed the whole process, the adapter respawned it, and it crashed again:
// a respawn loop that took the phone channel down over a side channel nobody needs.
// Degrade instead: log it and keep serving.
ctl.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log(`ctl port ${CTL_PORT} in use — continuing WITHOUT the ctl channel `
      + `(another sidecar may be running; set AGENTMOB_SIDECAR_PORT to change it)`);
  } else {
    log('ctl error ' + (e && e.message || e) + ' — continuing without the ctl channel');
  }
});
ctl.listen(CTL_PORT, '127.0.0.1', () => log(`ctl listening 127.0.0.1:${CTL_PORT}`));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
log('ready');
