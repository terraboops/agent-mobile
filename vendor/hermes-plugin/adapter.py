"""Agent Mobile platform adapter for Hermes Agent.

The agent-mobile Android app terminates into a small supervised Node sidecar
(reuses the validated AEAD/Opus transport edge from the agent-mobile project).
This adapter is the Hermes side: it supervises that sidecar, consumes inbound
turns (voice transcribed to text via faster-whisper, text commands, and button
RPCs), dispatches them into the real Hermes agent loop, and sends replies back
through the same encrypted channel — as text and/or synthesized speech (piper).

Design mirrors the photon platform: Python adapter + loopback bridge to a Node
sidecar, so no Hermes core changes and no bespoke crypto on the Python side.
"""

from __future__ import annotations

import asyncio
import atexit
import collections
import signal
import time
import base64
import json
import logging
import mimetypes
import os
import re
import shutil
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
)
from gateway.config import HomeChannel, Platform, persist_home_channel

# KittenTTS's phonemizer shells out to the espeak-ng binary. The gateway runs
# as a launchd service with a minimal PATH that excludes Homebrew, so prepend
# the Homebrew bin (process-local; the adapter lives inside the gateway proc).
for _hb in ("/opt/homebrew/bin", "/usr/local/bin"):
    if os.path.exists(_hb) and (not os.environ.get("PATH") or _hb not in os.environ["PATH"]):
        os.environ["PATH"] = _hb + ":" + (os.environ.get("PATH") or "")
        break

_CHAT_ID = "agentmobile"
_CHAT_NAME = "Agent Mobile"
_SIDECAR_INDEX = Path(__file__).resolve().parent / "sidecar" / "index.mjs"

_DEFAULT_PORT = 8123
_DEFAULT_SIDECAR_PORT = 8790
_BIND = "0.0.0.0"
_DEFAULT_STT_MODEL = "mlx-community/whisper-large-v3-turbo"  # MLX-native, <1s on Apple Silicon
_DEFAULT_TTS_VOICE = "en_US-amy-medium"      # piper (fallback voice)
_DEFAULT_KITTEN_VOICE = "expr-voice-2-m"
# Cap a voiced reply hard: the phone is a voice remote — speaking is intentional,
# short, and "chill". A wall of text read aloud (hundreds of seconds) is the bug
# the user hit, so never synthesize more than this many chars; detail belongs in
# components, not voice.
_SPEAK_MAX_CHARS = 360

# Piper voice cache (Hermes's own TTS: tts.provider=piper).
_PIPER_VOICES = Path.home() / ".hermes" / "cache" / "piper-voices"
_PIPER_BIN = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "piper"


def check_requirements() -> bool:
    node = shutil.which("node")
    if not node or not _SIDECAR_INDEX.is_file():
        return False
    return True


# ── Sidecar reaping ──────────────────────────────────────────────────────
#
# The adapter OWNS the sidecar, so it is responsible for taking it with it. It used to leave it
# behind: `launchctl bootout` (or any stop that does not reach disconnect()) left a node process
# orphaned and still listening on :8123, which then collided with the next sidecar. Every spawned
# sidecar is tracked here and reaped through its own process group, plus an atexit/signal
# backstop for shutdown paths that never call disconnect().
# Respawn policy. The old loop retried every 3s forever with an identical log line, so a
# sidecar that could never start looked exactly like one that was being supervised fine.
# Overridable so tests can force the escalation quickly instead of waiting minutes.
_RESPAWN_BASE_S = float(os.getenv("AGENTMOB_RESPAWN_BASE_S", "3"))
_RESPAWN_MAX_S = float(os.getenv("AGENTMOB_RESPAWN_MAX_S", "60"))
_RESPAWN_HEALTHY_S = float(os.getenv("AGENTMOB_RESPAWN_HEALTHY_S", "10"))
_RESPAWN_ESCALATE_AFTER = int(os.getenv("AGENTMOB_RESPAWN_ESCALATE_AFTER", "5"))
_RESPAWN_ESCALATE_EVERY = int(os.getenv("AGENTMOB_RESPAWN_ESCALATE_EVERY", "10"))

_LIVE_SIDECARS: set = set()
_REAPER_INSTALLED = False


def _signal_group(pid: int, sig) -> None:
    """Signal the sidecar's process group, falling back to the bare pid.

    Own-group only: os.getpgid(pid) is the group start_new_session gave it, so this can never
    reach the gateway or its siblings even if the pid has already been recycled away.
    """
    try:
        pgid = os.getpgid(pid)
    except Exception:
        pgid = None
    try:
        if pgid and pgid != os.getpgrp():
            os.killpg(pgid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except Exception as e:
        logger.debug("agentmob: signalling sidecar %s failed: %s", pid, e)


def _reap_all_sidecars() -> None:
    for pid in list(_LIVE_SIDECARS):
        _signal_group(pid, signal.SIGTERM)
    deadline = time.time() + 3.0
    while time.time() < deadline:
        alive = []
        for pid in list(_LIVE_SIDECARS):
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except Exception:
                _LIVE_SIDECARS.discard(pid)
        if not alive:
            return
        time.sleep(0.1)
    for pid in list(_LIVE_SIDECARS):
        _signal_group(pid, signal.SIGKILL)
        _LIVE_SIDECARS.discard(pid)


def _install_reaper() -> None:
    """atexit + SIGTERM/SIGINT/SIGHUP backstop, installed once.

    disconnect() is the normal path; this catches the ones that skip it. SIGKILL of the gateway
    still cannot be intercepted — that residual case is covered from the other side, by the
    sidecar's own parent-death watchdog and the EADDRINUSE guard.
    """
    global _REAPER_INSTALLED
    if _REAPER_INSTALLED:
        return
    _REAPER_INSTALLED = True
    atexit.register(_reap_all_sidecars)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            prev = signal.getsignal(sig)

            def _handler(signum, frame, _prev=prev):
                _reap_all_sidecars()
                if callable(_prev) and _prev not in (signal.SIG_IGN, signal.SIG_DFL):
                    return _prev(signum, frame)
                signal.signal(signum, signal.SIG_DFL)
                os.kill(os.getpid(), signum)

            signal.signal(sig, _handler)
        except Exception:
            # Not the main thread, or the host already owns this signal — atexit still applies.
            pass


def _track_sidecar(pid: int) -> None:
    _LIVE_SIDECARS.add(pid)
    _install_reaper()


def _untrack_sidecar(pid: int) -> None:
    _LIVE_SIDECARS.discard(pid)


class AgentMobAdapter(BasePlatformAdapter):
    """Hermes platform adapter for the agent-mobile app."""

    MAX_MESSAGE_LENGTH = 24000

    def __init__(self, config):
        super().__init__(config, Platform("agentmob"))
        self._platform = Platform("agentmob")  # base stores it elsewhere; keep our own ref
        extra = config.extra or {}

        def first(*vals):
            return next((v for v in vals if v not in (None, "")), None)

        self._bind = str(first(extra.get("bind"), os.getenv("AGENTMOB_BIND"), _BIND))
        self._port = int(first(extra.get("port"), os.getenv("AGENTMOB_PORT"), _DEFAULT_PORT))
        self._sidecar_port = int(
            first(extra.get("sidecar_port"), os.getenv("AGENTMOB_SIDECAR_PORT"), _DEFAULT_SIDECAR_PORT)
        )
        self._node_bin = os.getenv("AGENTMOB_NODE_BIN") or shutil.which("node") or "node"
        # Respawn health. _sidecar_stderr keeps the last few lines so the escalation can say
        # WHY it is wedged instead of only that it is.
        self._sidecar_fails = 0
        self._sidecar_wedged = False
        self._sidecar_stderr = collections.deque(maxlen=6)
        # Client pinning. EMPTY means PAIRING MODE (any client accepted) and that is the
        # default on purpose: pinning a stale id locks the phone out, and the phone is the
        # way back in. Flip it in config.yaml (platforms.agentmob.extra.allowed_clients)
        # once a live connection has confirmed the id — no code change.
        self._allowed_clients = str(
            first(extra.get("allowed_clients"), os.getenv("AGENTMOB_ALLOWED_CLIENTS"), "") or ""
        ).strip()
        # ICE servers for the WebRTC media path. Empty = the sidecar's STUN-only default.
        # A TURN entry may carry credentials inline: turn:user:pass@host:3478
        self._ice = str(first(extra.get("ice"), os.getenv("AGENTMOB_ICE"), "") or "").strip()
        self._token = secrets.token_hex(16)
        self._stt_model = str(first(extra.get("stt_model"), os.getenv("AGENTMOB_STT_MODEL"), _DEFAULT_STT_MODEL))
        self._tts_voice = str(first(extra.get("tts_voice"), os.getenv("AGENTMOB_TTS_VOICE"), _DEFAULT_TTS_VOICE))

        # Silence gaps longer than this (s) close a voice turn.
        self._home_channel = str(first(extra.get("home_channel"), os.getenv("AGENTMOB_HOME_CHANNEL"), _CHAT_ID))

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._supervisor: Optional[asyncio.Task] = None
        self._dispatcher: Optional[asyncio.Task] = None
        self._connected = False
        self._home_ensured = False  # auto-set the phone chat as home once per process
        # Turn-take guard: while an agent turn is active, absorb rapid follow-up
        # utterances and flush them as one turn afterwards, instead of replying to
        # every fragment (the "7 replies in 90s" churn / "you think I'm done" bug).
        self._turn_lock = False
        self._turn_started: float = 0.0   # monotonic; for the stale-lock watchdog
        self._turn_timeout_task = None    # background guard that force-ends a reply-less turn
        self._long_ack_task = None        # speaks one 'still working' ack on a slow turn
        self._speak_gen = 0               # bumped on interrupt/barge-in; synthesis for an old gen is dropped
        self._TURN_LOCK_MAX_S = 90.0     # a turn cannot hold the take-lock longer than this
        self._deferred: Optional[str] = None
        # Id of the in-flight phone command awaiting the agent's reply.
        self._pending_i: Optional[int] = None
        # Display-surface render feedback buffered from the phone (device->agent).
        # Surfaced to the agent on its next turn so it can correct a broken widget
        # type before building more on it (docs/display-surface.md render-feedback loop).
        self._surface_feedback: list = []
        # Last-known phone surface state (registered types + live widget keys),
        # reported by the webview host. Given to the agent on each turn so it pushes
        # to EXISTING keys instead of re-registering / re-adding.
        self._surface_state: dict = {}
        # Coalesced piper synthesis (streaming sends collapse to one utterance).
        self._pending_speak: Optional[str] = None
        self._speak_due: Optional[asyncio.Task] = None
        # Lazy faster-whisper model (loaded on first audio turn).
        self._whisper = None
        self._stt_lock = asyncio.Lock()  # serialize mlx-whisper transcribes
        # Lazy KittenTTS model (loaded on first reply). Kitentts 0.1.x uses a
        # fixed bundled nano-0.1 model + expr-voice-* voices (no clean_text).
        self._kitten = None
        self._kitten_voice = str(first(extra.get("kitten_voice"), os.getenv("AGENTMOB_KITTEN_VOICE"), _DEFAULT_KITTEN_VOICE))
        # F5-tts-mlx (local, Apache-2.0, zero-shot clone): optional reference clip +
        # its transcript. Empty => the engine's bundled default voice is used.
        self._f5_ref = str(first(extra.get("f5_ref"), os.getenv("AGENTMOB_F5_REF"), "") or "")
        self._f5_ref_text = str(first(extra.get("f5_ref_text"), os.getenv("AGENTMOB_F5_REF_TEXT"), "") or "")
        # TTS engine of choice: "piper" (default — instant, clean en voices),
        # "f5", or "kitten". Config via AGENTMOB_TTS_ENGINE / extra `tts_engine`.
        # Default to edge-tts (Microsoft neural voices, e.g. en-US-AriaNeural — natural,
        # fast, no API key; the voice configured in the Hermes tts config). Fallbacks inside
        # _synthesize: piper. Override engine with AGENTMOB_TTS_ENGINE, voice with AGENTMOB_EDGE_VOICE.
        self._tts_engine = str(first(extra.get("tts_engine"), os.getenv("AGENTMOB_TTS_ENGINE"), "edge")).strip().lower()
        self._edge_voice = str(first(extra.get("edge_voice"), os.getenv("AGENTMOB_EDGE_VOICE"), "en-US-AriaNeural"))

    @property
    def name(self) -> str:
        return "Agent Mobile"

    # ── Connection lifecycle ─────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not check_requirements():
            self._set_fatal_error("MISSING_DEP", "node or sidecar missing", retryable=False)
            return False
        if self._supervisor is None or self._supervisor.done():
            self._supervisor = asyncio.create_task(self._run_sidecar())
        asyncio.get_event_loop().create_task(self._await_sidecar())
        return True

    async def disconnect(self):
        self._connected = False
        for t in (self._supervisor, self._dispatcher):
            if t is not None:
                t.cancel()
        try:
            if self._writer:
                self._writer.close()
        except Exception:
            pass
        if self._proc is not None and self._proc.returncode is None:
            pid = self._proc.pid
            # Signal the GROUP, not just the node process: the sidecar spawns ffmpeg and the
            # STT/TTS helpers, and those are what keep sockets and temp files alive after a
            # bare terminate(). SIGTERM first so it can close cleanly, SIGKILL if it will not.
            _signal_group(pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(self._proc.wait(), 5)
            except Exception:
                _signal_group(pid, signal.SIGKILL)
                try:
                    await asyncio.wait_for(self._proc.wait(), 3)
                except Exception:
                    pass
            _untrack_sidecar(pid)
        self._proc = None

    # ── Sidecar supervision ──────────────────────────────────────────────

    async def _run_sidecar(self):
        while True:
            if self._proc is None or self._proc.returncode is not None:
                env = dict(os.environ)
                env.update({
                    "AGENTMOB_PORT": str(self._port),
                    "AGENTMOB_BIND": self._bind,
                    "AGENTMOB_SIDECAR_PORT": str(self._sidecar_port),
                    "AGENTMOB_SIDECAR_TOKEN": self._token,
                })
                # Only set when configured: an empty AGENTMOB_ALLOWED_CLIENTS means pairing
                # mode, but exporting "" would still shadow an outer value, and an empty
                # AGENTMOB_ICE is NOT the same as unset (unset = the STUN default).
                if self._allowed_clients:
                    env["AGENTMOB_ALLOWED_CLIENTS"] = self._allowed_clients
                if self._ice:
                    env["AGENTMOB_ICE"] = self._ice
                # start_new_session puts the sidecar in its OWN process group, which is what
                # makes reaping it precise: killing that group takes the node process and
                # anything it spawned (ffmpeg, whisper) and nothing else. Without it, the
                # sidecar shared the gateway's group, terminate() reached only the node process,
                # and a gateway stop left it orphaned holding :8123 — `launchctl bootout` does
                # not reap grandchildren.
                self._proc = await asyncio.create_subprocess_exec(
                    self._node_bin, str(_SIDECAR_INDEX),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    start_new_session=True,
                )
                _track_sidecar(self._proc.pid)
                logger.info("agentmob: sidecar pid=%s", self._proc.pid)
                asyncio.create_task(self._pump_stderr())
                self._dispatcher = asyncio.create_task(self._connect_bridge())
                started_at = time.monotonic()
                cancelled = False
                try:
                    await self._proc.wait()
                except asyncio.CancelledError:
                    # Shutdown, not a crash. Counting it as a failed start would blame the
                    # sidecar for being stopped on purpose, and could push a healthy system
                    # one step closer to a WEDGED alarm on its way out.
                    cancelled = True
                    raise
                finally:
                    rc = self._proc.returncode
                    pid = self._proc.pid
                    uptime = time.monotonic() - started_at
                    _untrack_sidecar(pid)
                    self._proc = None
                    self._connected = False

                    # A start that RAN for a while and then died is an ordinary restart. One
                    # that dies immediately, every time, is a wedge — a bad node binary, a
                    # syntax error, a permanently held port. Only the second kind escalates,
                    # so a long-lived sidecar crashing once never trips the alarm.
                    if cancelled:
                        logger.info("agentmob: sidecar stopped after %.1fs (shutdown)", uptime)
                    elif uptime >= _RESPAWN_HEALTHY_S:
                        if self._sidecar_fails:
                            logger.info("agentmob: sidecar recovered after %d failed start(s)",
                                        self._sidecar_fails)
                        self._sidecar_fails = 0
                        self._sidecar_wedged = False
                        delay = _RESPAWN_BASE_S
                        logger.warning("agentmob: sidecar exited rc=%s after %.1fs — respawning",
                                       rc, uptime)
                    else:
                        self._sidecar_fails += 1
                        delay = min(_RESPAWN_BASE_S * (2 ** (self._sidecar_fails - 1)),
                                    _RESPAWN_MAX_S)
                        # The old loop logged one identical line forever, which reads as
                        # "supervised and healthy" rather than "wedged". Attempt number and
                        # the next delay make the progression visible from the first retry.
                        logger.warning(
                            "agentmob: sidecar died after %.2fs rc=%s — failed start #%d, "
                            "retrying in %.0fs", uptime, rc, self._sidecar_fails, delay)

                        if self._sidecar_fails >= _RESPAWN_ESCALATE_AFTER:
                            first = not self._sidecar_wedged
                            self._sidecar_wedged = True
                            # Re-state it periodically, not every attempt: silence would hide
                            # it, and a line every few seconds trains people to scroll past.
                            if first or self._sidecar_fails % _RESPAWN_ESCALATE_EVERY == 0:
                                tail = " | ".join(self._sidecar_stderr) or "(no stderr captured)"
                                logger.error(
                                    "AGENTMOB SIDECAR WEDGED: %d consecutive failed starts, "
                                    "each dying in under %.0fs (last rc=%s). The phone cannot "
                                    "connect and will not recover on its own. Retrying every "
                                    "%.0fs. Last sidecar output: %s",
                                    self._sidecar_fails, _RESPAWN_HEALTHY_S, rc, delay, tail)
                    if cancelled:
                        delay = _RESPAWN_BASE_S
            else:
                delay = _RESPAWN_BASE_S
            await asyncio.sleep(delay)

    async def _pump_stderr(self):
        try:
            while self._proc and self._proc.stderr:
                line = await self._proc.stderr.readline()
                if not line:
                    break
                _text = line.decode("utf-8", "replace").strip()
                self._sidecar_stderr.append(_text)
                logger.info("agentmob[sidecar]: %s", _text)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug("agentmob: stderr pump: %s", e)

    async def _await_sidecar(self):
        deadline = asyncio.get_event_loop().time() + 20
        try:
            while not self._connected and asyncio.get_event_loop().time() < deadline:
                if self._proc is not None and self._proc.returncode is not None:
                    return
                await asyncio.sleep(0.5)
            if self._connected:
                self._mark_connected()
                self._ensure_home()
        except asyncio.CancelledError:
            pass

    def _ensure_home(self):
        """Auto-set the phone chat as the platform home channel (like /sethome),
        so a fresh new-chat session never triggers a 'no home, run /sethome'
        warning. Runs once per process; idempotent and non-fatal if it fails."""
        if self._home_ensured:
            return
        self._home_ensured = True
        try:
            home = HomeChannel(
                platform=self._platform,
                chat_id=self._home_channel,
                name=_CHAT_NAME,
                thread_id=None,
                user_id=None,
                scope_id=None,
            )
            persist_home_channel(home, enabled_if_new=True)
            # Keep the running gateway's in-memory platform config in sync too so
            # the current process (not just the next restart) reflects the home.
            try:
                from gateway.config import PlatformConfig
                pm = getattr(self, "config", None)
                pm = getattr(pm, "platforms", None) if pm is not None else None
                if pm is not None:
                    pc = pm.setdefault(self._platform, PlatformConfig(enabled=True))
                    pc.home_channel = home
            except Exception:
                pass
            logger.info("agentmob: auto-set home channel %s (%s)", _CHAT_NAME, self._home_channel)
        except Exception as e:
            logger.warning("agentmob: auto-home skipped (non-fatal): %s", e)

    async def _connect_bridge(self):
        while True:
            try:
                r, w = await asyncio.open_connection("127.0.0.1", self._sidecar_port)
                w.write((self._token + "\n").encode("utf-8"))
                await w.drain()
                self._reader, self._writer = r, w
                self._connected = True
                logger.info("agentmob: loopback bridge connected")
                await self._consume_inbound()
            except (ConnectionRefusedError, OSError):
                if self._proc is not None and self._proc.returncode is None:
                    await asyncio.sleep(1)
                else:
                    return
            except asyncio.CancelledError:
                self._connected = False
                return
            except Exception as e:
                logger.debug("agentmob: bridge: %s", e)
                return
            finally:
                self._connected = False

    async def _consume_inbound(self):
        assert self._reader
        while True:
            try:
                if self._writer is None or self._writer.is_closing():
                    break
                line = await self._reader.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    evt = json.loads(text)
                except ValueError:
                    continue
                await self._handle_sidecar_event(evt)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug("agentmob: inbound: %s", e)
                break

    async def _handle_sidecar_event(self, evt: dict):
        etype = evt.get("type")
        if etype == "turn":
            self._pending_i = evt.get("i")
            text = (evt.get("text") or "").strip()
            if not text:
                self._pending_i = None
                return
            # Session commands are handled directly (a real reset) and consumed
            # silently — never dispatched to the LLM, so they produce no confusing reply.
            if text in ("/new", "/reset"):
                await self._reset_phone_session()
                self._pending_i = None
                return
            await self.dispatch_text(text, evt.get("message_id"))
        elif etype == "rpc":
            await self.dispatch_text(json.dumps({"type": "action", "rpc": evt.get("rpc"),
                                                  "args": evt.get("args") or {}}), evt.get("message_id"))
        elif etype == "audio":
            self._pending_i = None
            path = evt.get("path")
            if path:
                asyncio.create_task(self._transcribe_and_dispatch(path, bool(evt.get("lossy"))))
        elif etype == "interrupt":
            # Phone asked the current agent turn to stop (echo of /stop).
            await self._interrupt_active_session()
        elif etype == "render_result":
            # Device->agent render feedback (webview widget mount outcomes). NOT a
            # user turn: buffer it and hand it to the agent on its next dispatch so
            # it can correct a broken widget type before building more on it.
            self._surface_feedback.append({
                "type": "render_result",
                "key": evt.get("key"),
                "ok": bool(evt.get("ok")),
                "error": evt.get("error") or None,
            })
        elif etype == "surface_state":
            # Device->agent sight of the surface (registered types + widget keys),
            # so agents push to existing keys instead of re-registering/re-adding.
            self._surface_state = evt.get("state") or {}

    def _push_status(self, **kw) -> None:
        """Push a status message to the phone's live status strip (the webview merges
        heartbeat / mic level / heard / working into its chrome). Best-effort.
        """
        self._send_to_sidecar({"type": "push", "d": {"type": "status", **kw}})

    def _drain_surface_feedback(self) -> list:
        out, self._surface_feedback = self._surface_feedback, []
        return out

    def _augment_agent_text(self, text: str) -> str:
        """Append render feedback + current surface state to an agent's input text.

        This is the 'give agents sight of the surface' path: each turn the agent
        sees what actually rendered (render_result) and what keys/types already exist
        on the phone, so it pushes to EXISTING widgets instead of re-registering or
        re-adding, and corrects any widget that failed to render.
        """
        fb = self._drain_surface_feedback()
        if fb:
            note = " ".join(
                f"[render {f['key']}={('ok' if f['ok'] else 'FAILED' + ((': ' + str(f['error'])) if f.get('error') else ''))}]"
                for f in fb)
            text = (text + "\n" + note).strip()
        if self._surface_state:
            st = self._surface_state
            _t = st.get("types") or []
            _w = st.get("widgets") or []
            if _t or _w:
                text = (text + "\n[current surface: types=" + ",".join(map(str, _t))
                        + " widgets=" + ",".join(map(str, _w)) + "]").strip()
        return text

    # ── Dispatch into the Hermes loop ────────────────────────────────────

    def build_source(self, *, chat_id=None, chat_name=None, chat_type="dm",
                     user_id=None, user_name=None):
        return super().build_source(
            chat_id=chat_id or _CHAT_ID,
            chat_name=chat_name or _CHAT_NAME,
            chat_type=chat_type,
            user_id=user_id or "terra",
            user_name=user_name or "Terra",
        )

    async def dispatch_text(self, text: str, message_id: Optional[str] = None, *, force: bool = False):
        # Turn-take: while a turn is in flight, don't start another — absorb the
        # follow-up into the active turn (flushed as one by send() afterwards).
        # This stops the agent answering every speech fragment mid-turn.
        if not force and self._turn_lock:
            # Stale-lock watchdog: a turn that errored / produced no reply / never
            # called send() used to hold the take-lock FOREVER, so every later turn
            # was deferred and the agent went permanently silent (no reply, no TTS,
            # 'working' stuck on). If the lock has been held too long, force-release
            # it and fall through instead of deferring into the void.
            if self._turn_started and (time.monotonic() - self._turn_started) > self._TURN_LOCK_MAX_S:
                logger.warning("agentmob: turn-lock held %.0fs > %.0fs — force-releasing stale lock",
                               time.monotonic() - self._turn_started, self._TURN_LOCK_MAX_S)
                self._turn_lock = False
                self._push_status(working=False)
            else:
                self._deferred = ((self._deferred + "\n") if self._deferred else "") + text
                logger.info("agentmob: absorbed rapid follow-up (deferred, %d chars pending)", len(self._deferred))
                return
        self._turn_lock = True
        self._turn_started = time.monotonic()
        # 'working' indicator: the agent loop is now processing a phone input.
        self._push_status(working=True)
        # ...and if this turn runs long, say so once instead of leaving dead air.
        self._arm_long_turn_ack()
        # Render feedback + current surface state -> agent context (see helper).
        text = self._augment_agent_text(text)
        source = self.build_source()
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            user_id=source.user_id,
            user_name=source.user_name,
            message_id=message_id,
        )
        # Leak guard: handle_message() returns immediately (the agent turn runs in a
        # background task and replies later via send() -> _release_turn_after_reply).
        # So we do NOT release here. Instead arm a timeout that force-ends the turn if
        # no reply ever arrives (agent error / empty / tool-only turn) — otherwise the
        # take-lock leaks and every later phone turn is deferred forever (the deadlock).
        self._arm_turn_timeout()
        try:
            await self.handle_message(event)
        except Exception as e:
            logger.error("agentmob: dispatch failed: %s", e)
            self._end_turn_now()   # don't leave the lock stuck on a dispatch error

    # ── STT (faster-whisper) ─────────────────────────────────────────────

    async def _interrupt_active_session(self):
        """Signal the running Hermes turn to stop (same hook the gateway uses)."""
        key = None
        try:
            from gateway.session import build_session_key
            src = self.build_source()
            key = build_session_key(
                src,
                group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
                thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
            )
        except Exception as e:
            logger.warning("agentmob: interrupt: could not build session key: %s", e)
        try:
            await self.interrupt_session_activity(key or "", _CHAT_ID)
            logger.info("agentmob: interrupt signal sent (session=%s)", key)
        except Exception as e:
            logger.warning("agentmob: interrupt failed: %s", e)
        # Barge-in: STOP the voice pipeline too. Bump the speak generation so any synthesis
        # already running (or queued) is discarded instead of talking over the user, cancel the
        # pending-speak flush task, and drop any queued speak text + clear the speaking cue.
        self._speak_gen += 1
        t = self._speak_due
        if t is not None and not t.done():
            t.cancel()
        self._speak_due = None
        self._pending_speak = None
        self._push_status(speaking=False)
        # Also clear the take-lock + absorbed backlog, so a jammed turn doesn't keep every
        # later phone turn deferred after the user barges in / hits Stop.
        self._turn_lock = False
        self._turn_started = 0.0
        self._deferred = None
        self._cancel_long_turn_ack()
        self._push_status(working=False)

    async def _reset_phone_session(self):
        """/new from the phone: rotate the session so its system prompt (and thus
        the skill index) rebuilds fresh. Consumed silently — no reply is sent."""
        key = None
        try:
            from gateway.session import build_session_key
            src = self.build_source()
            key = build_session_key(
                src,
                group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
                thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
            )
        except Exception as e:
            logger.warning("agentmob: /new: could not build session key: %s", e)
        try:
            store = getattr(self, "_session_store", None)
            if store is not None and key:
                import inspect
                r = store.reset_session(key)
                if inspect.isawaitable(r):  # tolerate async store variants
                    await r
                logger.info("agentmob: session reset (/new) key=%s", key)
            else:
                logger.warning("agentmob: /new reset skipped (no store or key=%r)", key)
        except Exception as e:
            logger.warning("agentmob: /new reset failed: %s", e)

    async def _transcribe_and_dispatch(self, wav_path: str, lossy: bool = False):
        async with self._stt_lock:
            try:
                text, degraded = await asyncio.to_thread(self._transcribe, wav_path)
            except Exception as e:
                logger.error("agentmob: STT failed: %s", e)
                self._send_to_sidecar({"type": "reply", "d": {"type": "text",
                                      "text": "(I did not catch that.)"}})
                return
            finally:
                try:
                    Path(wav_path).unlink(missing_ok=True)
                except Exception:
                    pass
        text = (text or "").strip()
        if not text:
            return
        logger.info("agentmob: transcript %r", text[:160])  # backend log only, not shown on the phone
        # Whisper HALLUCINATES on near-silence and room noise, emitting stock phrases
        # ("Thank you.", "Bye.", "Thanks for watching!") or a stuttered word run. The
        # agent then answers something the user never said — which reads as "it doesn't
        # respond properly". Drop these instead of dispatching them.
        if self._is_hallucinated_transcript(text):
            logger.info("agentmob: dropped hallucinated transcript %r (whisper phantom on silence/noise)", text[:80])
            self._push_status(working=False)
            return
        self._push_status(heard=True)  # status strip: "heard you" (voice-first: no chat echo)
        # Hard rule: never guess a task from a broken capture. If the link dropped
        # frames (lossy) or the transcript is genuinely garbled/low-confidence, HOLD
        # and route the user to retype (Telegram) rather than dispatch corrupted
        # fragments as if they were a clear request.
        if lossy or degraded:
            logger.warning("agentmob: degraded input (lossy=%s degraded=%s) — holding, not guessing task from %r",
                           lossy, degraded, text)
            self._push_status(working=False)
            reply = ("The audio came through choppy, so I didn't guess what you meant. "
                     "Say it again, or type it to me on Telegram.")
            self._send_to_sidecar({"type": "push", "d": {"type": "text", "text": reply,
                                                         "controls": self._default_controls()}})
            if self._tts_voice and reply:
                await self._schedule_speak(reply)
            return
        await self.dispatch_text(text)

    def _transcribe(self, wav_path: str):
        # MLX-native STT: faster-whisper's Metal backend takes 8-10s per short
        # clip on Apple Silicon; mlx-whisper does the same work in <1s.
        import mlx_whisper
        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=self._stt_model,
            language="en",
        )
        return (result.get("text") or "").strip(), self._transcript_degraded(result)

    # Stock phrases Whisper emits when it is fed silence or room noise. Matched only
    # when they are the ENTIRE utterance — "thank you" inside a real sentence is fine.
    _WHISPER_PHANTOMS = {
        "thank you", "thank you.", "thanks", "thanks.", "bye", "bye.", "bye bye",
        "thank you very much", "thanks for watching", "thanks for watching!",
        "thank you for watching", "you", "yeah", "okay", "ok", "oh", "hmm", "mm",
        "so", "uh", "um", "...", ".", "please subscribe", "subscribe",
        "i'm sorry", "silence", "[silence]", "(silence)", "music", "[music]",
    }

    @classmethod
    def _is_hallucinated_transcript(cls, text: str) -> bool:
        """True when a transcript is almost certainly a Whisper phantom, not speech."""
        t = (text or "").strip()
        if not t:
            return True
        norm = re.sub(r"\s+", " ", t.lower()).strip()
        if norm in cls._WHISPER_PHANTOMS:
            return True
        words = re.findall(r"[a-z']+", norm)
        if not words:
            return True
        # Strip a trailing stock phantom ("... Thank you." / "... Bye.") so the
        # stutter test below sees the real shape of the utterance.
        core = list(words)
        for tail in (["thank", "you"], ["thanks"], ["bye"], ["bye", "bye"]):
            if len(core) > len(tail) and core[-len(tail):] == tail:
                core = core[:-len(tail)]
                break
        # Stuttered runs: whisper loops one token on noise
        # ("Personal Personal Personal Personal Thank you." -> core = 4x "personal").
        if len(core) >= 2 and len(set(core)) == 1:
            return True
        if len(core) >= 4 and len(set(core)) <= max(2, len(core) // 3):
            return True
        # A single repeated word with nothing else ("you you you").
        if len(set(words)) == 1 and len(words) >= 3:
            return True
        return False

    @staticmethod
    def _transcript_degraded(result) -> bool:
        """False-negative guard for spotty links: True when the transcript smells
        like dropped/damaged audio (low whisper avg_logprob, or no real words), so
        we never fabricate a task from word fragments."""
        import re
        raw = result.get("text") if isinstance(result, dict) else None
        text = (raw or "").strip()
        if not text:
            return False  # empty is handled as "nothing said", not degradation
        segments = (result.get("segments") if isinstance(result, dict) else None) or []
        probs = []
        for s in segments:
            if isinstance(s, dict) and isinstance(s.get("avg_logprob"), (int, float)):
                probs.append(s.get("avg_logprob"))
        if probs and min(probs) < -1.0:  # whisper's own rejection threshold
            return True
        # Fallback heuristic: input has no ≥2-letter word at all (fragment noise).
        if not re.findall(r"[A-Za-z]{2,}", text):
            return True
        return False

    # ── Outbound ─────────────────────────────────────────────────────────

    # Envelope keys the phone understands as a RENDER (never as speech).
    _ENVELOPE_KEYS = ("__ui__", "__surface__")

    @classmethod
    def _extract_envelope(cls, text: str):
        """Best-effort recovery of a {"__ui__"/"__surface__": ...} envelope.

        The strict json.loads() this replaced only accepted a bare, perfectly clean
        JSON body. Any markdown fence or stray prose around the envelope made parsing
        fail, and the whole JSON blob fell through to the speech path — the phone then
        READ THE TOOL CALL ALOUD. Be liberal in what we accept: strip fences, and if
        needed slice from the first '{' to the last '}'.
        Returns the parsed dict, or None when there is genuinely no envelope.
        """
        if not text or "__" not in text:
            return None
        raw = text.strip()
        # ```json ... ```  /  ``` ... ```
        m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?\s*```$", raw, re.DOTALL)
        if m:
            raw = m.group(1).strip()
        candidates = [raw]
        # envelope embedded in surrounding prose
        i, j = raw.find("{"), raw.rfind("}")
        if i != -1 and j > i:
            candidates.append(raw[i:j + 1])
        for cand in candidates:
            try:
                obj = json.loads(cand)
            except (ValueError, TypeError):
                continue
            if isinstance(obj, dict) and any(k in obj for k in cls._ENVELOPE_KEYS):
                return obj
        return None

    @classmethod
    def _looks_like_machine_text(cls, text: str) -> bool:
        """True when a payload is JSON/tool/code noise that must NEVER be spoken.

        Last-resort guard: even if envelope recovery fails, the phone must not read a
        tool call or a JSON blob out loud — that is the single worst failure mode on a
        voice-first surface.
        """
        t = (text or "").strip()
        if not t:
            return False
        if any(k in t for k in cls._ENVELOPE_KEYS):
            return True
        if t.startswith("```"):
            return True
        # a JSON-ish object/array body with structural punctuation density
        if t[:1] in "{[" and t[-1:] in "}]":
            if ('":' in t) or ("': " in t) or len(t) > 200:
                return True
        return False

    async def send(self, chat_id, content, reply_to=None, metadata=None, **kwargs):
        text = content or ""
        # Suppress Hermes' internal run-control chatter (e.g. "↪ Redirected current
        # run (iteration 3/150)..."). It is agent-core bookkeeping, not an answer —
        # never render it and never read it aloud.
        if self._is_internal_status(text):
            logger.debug("agentmob: suppressed internal run-control message (%d chars)", len(text))
            return SendResult(success=True, message_id=secrets.token_hex(6))
        # Component-over-the-wire: the agent can push ANY declarative UI block (e.g. a
        # chart) by replying with JSON {"__ui__": {<components>}, "text": "..."}. The
        # block is published as a render; any "text" is still spoken. This is data, not
        # code — the phone's channel stays declarative and egress-free.
        # Display-surface model (docs/display-surface.md): the agent ships WIDGET TYPES /
        # ASSETS once and then ADDS + PUBLISHES tiles by stable key via {"__surface__": ops}.
        ui = None
        surf = None
        obj = self._extract_envelope(text)
        if obj is not None:
            if "__surface__" in obj:
                surf = obj.pop("__surface__") or []
            elif "__ui__" in obj:
                ui = obj.pop("__ui__") or {}
            text = (obj.get("text") or "").strip()
        if surf is not None:
            res = await self._publish_surface(chat_id, surf)
            if not res.success:
                logger.warning("agentmob: surface send rejected: %s", res.error)
                return res
            if text:
                await self._schedule_speak(text)
            self._push_status(working=False)
            self._release_turn_after_reply()
            return res
        if ui:
            res = await self._publish_ui(chat_id, ui)
            if not res.success:
                # Rule-check failure: DON'T pretend it rendered. Return the error
                # so the agent sees exactly what violated and can fix the component.
                logger.warning("agentmob: ui send rejected: %s", res.error)
                return res
            if text:
                await self._schedule_speak(text)
            self._push_status(working=False)
            self._release_turn_after_reply()
            return res

        reply = {"type": "text", "text": text, "controls": self._default_controls()}
        if self._pending_i is not None:
            # reply to the in-flight text command (the app matches it by id)
            self._send_to_sidecar({"type": "reply", "i": self._pending_i, "d": reply})
            self._pending_i = None
        else:
            # audio turn has no command id -> deliver as an async push
            self._send_to_sidecar({"type": "push", "d": reply})
        # Synthesis speech too (piper); coalesced so streaming sends speak once.
        if self._tts_voice and text:
            await self._schedule_speak(text)
        self._push_status(working=False)
        self._release_turn_after_reply()
        return SendResult(success=True, message_id=secrets.token_hex(6))

    def _arm_turn_timeout(self):
        """(Re)start the watchdog that force-ends a turn whose reply never comes."""
        t = getattr(self, "_turn_timeout_task", None)
        if t is not None and not t.done():
            t.cancel()
        started = self._turn_started
        async def _watch(started_at):
            try:
                await asyncio.sleep(self._TURN_LOCK_MAX_S)
            except asyncio.CancelledError:
                return
            # Only fire if THIS turn is still the one holding the lock.
            if self._turn_lock and self._turn_started == started_at:
                logger.warning("agentmob: turn produced no reply in %.0fs — force-ending (was the deadlock)",
                               self._TURN_LOCK_MAX_S)
                self._end_turn_now()
        self._turn_timeout_task = asyncio.create_task(_watch(started))

    def _end_turn_now(self):
        """Force-end the current turn: clear 'working' and release the take-lock
        (which flushes any deferred backlog). Used by the timeout / dispatch-error path."""
        if self._turn_lock:
            self._push_status(working=False)
        self._release_turn_after_reply()

    # A turn slower than this gets ONE short spoken "still on it" so the user is not
    # left in dead air. Fast turns stay silent — an ack on every turn would be noise.
    _LONG_TURN_ACK_S = 6.0
    _LONG_TURN_ACK_TEXT = "Working on it — this one needs a moment."

    def _arm_long_turn_ack(self):
        """Speak a brief acknowledgment IF the turn is still running after a few
        seconds (perceived-progress: silence reads as 'broken')."""
        t = getattr(self, "_long_ack_task", None)
        if t is not None and not t.done():
            t.cancel()

        async def _ack(started_gen: int):
            try:
                await asyncio.sleep(self._LONG_TURN_ACK_S)
            except asyncio.CancelledError:
                return
            # Only speak if this same turn is STILL running and the user has not
            # barged in (a bumped speak-gen means they interrupted).
            if not self._turn_lock or started_gen != self._speak_gen:
                return
            logger.info("agentmob: long turn (>%.0fs) — speaking progress ack", self._LONG_TURN_ACK_S)
            await self._speak(self._LONG_TURN_ACK_TEXT)

        self._long_ack_task = asyncio.create_task(_ack(self._speak_gen))

    def _cancel_long_turn_ack(self):
        t = getattr(self, "_long_ack_task", None)
        if t is not None and not t.done():
            t.cancel()
        self._long_ack_task = None

    def _release_turn_after_reply(self):
        """End the turn-take lock and flush any absorbed follow-up as one turn.
        Safe to call on every send() — idempotent (only flushes when locked)."""
        if not self._turn_lock:
            return
        self._turn_lock = False
        self._cancel_long_turn_ack()
        t = getattr(self, "_turn_timeout_task", None)
        if t is not None and not t.done():
            t.cancel()
        if self._deferred:
            d = self._deferred
            self._deferred = None
            logger.info("agentmob: flushing %d deferred chars as one follow-up turn", len(d))
            asyncio.create_task(self.dispatch_text(d, force=True))

    async def _schedule_speak(self, text: str):
        # Hermes can deliver ONE reply as several send() calls (e.g. the body
        # then a caption). Join them so the final synthesis speaks the WHOLE
        # reply as one continuous turn — otherwise the phone only hears the
        # last fragment ("choppy / cut off").
        text = (text or "").strip()
        if not text:
            return
        if self._pending_speak:
            self._pending_speak = (self._pending_speak.rstrip() + " " + text).strip()
        else:
            self._pending_speak = text
        # Hard cap: keep the LEAD of the reply (the point), never a 160-second wall.
        # Detail that ran past the cap should have been a component, not voice.
        if len(self._pending_speak) > _SPEAK_MAX_CHARS:
            cut = self._pending_speak[:_SPEAK_MAX_CHARS]
            # trim to the last sentence/scene boundary so it doesn't stop mid-word
            bound = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), cut.rfind("; "))
            if bound > _SPEAK_MAX_CHARS // 2:
                cut = cut[: bound + 1]
            self._pending_speak = cut
        logger.info("agentmob: speak scheduled (total now %d chars)", len(self._pending_speak))
        if self._speak_due is None or self._speak_due.done():
            self._speak_due = asyncio.create_task(self._flush_speak())

    async def _flush_speak(self):
        await asyncio.sleep(1.5)  # settle window: collapses close streamed sends
        t = self._pending_speak
        self._pending_speak = None
        if t:
            logger.info("agentmob: synthesizing final reply (%d chars)", len(t))
            try:
                await self._speak(t)
            except Exception as e:
                logger.error("agentmob: TTS: %s", e)

    def _send_to_sidecar(self, payload: dict) -> bool:
        if self._writer is None or self._writer.is_closing():
            logger.warning("agentmob: outbound dropped (bridge closed)")
            return False
        try:
            self._writer.write((json.dumps(payload) + "\n").encode("utf-8"))
            return True
        except Exception as e:
            logger.debug("agentmob: outbound: %s", e)
            return False

    async def send_typing(self, chat_id):
        self._send_to_sidecar({"type": "typing"})
        return True

    def get_chat_info(self, chat_id):
        return {"name": _CHAT_NAME, "type": "dm", "chat_id": _CHAT_ID}

    # ── TTS (piper) ──────────────────────────────────────────────────────

    @staticmethod
    def _make_voice_friendly(text: str) -> str:
        """Clean text BEFORE TTS so the phone never reads machine-y noise aloud:
        raw URLs, markdown links, emails, code paths, and walls of punctuation.
        Speech on agent-mobile is audio-only, so a long URL spoken verbatim is
        unusable — strip it to the gist. The result stays short and conversational.
        """
        t = text or ""
        # markdown link [label](url) -> the label only
        t = re.sub(r"\[([^\]]*)\]\((?:https?://|mailto:|/|#)[^)]*\)", r"\1", t)
        # bare URLs / www
        t = re.sub(r"(?<![\w/])https?://[^\s<>{}\[\]\"']+", " ", t)
        t = re.sub(r"(?<![\w/.])www\.[\w./?=&%#-]+", " ", t)
        # emails and common identifiers
        t = re.sub(r"(?<![\w.])[\w.+-]+@[\w-]+(?:\.[\w-]+)+", " ", t)
        # collapse punctuation runs + spaces left by the removals
        t = re.sub(r"[,;:.]{2,}", ".", t)
        t = re.sub(r"\s+", " ", t)
        return t.strip(" \t.,;:!?()")

    async def _speak(self, text: str):
        gen = self._speak_gen   # if a barge-in/interrupt bumps this while we synthesize, drop the audio
        # HARD GUARD: never read JSON / a tool call / a code fence aloud. If a render
        # envelope slipped through unparsed, speaking it is worse than silence.
        if self._looks_like_machine_text(text):
            logger.warning(
                "agentmob: refused to speak machine text (%d chars, starts %r) — "
                "envelope/tool payload must render, not be read aloud",
                len(text or ""), (text or "")[:80],
            )
            return
        text = self._make_voice_friendly(text)
        if not text.strip():
            logger.info("agentmob: nothing speakable after voice-friendly cleaning — not reading it aloud")
            return
        # Debug visibility into what is actually read aloud, so any leaked system
        # message can be identified and suppressed (speaking must be intentional).
        logger.debug("agentmob: speaking %d chars: %r", len(text), text[:200])
        try:
            pcm = await self._synthesize(text)
            if gen != self._speak_gen:
                logger.info("agentmob: TTS discarded — user barged in during synthesis (gen %d->%d)", gen, self._speak_gen)
                return
            if pcm:
                # raw 24k s16 PCM; the sidecar encodes it into discrete Opus
                # packets so the phone's Concentus decoder can play them.
                logger.info("agentmob: synthesized %d bytes pcm (~%.1fs) for %d chars",
                            len(pcm), len(pcm) / 2 / 24000, len(text))
                self._send_to_sidecar({"type": "pcm", "pcm_b64": base64.b64encode(pcm).decode()})
                # Voice-indicator: float the speaking widget for the ~duration of
                # this reply (drive it from the phone's 'speaking' status).
                dur = len(pcm) / 2 / 24000
                self._push_status(speaking=True)
                asyncio.create_task(self._clear_speaking_after(dur))
        except Exception as e:
            logger.error("agentmob: TTS failed: %s", e)

    async def _clear_speaking_after(self, seconds: float):
        try:
            await asyncio.sleep(seconds + 0.4)
        except asyncio.CancelledError:
            pass
        self._push_status(speaking=False)

    async def _publish_ui(self, chat_id, ui) -> SendResult:
        """Publish a declarative UI block to the phone (single render surface).

        ``ui`` is one or more render components: ``text``, ``list``, ``button``,
        ``image`` (src + alt), and later charts/dashboards. The webview has NO
        network egress (deny-all WebViewClient + strict CSP), so any media rides
        the secure channel as a data: URI, not as a URL the view must fetch.

        Mic + Stop are REQUIRED components: every block carries a ``controls``
        component (overrideable by the sender) so the two capability buttons are
        always present on-device as ordinary wire components.
        """
        ui.setdefault("controls", self._default_controls())
        # Linter asserts the display-surface rules BEFORE anything ships. Hard
        # violations reject the whole render (the agent sees the error and fixes
        # the component). Warnings ship but are logged.
        offences = self._lint_ui(ui)
        hard = [o for o in offences if o["severity"] == "error"]
        if hard:
            msg = "; ".join(f"{o['rule']}: {o['message']}" for o in hard)
            logger.warning("agentmob: ui REJECTED by linter: %s", msg)
            return SendResult(success=False, error=f"UI rejected by rule check: {msg}",
                              message_id=secrets.token_hex(6))
        for o in offences:
            logger.warning("agentmob: ui lint warn: %s: %s", o["rule"], o["message"])
        self._send_to_sidecar({"type": "push", "d": {"type": "render", "ui": ui}})
        comp_types = [c.get("t") for c in ui.get("components", []) if isinstance(c, dict)]
        logger.info("agentmob: ui published: keys=%s comps=%s", list(ui.keys()), comp_types)
        return SendResult(success=True, message_id=secrets.token_hex(6))

    @staticmethod
    def _lint_ui(ui) -> list:
        """Rule check for a component payload. Returns [{severity, rule, message}]."""
        KNOWN = {"title", "text", "list", "image", "chart", "svg", "viz"}
        FORBIDDEN = {"interactive", "file", "attachment", "document", "html"}
        _EXT = re.compile(r"<script[^>]+src=['\"]https?:", re.I)  # external/CDN -> egress-free webview
        out = []
        if not isinstance(ui, dict):
            return [{"severity": "error", "rule": "envelope", "message": "__ui__ must be a JSON object."}]
        h, s = ui.get("title"), ui.get("text")
        raw_len = 0
        try:
            raw_len = len(json.dumps(ui))
        except Exception:
            pass
        if raw_len > 2_000_000:
            out.append({"severity": "warn", "rule": "size",
                        "message": f"payload ~{raw_len // 1_000} KB — the channel supports it, but prefer "
                                   f"ship-the-library-once + data-only updates."})
        comps = ui.get("components")
        if "components" in ui and not isinstance(comps, list):
            out.append({"severity": "error", "rule": "components", "message": "components must be an array."})
        for i, c in enumerate(comps or []):
            if not isinstance(c, dict):
                out.append({"severity": "error", "rule": "component",
                            "message": f"components[{i}] is not an object."})
                continue
            t = c.get("t")
            if not t:
                out.append({"severity": "error", "rule": "type", "message": f"components[{i}] has no 't'."})
                continue
            if t == "svg":
                out.append({"severity": "error", "rule": "type",
                            "message": "svg is disabled on agent-mobile — it keeps rendering as broken markup "
                                       "on the phone. For weather/time-series/data use a 'chart' component "
                                       "(ApexCharts is bundled and needs no network); for an image use 'image'; "
                                       "for a custom self-contained layout use 'viz' (JS)."})
                continue
            if t in FORBIDDEN:
                out.append({"severity": "error", "rule": "type",
                            "message": f"component type '{t}' is not supported (agent-mobile has no file/HTML "
                                       f"delivery). Inline it as svg/viz/image instead."})
                continue
            if t not in KNOWN:
                out.append({"severity": "error", "rule": "type",
                            "message": f"unknown component type '{t}'. Known: {sorted(KNOWN)}."})
                continue
            if t in ("viz", "svg"):
                code = c.get("code") if t == "viz" else c.get("svg")
                if t == "viz" and not isinstance(c.get("code"), str):
                    out.append({"severity": "error", "rule": "viz", "message": "viz requires a 'code' string."})
                    continue
                if code and _EXT.search(code):
                    out.append({"severity": "error", "rule": "egress",
                                "message": f"component '{t}' references an external/<script src=\"https://…\"> "
                                           f"library — the webview is egress-free, so it renders BLANK. Inline the "
                                           f"library source instead."})
                if t == "svg":
                    s = (c.get("svg") or "").strip().lower()
                    if not s.startswith("<svg"):
                        out.append({"severity": "error", "rule": "svg",
                                    "message": "svg markup must be a real <svg> element. A placeholder/broken string "
                                               "renders as an empty square on the phone. For weather/time-series data, "
                                               "use a 'chart' component (ApexCharts, bundled) instead of svg."})
            if t == "image":
                src = c.get("src") or (ui.get("image") or {}).get("src")
                if src and not str(src).startswith("data:"):
                    out.append({"severity": "error", "rule": "egress",
                                "message": "image src must be a data: URI (the webview cannot fetch URLs)."})
            if t == "chart":
                if not isinstance(c.get("options"), dict):
                    out.append({"severity": "error", "rule": "chart",
                                "message": "chart.options must be a JSON object."})
        return out

    @staticmethod
    def _is_internal_status(text: str) -> bool:
        """True for Hermes agent-core / system-admin chatter that should never be
        spoken or shown on the phone. Only the agent's deliberate reply is voice."""
        t = (text or "").strip()
        low = t.lower()
        if t.startswith("\u21aa"):  # ↪ redirect arrow
            return True
        if "redirected current run" in low:
            return True
        # "iteration N/M" tied to run/redirect/current phrasing (run bookkeeping)
        if "iteration" in low and re.search(r"\d+\s*/\s*\d+", t):
            if any(k in low for k in ("run", "redirect", "current")):
                return True
        # Administrative / housekeeping notices (e.g. the "no home, run /sethome"
        # hint): never an agent answer, never speak. /sethome is the canonical one.
        if "/sethome" in low:
            return True
        if "has no home" in low or "no home set" in low:
            return True
        if "set this chat as the home" in low:
            return True
        if re.search(r"\b(?:run|use|type|try)\s+/[a-z]", low) and ("/sethome" in low or "home" in low):
            return True
        return False

    @staticmethod
    def _default_controls():
        """Default capability controls (mic + stop), fresh copy each call.

        The phone renders mic/stop as its ALWAYS-ON native/pinned bar and ignores
        this block; it is kept on the wire for older clients. No emoji — the
        surface is SVG-first and labels may be read aloud by tooling.
        """
        return {
            "items": [
                {"t": "mic", "label": "Start audio", "accent": "#8957e5"},
                {"t": "stop", "label": "Stop", "accent": "#da3633"},
            ]
        }

    # op -> required string fields. Anything not listed here is an unknown op.
    _SURFACE_OP_FIELDS = {
        "register_asset":       ("name", "b64"),
        "unregister_asset":     ("name",),
        "register_widget_type": ("name", "code"),
        "add_widget":           ("key", "type"),
        "test_widget":          ("key", "type"),
        "update_widget":        ("key",),
        "publish":              ("key",),
        "remove_widget":        ("key",),
    }

    def _validate_surface_ops(self, ops) -> list:
        """Validate a __surface__ batch before it reaches the phone.

        Returns [(index, message)]; empty means the batch is well formed. Checks
        three classes of bug that previously failed silently on-device:
          * unknown op names (a typo like 'add_wigdet' used to be a no-op)
          * missing/blank required fields for the op
          * referential integrity — add/test against an unregistered type, and
            publish/update/remove against a key that was never added.
        Referential state is seeded from the widgets the phone already reports
        (self._surface_state), so a publish to an EXISTING tile still passes.
        """
        problems = []
        state = self._surface_state if isinstance(self._surface_state, dict) else {}
        known_types = set(state.get("types") or [])
        live_keys = set(state.get("widgets") or state.get("keys") or [])

        for i, o in enumerate(ops):
            op = o.get("op")
            spec = self._SURFACE_OP_FIELDS.get(op)
            if spec is None:
                problems.append((i, f"unknown op {op!r}. Valid ops: "
                                    f"{', '.join(sorted(self._SURFACE_OP_FIELDS))}."))
                continue
            for f in spec:
                v = o.get(f)
                if not isinstance(v, str) or not v.strip():
                    problems.append((i, f"{op} requires a non-empty string {f!r}."))
            # track what this batch itself creates, so an in-batch
            # register -> add -> publish sequence validates cleanly
            if op == "register_widget_type" and isinstance(o.get("name"), str):
                known_types.add(o["name"])
            elif op in ("add_widget", "test_widget"):
                t, k = o.get("type"), o.get("key")
                if isinstance(t, str) and t and t not in known_types:
                    problems.append((i, f"{op} references unregistered type {t!r} — "
                                        f"register_widget_type first (register -> test -> add)."))
                if isinstance(k, str) and k:
                    live_keys.add(k)
            elif op in ("publish", "update_widget", "remove_widget"):
                k = o.get("key")
                if isinstance(k, str) and k and k not in live_keys:
                    problems.append((i, f"{op} targets unknown widget key {k!r} — "
                                        f"add_widget it first (the phone reports ops for unknown keys as render_result ok:false)."))
                if op == "remove_widget" and isinstance(k, str):
                    live_keys.discard(k)
        return problems

    async def _publish_surface(self, chat_id, ops) -> SendResult:
        """Publish display-surface ops (docs/display-surface.md, Phase 3).

        The agent ships widget TYPES (and their library assets) ONCE via
        register_asset / register_widget_type, then INSTANTIATES + feeds tiles by
        stable key with add_widget / publish / update_widget / remove_widget /
        test_widget. Render outcomes return to the agent on its next turn via
        _drain_surface_feedback() (the register -> test -> build loop), so a broken
        widget gets corrected before more tiles follow.

        ``ops`` is a JSON array of {op:...} objects. Malformed / oversized batches
        are rejected locally so a bad op can never blank the phone's surface.
        """
        if not isinstance(ops, list) or not ops:
            return SendResult(success=False, error="__surface__ must be a non-empty JSON array of ops.",
                              message_id=secrets.token_hex(6))
        if not all(isinstance(o, dict) and o.get("op") for o in ops):
            return SendResult(success=False, error="each surface op must be an object with an 'op' key.",
                              message_id=secrets.token_hex(6))
        try:
            enc = json.dumps(ops)
        except (TypeError, ValueError) as e:
            return SendResult(success=False, error=f"surface ops not JSON-serializable: {e}",
                              message_id=secrets.token_hex(6))
        if len(enc) > 5_000_000:
            return SendResult(
                success=False, error="surface ops payload too large (>5MB). Prefer ship-the-library-once "
                                      "(register_asset) then data-only publish.",
                message_id=secrets.token_hex(6))
        # Schema + referential check. Without this an unknown op name, a missing
        # required field, or a publish to a key that was never added is accepted
        # here and then SILENTLY DROPPED on the phone — the agent believes it
        # rendered while the screen stays blank, and never self-corrects.
        problems = self._validate_surface_ops(ops)
        if problems:
            err = "surface ops rejected:\n" + "\n".join(f"  - op[{i}] {msg}" for i, msg in problems)
            logger.warning("agentmob: %s", err.replace("\n", " "))
            return SendResult(success=False, error=err, message_id=secrets.token_hex(6))
        self._send_to_sidecar({"type": "push", "d": {"type": "surface", "ops": ops}})
        opkinds = sorted({o.get("op") for o in ops})
        keys = [o.get("key") for o in ops if o.get("key")]
        logger.info("agentmob: surface ops=%s keys=%s", opkinds, keys)
        return SendResult(success=True, message_id=secrets.token_hex(6))

    async def _publish_image(self, chat_id, data, mime, caption) -> SendResult:
        return await self._publish_ui(chat_id, {
            "text": (caption or ""),
            "image": {"src": f"data:{mime};base64,{base64.b64encode(data).decode()}", "alt": caption or ""},
        })

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None) -> SendResult:
        try:
            data, mime = await asyncio.to_thread(self._fetch_url_bytes, image_url)
        except Exception as e:
            logger.error("agentmob: image fetch: %s", e)
            return SendResult(success=False, error=str(e), message_id=secrets.token_hex(6))
        return await self._publish_image(chat_id, data, mime, caption)

    async def send_image_file(self, chat_id, image_path, caption=None, metadata=None) -> SendResult:
        try:
            with open(image_path, "rb") as fh:
                data = fh.read()
        except Exception as e:
            logger.error("agentmob: image file: %s", e)
            return SendResult(success=False, error=str(e), message_id=secrets.token_hex(6))
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        return await self._publish_image(chat_id, data, mime, caption)

    async def send_document(
        self, chat_id, file_path, caption=None, file_name=None,
        reply_to=None, metadata=None, **kwargs,
    ) -> SendResult:
        """The phone can NOT receive raw files.

        Only file types that map onto a render component (SVG / HTML / image)
        are converted and shown. Anything else FAILS here (success=False) so the
        caller/agent sees the error and corrects itself — instead of silently
        dropping content or echoing a host path into the app.
        """
        try:
            path = file_path
            if isinstance(path, str) and path.startswith("file://"):
                path = path[len("file://"):]
            name = (file_name or str(path or "") or "file").lower()
            if not path or not Path(path).exists():
                raise FileNotFoundError(path)
            with open(path, "rb") as fh:
                data = fh.read()
            mime = mimetypes.guess_type(name)[0] or ""
            if name.endswith(".svg") or "svg" in mime:
                return await self._publish_ui(chat_id, {"components": [{"t": "svg", "svg": data.decode("utf-8", "replace")}]})
            if name.endswith((".html", ".htm")) or "html" in mime:
                return await self._publish_ui(chat_id, {
                    "components": [{"t": "viz", "code": data.decode("utf-8", "replace"),
                                    "data": {}, "label": caption or ""}]})
            if ("image" in mime) or name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")):
                return await self._publish_image(chat_id, data, mime or "image/png", caption or file_name or "")
            # Unsupported type: fail agent-side so the agent corrects itself.
            return SendResult(
                success=False,
                error=f"unsupported file type for agent-mobile (the phone renders components, "
                      f"not files; inline '{name}' as an svg/viz/image component instead)",
                message_id=secrets.token_hex(6),
            )
        except Exception as e:
            logger.error("agentmob: send_document: %s", e)
            return SendResult(success=False, error=f"send_document failed: {e}", message_id=secrets.token_hex(6))

    @staticmethod
    def _fetch_url_bytes(url: str):
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "hermes-agentmob/0.1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        return raw, (ctype or "image/png")

    async def _synthesize(self, text: str) -> Optional[bytes]:
        """Choose TTS engine by config; prefer the configured one, fall back."""
        if self._tts_engine == "edge":
            order = ("_synthesize_edge", "_synthesize_piper")
        elif self._tts_engine == "kitten":
            order = ("_synthesize_kittentts", "_synthesize_piper")
        elif self._tts_engine == "f5":
            order = ("_synthesize_f5", "_synthesize_piper")
        elif self._tts_engine == "piper":
            order = ("_synthesize_piper", "_synthesize_edge")
        else:
            order = ("_synthesize_edge", "_synthesize_piper")
        last = None
        for i, name in enumerate(order):
            try:
                out = await getattr(self, name)(text)
                if out:
                    logger.info("agentmob: TTS ENGINE USED = %s (configured=%s, fallback=%s)",
                                name.replace("_synthesize_", ""), self._tts_engine, i > 0)
                    return out
                logger.warning("agentmob: TTS engine %s returned no audio -> next", name.replace("_synthesize_", ""))
            except Exception as e:
                last = e
                logger.warning("agentmob: TTS engine %s FAILED: %s", name.replace("_synthesize_", ""), e)
        if last:
            raise last
        return None

    async def _synthesize_f5(self, text: str) -> Optional[bytes]:
        """F5-tts-mlx (local, Apache-2.0) -> 24 kHz mono s16. Zero-shot clone: point
        AGENTMOB_F5_REF at a reference clip (wav, 24k) + AGENTMOB_F5_REF_TEXT at its
        transcript; empty uses the engine's bundled default voice. method=euler with
        steps=4 is ~3.6x real-time on M-series, so replies stay responsive."""
        from f5_tts_mlx.generate import generate
        import numpy as np
        import soundfile as sf
        out = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"agentmob-f5-{secrets.token_hex(4)}.wav")
        try:
            def _run():
                generate(
                    generation_text=text,
                    output_path=out,
                    ref_audio_path=self._f5_ref or None,
                    ref_audio_text=self._f5_ref_text or None,
                    method="euler",
                    steps=4,
                )
            await asyncio.get_running_loop().run_in_executor(None, _run)
            data, sr = sf.read(out, dtype="float32", always_2d=False)
        finally:
            try:
                os.remove(out)
            except Exception:
                pass
        if data is None or len(data.shape) == 0 or sr != 24000:
            return None  # fall back to next engine
        if data.ndim > 1:
            data = data.mean(axis=1)  # downmix to mono just in case
        s16 = (np.clip(data, -1.0, 1.0) * 32767).astype("<i2")
        return s16.tobytes()

    async def _synthesize_kittentts(self, text: str) -> Optional[bytes]:
        """KittenTTS nano-0.1 -> 24k mono float32 numpy -> int16 PCM bytes."""
        if self._kitten is None:
            from kittentts import KittenTTS
            logger.info("agentmob: loading KittenTTS (default nano-0.1 model)")
            self._kitten = KittenTTS()  # downloads the bundled 25MB model on first use
        import numpy as np
        audio = await asyncio.to_thread(
            self._kitten.generate, text, voice=self._kitten_voice, speed=1.0,
        )
        arr = np.asarray(audio)
        if arr.ndim > 1:
            arr = arr.mean(axis=tuple(range(arr.ndim - 1)))  # downmix to mono
        if arr.dtype.kind == "f":
            arr = (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16)
        elif arr.dtype != np.int16:
            arr = arr.astype(np.int16)
        mono = arr.reshape(-1)
        # Normalize to a healthy peak so no Kitten voice ever sounds faint.
        _pk = int(np.abs(mono).max())
        if 0 < _pk < 29000:
            mono = (mono.astype(np.float32) * (29000.0 / _pk)).astype(np.int16)
        return mono.astype("<i2").tobytes()  # 24k s16 mono

    async def _synthesize_edge(self, text: str) -> Optional[bytes]:
        """edge-tts (Microsoft neural voices, e.g. en-US-AriaNeural) -> mp3 -> ffmpeg to
        24k mono s16 PCM. Natural, fast, no API key. Voice via AGENTMOB_EDGE_VOICE."""
        import edge_tts
        comm = edge_tts.Communicate(text, self._edge_voice)
        mp3 = bytearray()
        async for chunk in comm.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                mp3.extend(chunk["data"])
        if not mp3:
            return None
        ff = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-i", "-", "-ar", "24000", "-ac", "1", "-f", "s16le", "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        pcm24, _ = await ff.communicate(bytes(mp3))
        return pcm24 or None

    async def _synthesize_piper(self, text: str) -> Optional[bytes]:
        """piper -> 22050 PMS 16-bit mono, then ffmpeg resample to 24k s16 raw."""
        onnx = _PIPER_VOICES / f"{self._tts_voice}.onnx"
        cfg = _PIPER_VOICES / f"{self._tts_voice}.onnx.json"
        if not (onnx.is_file() and cfg.is_file()):
            logger.warning("agentmob: piper voice not cached: %s", self._tts_voice)
            return None
        args = [str(_PIPER_BIN), "-m", str(onnx), "-c", str(cfg), "--output-raw"]
        piper = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        pcm, _ = await piper.communicate(text.encode("utf-8"))
        if not pcm:
            return None
        ff = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", "22050", "-ac", "1",
            "-i", "-", "-ar", "24000", "-ac", "1", "-f", "s16le", "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        pcm24, _ = await ff.communicate(pcm)
        return pcm24 or None


# ── Plugin entry point ──────────────────────────────────────────────────

def register(ctx) -> None:
    ctx.register_platform(
        name="agentmob",
        label="Agent Mobile",
        adapter_factory=lambda cfg: AgentMobAdapter(cfg),
        check_fn=check_requirements,
        required_env=[],
        # Authorization: this is a personal single-device channel. Route the
        # allow-list through the standard platform env vars so the user can
        # permit their own account (AGENTMOB_ALLOWED_USERS=terra) or allow-all.
        allowed_users_env="AGENTMOB_ALLOWED_USERS",
        allow_all_env="AGENTMOB_ALLOW_ALL_USERS",
        emoji="📱",
        platform_hint=(
            "You are talking to the user through the Agent Mobile Android app — their "
            "phone: a VOICE-FIRST VISUAL SURFACE, not a chat. "
            "DRAWING IS THE GOAL, speech is a cherry on top. When the user asks to "
            "draw / show / graph / plot / chart anything, the PRIMARY deliverable is the "
            "on-screen component: reply with the render envelope and use a `chart` "
            "component for ANY graph or time-series (weather, prices, readings). NEVER "
            "use `svg` (it is disabled and will be rejected), and NEVER speak the graph "
            "instead of drawing it. After drawing, an OPTIONAL one-line spoken caption "
            "about what you drew is the cherry — never read the numbers/data aloud. "
            "Keep any speech to one short, spoken-friendly sentence. "
            "Never expose internal identifiers."
        ),
    )
