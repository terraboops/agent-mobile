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
import importlib.util
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
import sys
import tempfile
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
    stt_available()          # probe now, so a missing STT is known before anyone speaks
    return True


class TtsUnavailable(RuntimeError):
    """No TTS engine can run at all — as distinct from one synthesis that failed.

    Same distinction as SttUnavailable, at the other end of the conversation: the retry loop
    must not spin on it, the log should name it, and the user should be told their replies are
    text-only rather than left wondering why the phone stopped talking.
    """


class SttUnavailable(RuntimeError):
    """STT cannot work at all — as distinct from a transcription that merely failed once.

    The difference matters to three audiences: the retry loop (do not), the log (name the real
    cause), and the user (stop repeating yourself, the host is broken).
    """


# ── Speech-to-text availability ──────────────────────────────────────────
#
# _transcribe imports mlx_whisper INSIDE the function, so a missing or broken install used to
# surface as an ImportError on the first UTTERANCE rather than at startup — and once STT gained
# a retry, it retried an import that could never succeed, spending the retry delay before
# telling the user it had not caught that. A broken install and a transient hiccup produced the
# same message and the same delay.
#
# They are different problems: one resolves itself, the other never will. These are the failures
# that RETRYING CANNOT FIX, so they fail fast with their own name.
_STT_PERMANENT_ERRORS = (ImportError, ModuleNotFoundError)
_stt_probe: Optional[bool] = None


def stt_available() -> bool:
    """Is the STT backend importable? Probed once, cheaply.

    Uses find_spec rather than importing: mlx_whisper is heavy and importing it at startup would
    cost seconds and memory for something most sessions use later or not at all. This catches
    "not installed"; a module that imports and then explodes is caught at the first utterance
    instead, where it also now fails fast.
    """
    global _stt_probe
    if _stt_probe is not None:
        return _stt_probe
    try:
        _stt_probe = importlib.util.find_spec("mlx_whisper") is not None
    except Exception as e:
        logger.warning("agentmob: could not probe for mlx_whisper (%s: %s)", type(e).__name__, e)
        _stt_probe = False
    if not _stt_probe:
        logger.error(
            "AGENTMOB STT UNAVAILABLE: mlx_whisper is not importable, so nothing spoken to the "
            "phone can be transcribed. Voice input will fail on every utterance and retrying "
            "cannot help. Install it in the gateway's environment "
            "(%s -m pip install mlx-whisper).", sys.executable)
    return _stt_probe


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
# Rate window. The fast-failure counter above only catches a sidecar that CANNOT START; one
# that starts, stays up past the healthy threshold and then dies resets that counter every
# time, so an 11-second crash loop would warn forever and never escalate. This counts restarts
# per unit time REGARDLESS of individual uptime, which catches "cannot stay up" as well. Sized
# so one genuine crash — or a handful over days — never trips it.
_RESPAWN_WINDOW_S = float(os.getenv("AGENTMOB_RESPAWN_WINDOW_S", "600"))
_RESPAWN_WINDOW_MAX = int(os.getenv("AGENTMOB_RESPAWN_WINDOW_MAX", "6"))
# A SLOW tier, because the fast window has a blind spot: a sidecar dying every ~2 minutes is
# 5 restarts per 600s, one under the threshold, so it would never fire. That is not a boundary
# worth defending — it is the same "degrades into silence" bug at a slower tempo. One genuine
# crash a week is ~1 per 6h, nowhere near 12, so this stays quiet for ordinary operation.
_RESPAWN_SLOW_WINDOW_S = float(os.getenv("AGENTMOB_RESPAWN_SLOW_WINDOW_S", "21600"))   # 6h
_RESPAWN_SLOW_MAX = int(os.getenv("AGENTMOB_RESPAWN_SLOW_MAX", "12"))
# Loopback bridge reconnect policy. Fast at first — this is a local socket and a drop is
# usually momentary — then backing off so a persistently refused port cannot spin.
_BRIDGE_BASE_S = float(os.getenv("AGENTMOB_BRIDGE_BASE_S", "0.25"))
_BRIDGE_MAX_S = float(os.getenv("AGENTMOB_BRIDGE_MAX_S", "5"))
_BRIDGE_ESCALATE_AFTER = int(os.getenv("AGENTMOB_BRIDGE_ESCALATE_AFTER", "8"))
# Consecutive inbound events whose handler raised before saying so at ERROR. Reset by one
# success, so an occasional bad event stays a WARNING.
_INBOUND_ERROR_ESCALATE = int(os.getenv("AGENTMOB_INBOUND_ERROR_ESCALATE", "5"))
# STT attempts per capture. Retrying is safe here because nothing has reached the agent yet,
# and cheap because the audio is still on disk.
_STT_ATTEMPTS = int(os.getenv("AGENTMOB_STT_ATTEMPTS", "2"))
_STT_RETRY_S = float(os.getenv("AGENTMOB_STT_RETRY_S", "0.5"))
# TTS mirrors STT. edge-tts talks to a network service, so a transient failure is real and worth
# retrying; a missing module or binary is not, and no number of attempts will install it.
_TTS_ATTEMPTS = int(os.getenv("AGENTMOB_TTS_ATTEMPTS", "2"))
_TTS_RETRY_S = float(os.getenv("AGENTMOB_TTS_RETRY_S", "0.5"))
_TTS_PERMANENT_ERRORS = (ImportError, ModuleNotFoundError, FileNotFoundError)
# Outbound messages worth holding across a bridge reconnect. Text the user should see stays
# true a second later; a status indicator or a chunk of speech does not.
# What _send_to_sidecar actually did. Three outcomes, not two: a caller that reports success
# to the agent needs to know the difference between "on the wire", "will arrive on reconnect"
# and "gone". These are compared explicitly — never for truthiness, since every non-empty
# string is truthy and "dropped" would read as success.
SEND_SENT = "sent"
SEND_QUEUED = "queued"
SEND_DROPPED = "dropped"

_OUTBOUND_DURABLE = frozenset({"reply", "push"})
_OUTBOUND_EPHEMERAL_INNER = frozenset({"status", "typing"})


def _outbound_kind(payload: dict) -> str:
    """The kind that decides queue-vs-drop, read from the INNER envelope where it matters.

    _push_status sends {"type": "push", "d": {"type": "status"}}, so classifying on the outer
    type alone queued stale status indicators — the exact thing the selectivity exists to avoid,
    and the opposite of what the table in docs/display-surface.md claimed. The outer type is a
    transport frame; the inner one says what the message IS.
    """
    outer = str(payload.get("type") or "")
    inner = ""
    d = payload.get("d")
    if isinstance(d, dict):
        inner = str(d.get("type") or "")
    if inner in _OUTBOUND_EPHEMERAL_INNER:
        return inner
    return outer
_OUTBOUND_QUEUE_MAX = int(os.getenv("AGENTMOB_OUTBOUND_QUEUE_MAX", "32"))
_OUTBOUND_MAX_AGE_S = float(os.getenv("AGENTMOB_OUTBOUND_MAX_AGE_S", "30"))

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


def _supervise_task(coro, name: str):
    """asyncio.create_task with the exception actually SURFACED.

    A bare create_task swallows failures into the task object: if _connect_bridge raised, the
    adapter sat there holding a live sidecar it could not talk to, with nothing in the log. The
    done-callback turns that into a named ERROR. Cancellation is normal shutdown, not an error.
    """
    task = asyncio.ensure_future(coro)

    def _done(t):
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.error("AGENTMOB TASK FAILED: %s raised %s: %s — this path is now dead until "
                         "the sidecar restarts", name, type(exc).__name__, exc, exc_info=exc)

    task.add_done_callback(_done)
    return task


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
        self._outbound_q = collections.deque(maxlen=_OUTBOUND_QUEUE_MAX)
        self._undelivered: list = []         # losses to confess to the agent next turn
        self._tts_dead: set = set()          # engines proven missing; never retried
        self._tts_unavail_notified = False   # so the "text only" notice is said once
        self._restart_times = collections.deque()   # monotonic stamps, pruned to the window
        self._sidecar_flapping = False
        self._flap_reports = 0
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
            self._supervisor = _supervise_task(self._run_sidecar(), "_run_sidecar")
        _supervise_task(self._await_sidecar(), "_await_sidecar")
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
                _supervise_task(self._pump_stderr(), "_pump_stderr")
                self._dispatcher = _supervise_task(self._connect_bridge(), "_connect_bridge")
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
                    # Rate window: count this restart regardless of how long it ran. The
                    # fast-failure counter below only sees a sidecar that cannot START; this
                    # also sees one that cannot STAY UP, which is the likelier shape (binds
                    # fine, then dies on the first real audio frame).
                    now_m = time.monotonic()
                    if not cancelled:
                        self._restart_times.append(now_m)
                    while self._restart_times and now_m - self._restart_times[0] > _RESPAWN_SLOW_WINDOW_S:
                        self._restart_times.popleft()
                    in_window = sum(1 for t in self._restart_times
                                    if now_m - t <= _RESPAWN_WINDOW_S)
                    in_slow = len(self._restart_times)
                    fast_flap = in_window >= _RESPAWN_WINDOW_MAX
                    slow_flap = in_slow >= _RESPAWN_SLOW_MAX
                    flapping = fast_flap or slow_flap
                    if not flapping and self._sidecar_flapping and in_slow <= 1:
                        logger.info("agentmob: sidecar restart rate back to normal")
                        self._sidecar_flapping = False
                        self._flap_reports = 0

                    if cancelled:
                        logger.info("agentmob: sidecar stopped after %.1fs (shutdown)", uptime)
                    elif uptime >= _RESPAWN_HEALTHY_S:
                        if self._sidecar_fails:
                            logger.info("agentmob: sidecar recovered after %d failed start(s)",
                                        self._sidecar_fails)
                        self._sidecar_fails = 0
                        self._sidecar_wedged = False
                        delay = _RESPAWN_BASE_S
                        logger.warning("agentmob: sidecar exited rc=%s after %.1fs — respawning "
                                       "(%d restart(s) in the last %.0fs)",
                                       rc, uptime, in_window, _RESPAWN_WINDOW_S)
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

                    # Flapping is judged on the RATE, so it fires for the stay-up-then-die loop
                    # that the consecutive-failure counter above resets on every iteration.
                    # Backing off here is the point: without it the loop keeps restarting at
                    # whatever period the crash happens to have.
                    if flapping and not cancelled:
                        over = (in_window - _RESPAWN_WINDOW_MAX + 1) if fast_flap else 1
                        flap_delay = min(_RESPAWN_BASE_S * (2 ** over), _RESPAWN_MAX_S)
                        delay = max(delay, flap_delay)
                        first = not self._sidecar_flapping
                        self._sidecar_flapping = True
                        if first or self._flap_reports % _RESPAWN_ESCALATE_EVERY == 0:
                            tail = " | ".join(self._sidecar_stderr) or "(no stderr captured)"
                            n, win = ((in_window, _RESPAWN_WINDOW_S) if fast_flap
                                      else (in_slow, _RESPAWN_SLOW_WINDOW_S))
                            logger.error(
                                "AGENTMOB SIDECAR FLAPPING: %d restarts in the last %.0fs "
                                "(last ran %.1fs, rc=%s). It starts but will not stay up, so "
                                "the phone link keeps dropping. Backing off to %.0fs. "
                                "Last sidecar output: %s",
                                n, win, uptime, rc, delay, tail)
                        self._flap_reports += 1
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
        """Hold the loopback control bridge to the sidecar, reconnecting for as long as the
        sidecar is alive.

        This used to give up. `except Exception: logger.debug(...); return` made ANY unexpected
        error terminal, at debug level, so it was invisible too — and nothing re-created the
        bridge while the sidecar kept running, since only a sidecar RESPAWN builds a new one.
        The result was the adapter sitting on a live sidecar it could not talk to: no audio
        events in, no pushes out, and the phone simply silent. Announcing that (AGENTMOB TASK
        FAILED) was an improvement but not a fix — visible and still broken is not recovery.

        A clean EOF also re-looped with no delay, which could spin against a socket that kept
        closing immediately.
        """
        attempt = 0
        while True:
            # The sidecar owns the bridge's lifetime: _run_sidecar starts a fresh bridge with
            # each spawn, so exiting here when it is gone avoids two bridges racing.
            if self._proc is None or self._proc.returncode is not None:
                logger.info("agentmob: bridge stopping — sidecar is not running "
                            "(a new bridge starts with the next sidecar)")
                return
            try:
                r, w = await asyncio.open_connection("127.0.0.1", self._sidecar_port)
                w.write((self._token + "\n").encode("utf-8"))
                await w.drain()
                self._reader, self._writer = r, w
                self._connected = True
                if attempt:
                    logger.warning("agentmob: loopback bridge RECONNECTED after %d attempt(s)",
                                   attempt)
                else:
                    logger.info("agentmob: loopback bridge connected")
                attempt = 0
                self._flush_outbound()
                await self._consume_inbound()
                # Returning from _consume_inbound means the socket went away under us while
                # the sidecar is still alive. That is the case worth recovering from.
                logger.warning("agentmob: loopback bridge lost while the sidecar is running "
                               "— reconnecting")
            except asyncio.CancelledError:
                self._connected = False
                return
            except (ConnectionRefusedError, OSError) as e:
                logger.warning("agentmob: bridge connect failed (%s) — retrying", e)
            except Exception as e:
                # Was a silent `return`. Unexpected does not mean unrecoverable, and the one
                # thing it must not do is quietly stop.
                logger.warning("agentmob: bridge error %s: %s — retrying",
                               type(e).__name__, e)
            finally:
                self._connected = False

            attempt += 1
            delay = min(_BRIDGE_BASE_S * (2 ** (attempt - 1)), _BRIDGE_MAX_S)
            if attempt == _BRIDGE_ESCALATE_AFTER:
                logger.error(
                    "AGENTMOB BRIDGE DOWN: %d failed reconnects to the sidecar ctl port %s. "
                    "The sidecar is running but the adapter cannot talk to it, so the phone "
                    "gets no replies. Still retrying every %.1fs.",
                    attempt, self._sidecar_port, delay)
            await asyncio.sleep(delay)

    async def _consume_inbound(self):
        """Read NDJSON events from the sidecar until the socket goes away.

        A FAILING HANDLER IS NOT A BROKEN SOCKET. This used to catch everything in one block
        and `break` at debug level, so an event the handler choked on tore down a perfectly
        healthy connection. _connect_bridge then reconnected, read the same kind of event,
        choked again — connect, read, throw, reconnect, forever, with the cause recorded only
        at debug. The log showed bridge churn and nothing about why.

        So the two failures are separated: a socket error ends the read loop (the bridge
        reconnects, which is right), while a handler error is logged and the loop CONTINUES to
        the next event. One poisonous event cannot cost the connection, and a handler failing
        on everything escalates instead of hiding.
        """
        assert self._reader
        handler_errors = 0
        while True:
            # --- read from the socket; a failure here genuinely means reconnect -------------
            try:
                if self._writer is None or self._writer.is_closing():
                    break
                line = await self._reader.readline()
                if not line:
                    break
            except asyncio.CancelledError:
                # RE-RAISE, do not break. Swallowing it hid the cancellation from
                # _connect_bridge, which treated it as an ordinary socket loss and reconnected
                # forever — the task could never be stopped and shutdown hung.
                raise
            except Exception as e:
                logger.warning("agentmob: bridge read failed (%s: %s) — reconnecting",
                               type(e).__name__, e)
                break

            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                evt = json.loads(text)
            except ValueError:
                logger.debug("agentmob: inbound: dropping non-JSON line (%d bytes)", len(text))
                continue

            # --- handle the event; a failure here must NOT close the socket ----------------
            try:
                await self._handle_sidecar_event(evt)
                handler_errors = 0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                handler_errors += 1
                logger.warning("agentmob: inbound handler failed on a %r event (%s: %s) — "
                               "skipping it and continuing to read",
                               (evt or {}).get("type"), type(e).__name__, e)
                if handler_errors == _INBOUND_ERROR_ESCALATE:
                    logger.error(
                        "AGENTMOB INBOUND HANDLER FAILING: %d consecutive events raised, the "
                        "latest a %r (%s: %s). Nothing from the phone is being processed. The "
                        "bridge is healthy — this is a handler bug, not a connection problem.",
                        handler_errors, (evt or {}).get("type"), type(e).__name__, e)
                continue

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
                _supervise_task(self._transcribe_and_dispatch(path, bool(evt.get("lossy"))),
                                "_transcribe_and_dispatch")
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
        else:
            # Previously fell through in silence. A sidecar that starts emitting a new event
            # type would have it dropped with nothing anywhere saying so — the adapter and the
            # sidecar are versioned separately (the sidecar is not even in this repo), so this
            # is a realistic way for the two to drift apart unnoticed.
            logger.warning("agentmob: unhandled sidecar event type %r (keys: %s) — dropped. "
                           "The sidecar may be newer than this adapter.",
                           etype, ",".join(sorted(evt.keys()))[:120])

    def _push_status(self, **kw) -> None:
        """Push a status message to the phone's live status strip (the webview merges
        heartbeat / mic level / heard / working into its chrome). Best-effort.
        """
        self._send_to_sidecar({"type": "push", "d": {"type": "status", **kw}})

    @staticmethod
    def _describe_payload(payload: dict) -> str:
        """A short, honest description of what was lost — enough for the agent to act on."""
        d = payload.get("d") if isinstance(payload.get("d"), dict) else {}
        inner = str(d.get("type") or payload.get("type") or "?")
        if inner == "text":
            t = str(d.get("text") or "")
            return f"text {t[:80]!r}" + ("…" if len(t) > 80 else "")
        if inner == "render":
            ui = d.get("ui") or {}
            comps = [c.get("t") for c in (ui.get("components") or []) if isinstance(c, dict)]
            return f"render ({', '.join(str(c) for c in comps) or 'empty'})"
        if inner == "surface":
            ops = sorted({str(o.get("op")) for o in (d.get("ops") or []) if isinstance(o, dict)})
            return f"surface ops ({', '.join(ops) or 'none'})"
        return inner

    def _note_undelivered(self, payload: dict, why: str) -> None:
        """Tell the AGENT that something it sent never reached the phone.

        send() reports success for a QUEUED message, because it will arrive — but if the bridge
        never comes back it ages out instead, and by then the turn is long closed. The agent
        believes it answered and the user saw nothing, which is the same lie as an outright
        drop, just deferred. It cannot be undone retroactively, so it is handed to the agent on
        its NEXT turn through the same channel that already reports render outcomes, where it
        can say the thing again.
        """
        desc = self._describe_payload(payload)
        self._undelivered.append(f"{desc} ({why})")
        logger.error("AGENTMOB UNDELIVERED: %s — %s. The phone never received it; the agent "
                     "will be told on its next turn.", desc, why)

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
        if self._undelivered:
            lost, self._undelivered = self._undelivered, []
            text = (text + "\n" + " ".join(f"[undelivered {x}]" for x in lost)).strip()
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
        # DELIVERY BOUNDARY.
        #
        # This utterance is the user's actual speech: dropping it means they spoke, the phone
        # heard them, and nothing ever answered. Worth retrying — but ONLY when we can prove
        # the agent never received it. handle_message() hands the turn to Hermes and returns
        # immediately, so once we are inside it we cannot tell whether the turn was accepted
        # before the failure. Retrying there risks the agent answering twice, and a
        # double-answer is worse than a drop: the user hears two replies to one question and
        # cannot tell which is current.
        #
        # So the flag flips on the LAST line before the call. False means the failure happened
        # while we were still preparing — provably pre-delivery, safe to retry. True means
        # delivery is UNCERTAIN, and uncertain is treated as delivered.
        delivery_uncertain = False
        try:
            # Preparation lives INSIDE the try on purpose. It used to sit above it, which made
            # the pre-delivery branch unreachable: anything that raised here escaped
            # dispatch_text entirely, so the utterance was neither retried nor reported. Every
            # line up to the flag is provably before the agent could have seen anything.
            #
            # ...if this turn runs long, say so once instead of leaving dead air.
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

            delivery_uncertain = True
            await self.handle_message(event)
        except Exception as e:
            self._end_turn_now()   # never leave the take-lock stuck on a dispatch error
            if delivery_uncertain:
                logger.error(
                    "agentmob: dispatch failed INSIDE handle_message (%s: %s) — NOT retrying. "
                    "The agent may already have accepted this turn; a double answer is worse "
                    "than a dropped one. The utterance is lost: %r",
                    type(e).__name__, e, text[:120])
            else:
                logger.warning(
                    "agentmob: dispatch failed BEFORE delivery (%s: %s) — retrying once, the "
                    "agent provably never saw it", type(e).__name__, e)
                try:
                    await self.dispatch_text(text, message_id, force=True)
                except Exception as e2:
                    logger.error("agentmob: pre-delivery retry also failed (%s: %s) — "
                                 "utterance lost: %r", type(e2).__name__, e2, text[:120])

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

    def _discard_capture(self, wav_path: str) -> None:
        """Delete a finished capture AND the throwaway directory the sidecar made for it.

        The sidecar does mkdtemp() per utterance and puts u.wav inside it. This used to unlink
        only the file, so every utterance left an empty directory behind for ever — 14 of them
        had accumulated on this machine before anyone looked. rmdir (not rmtree) is deliberate:
        it refuses on a non-empty directory, so an unexpected sibling file is kept rather than
        quietly destroyed, and the name check keeps this from ever touching a directory the
        sidecar did not create.
        """
        try:
            Path(wav_path).unlink(missing_ok=True)
        except Exception as e:
            logger.debug("agentmob: could not remove capture %s: %s", wav_path, e)
        try:
            parent = Path(wav_path).parent
            if parent.name.startswith("agentmob-") and parent.parent == Path(tempfile.gettempdir()):
                parent.rmdir()
        except OSError:
            pass          # not empty, or already gone — both fine
        except Exception as e:
            logger.debug("agentmob: could not remove capture dir: %s", e)

    async def _stt_with_retry(self, wav_path: str):
        """Transcribe, retrying a transient failure while the audio is still on disk.

        This is the same delivery rule dispatch_text follows, one step earlier: NOTHING has
        reached the agent yet, so a retry here cannot produce a double answer. It is also the
        one place a retry is nearly free, because the capture is sitting right there — which is
        precisely what the old code threw away, deleting the WAV in a finally before anyone
        could decide whether to try again.
        """
        last = None
        for attempt in range(1, _STT_ATTEMPTS + 1):
            try:
                return await asyncio.to_thread(self._transcribe, wav_path)
            except _STT_PERMANENT_ERRORS as e:
                # Retrying an import that cannot succeed just spends the delay and then tells
                # the user the same unhelpful thing. Fail fast, and say what is actually wrong.
                global _stt_probe
                _stt_probe = False
                raise SttUnavailable(
                    f"the STT backend is not usable ({type(e).__name__}: {e}). This will fail "
                    f"for every utterance until it is installed or repaired; retrying cannot "
                    f"help.") from e
            except FileNotFoundError as e:
                # The capture itself is gone — a retry reads the same missing file.
                raise SttUnavailable(
                    f"the capture is missing ({e}); nothing to transcribe.") from e
            except Exception as e:
                last = e
                if attempt >= _STT_ATTEMPTS:
                    break
                logger.warning("agentmob: STT attempt %d/%d failed (%s: %s) — retrying; the "
                               "agent has not seen anything yet, so this is provably "
                               "pre-delivery", attempt, _STT_ATTEMPTS, type(e).__name__, e)
                await asyncio.sleep(_STT_RETRY_S)
        raise last

    async def _transcribe_and_dispatch(self, wav_path: str, lossy: bool = False):
        try:
            async with self._stt_lock:
                try:
                    text, degraded = await self._stt_with_retry(wav_path)
                except SttUnavailable as e:
                    # Permanent: do not dress it up as a mishearing. The user should know the
                    # host cannot transcribe at all, or they will keep repeating themselves.
                    logger.error("AGENTMOB STT UNAVAILABLE: %s", e)
                    self._send_to_sidecar({"type": "reply", "d": {"type": "text",
                                          "text": "(Speech recognition isn't working on the "
                                                  "host, so I couldn't hear that. It won't "
                                                  "work until that's fixed.)"}})
                    return
                except Exception as e:
                    logger.error("agentmob: STT failed after %d attempt(s): %s: %s",
                                 _STT_ATTEMPTS, type(e).__name__, e)
                    self._send_to_sidecar({"type": "reply", "d": {"type": "text",
                                          "text": "(I did not catch that.)"}})
                    return
                finally:
                    self._discard_capture(wav_path)
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
        finally:
            # Also runs when the task is cancelled while queued on the STT lock — the window
            # where the capture would otherwise be left behind with nobody to clean it up.
            self._discard_capture(wav_path)

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
            outcome = self._send_to_sidecar({"type": "reply", "i": self._pending_i, "d": reply})
            self._pending_i = None
        else:
            # audio turn has no command id -> deliver as an async push
            outcome = self._send_to_sidecar({"type": "push", "d": reply})
        # Telling Hermes the reply landed when it did not is how a turn gets closed over a
        # reply the user never saw. Queued is fine — it will arrive — but dropped is a loss.
        if outcome == SEND_DROPPED:
            logger.error("AGENTMOB REPLY LOST: the agent's reply could not be delivered to the "
                         "phone and was not queued (%d chars). The turn is being reported as "
                         "failed rather than silently closed.", len(text or ""))
            self._push_status(working=False)
            self._release_turn_after_reply()
            return SendResult(success=False, error="reply could not be delivered to the phone",
                              message_id=secrets.token_hex(6))
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
        # Speech path. A swallowed exception here is indistinguishable from the agent simply
        # having nothing to say — the phone just goes quiet — so these are supervised too.
        self._turn_timeout_task = _supervise_task(_watch(started), "turn_timeout_watch")

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

        self._long_ack_task = _supervise_task(_ack(self._speak_gen), "long_turn_ack")

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
            _supervise_task(self.dispatch_text(d, force=True), "dispatch_text")

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
            self._speak_due = _supervise_task(self._flush_speak(), "flush_speak")

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
        """Send one NDJSON message to the sidecar, holding it briefly if the bridge is down.

        This is the single road every outbound message takes — agent replies, the "heard you"
        status, and every user-facing failure notice added elsewhere in this file. It used to
        drop on a closed bridge and return False, and NOTHING checks that return value, so a
        notice like "speech recognition isn't working" was silently lost whenever the bridge
        happened to be mid-reconnect. Reconnects are fast (~110-220ms measured) but a reply
        lands in that window sooner or later, and the failure is invisible from the call site.

        So durable messages are QUEUED and flushed on reconnect, while time-sensitive ones are
        still dropped on purpose:

          queued  — reply / push: text the user should see. Still true a second later.
          dropped — status / typing / pcm: a stale "working" indicator, or speech arriving
                    after the moment it belonged to, is worse than nothing. Same reasoning as
                    not retrying a TTS turn that already failed.
        """
        kind = _outbound_kind(payload)
        if self._writer is None or self._writer.is_closing():
            if kind in _OUTBOUND_DURABLE:
                self._outbound_q.append((time.monotonic(), payload))
                logger.warning("agentmob: bridge closed — queued %r for reconnect (%d held)",
                               kind, len(self._outbound_q))
                return SEND_QUEUED
            logger.warning("agentmob: bridge closed — dropped %r (time-sensitive, not "
                           "worth delivering late)", kind)
            if kind not in _OUTBOUND_EPHEMERAL_INNER and kind != "pcm":
                self._note_undelivered(payload, "bridge closed and it is not queueable")
            return SEND_DROPPED
        try:
            self._writer.write((json.dumps(payload) + "\n").encode("utf-8"))
            return SEND_SENT
        except Exception as e:
            # Was debug. An outbound message failing to send is exactly as invisible as the
            # bridge-closed case, and just as consequential.
            logger.warning("agentmob: outbound %r failed to write (%s: %s)",
                           kind, type(e).__name__, e)
            if kind in _OUTBOUND_DURABLE:
                self._outbound_q.append((time.monotonic(), payload))
                return SEND_QUEUED
            return SEND_DROPPED

    def _flush_outbound(self) -> int:
        """Deliver anything held while the bridge was down. Called on reconnect."""
        if not self._outbound_q:
            return 0
        now = time.monotonic()
        sent = stale = 0
        held, self._outbound_q = list(self._outbound_q), collections.deque(
            maxlen=_OUTBOUND_QUEUE_MAX)
        for when, payload in held:
            if now - when > _OUTBOUND_MAX_AGE_S:
                stale += 1
                self._note_undelivered(
                    payload, f"queued {now - when:.0f}s waiting for the bridge, past the "
                             f"{_OUTBOUND_MAX_AGE_S:.0f}s limit")
                continue
            if self._writer is None or self._writer.is_closing():
                self._outbound_q.append((when, payload))   # bridge went again mid-flush
                continue
            try:
                self._writer.write((json.dumps(payload) + "\n").encode("utf-8"))
                sent += 1
            except Exception as e:
                logger.warning("agentmob: flush failed (%s: %s)", type(e).__name__, e)
                self._outbound_q.append((when, payload))
        if sent or stale:
            logger.warning("agentmob: bridge reconnect flushed %d queued message(s)"
                           "%s", sent,
                           f", discarded {stale} older than {_OUTBOUND_MAX_AGE_S:.0f}s"
                           if stale else "")
        return sent

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
                _supervise_task(self._clear_speaking_after(dur), "clear_speaking_after")
        except TtsUnavailable as e:
            # Permanent. Say it once per episode: the reply still arrives as TEXT, so the user
            # needs to know voice is off rather than wonder why the phone went quiet — but a
            # notice on every single reply would be worse than the silence it explains.
            logger.error("AGENTMOB TTS UNAVAILABLE: %s", e)
            if not self._tts_unavail_notified:
                self._tts_unavail_notified = True
                self._send_to_sidecar({"type": "push", "d": {"type": "text", "text":
                    "(Voice output isn't available on the host, so I'll reply in text only "
                    "until that's fixed.)"}})
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
        outcome = self._send_to_sidecar({"type": "push", "d": {"type": "render", "ui": ui}})
        comp_types = [c.get("t") for c in ui.get("components", []) if isinstance(c, dict)]
        if outcome == SEND_DROPPED:
            # The agent builds on what it believes rendered (render_result feedback). Claiming
            # a publish that never left the host poisons that loop.
            logger.error("AGENTMOB RENDER LOST: ui publish could not be delivered (comps=%s)",
                         comp_types)
            return SendResult(success=False, error="render could not be delivered to the phone",
                              message_id=secrets.token_hex(6))
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
        outcome = self._send_to_sidecar({"type": "push", "d": {"type": "surface", "ops": ops}})
        opkinds = sorted({o.get("op") for o in ops})
        keys = [o.get("key") for o in ops if o.get("key")]
        if outcome == SEND_DROPPED:
            logger.error("AGENTMOB SURFACE LOST: surface ops could not be delivered "
                         "(ops=%s keys=%s)", opkinds, keys)
            return SendResult(success=False,
                              error="surface ops could not be delivered to the phone",
                              message_id=secrets.token_hex(6))
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
            short = name.replace("_synthesize_", "")
            # An engine already proven missing is not tried again. Re-discovering the same
            # ImportError on every reply costs the fallback chain a step each time and buries
            # the real cause under identical warnings.
            if name in self._tts_dead:
                logger.debug("agentmob: TTS engine %s skipped (known unavailable)", short)
                continue
            for attempt in range(1, _TTS_ATTEMPTS + 1):
                try:
                    out = await getattr(self, name)(text)
                    if out:
                        logger.info("agentmob: TTS ENGINE USED = %s (configured=%s, fallback=%s)",
                                    short, self._tts_engine, i > 0)
                        self._tts_unavail_notified = False
                        return out
                    logger.warning("agentmob: TTS engine %s returned no audio -> next", short)
                    break
                except _TTS_PERMANENT_ERRORS as e:
                    # Missing module or missing binary. Retrying cannot install it, and the
                    # next reply cannot either — so record it and move on for good.
                    self._tts_dead.add(name)
                    last = e
                    logger.error(
                        "AGENTMOB TTS ENGINE UNAVAILABLE: %s cannot run (%s: %s). It will not "
                        "be tried again this session; retrying cannot fix a missing "
                        "dependency.", short, type(e).__name__, e)
                    break
                except Exception as e:
                    # edge-tts talks to a NETWORK service, so this is the genuinely retryable
                    # shape — the mirror image of the permanent case above.
                    last = e
                    if attempt >= _TTS_ATTEMPTS:
                        logger.warning("agentmob: TTS engine %s FAILED after %d attempt(s): %s "
                                       "-> next engine", short, _TTS_ATTEMPTS, e)
                        break
                    logger.warning("agentmob: TTS engine %s attempt %d/%d failed (%s: %s) — "
                                   "retrying, this looks transient",
                                   short, attempt, _TTS_ATTEMPTS, type(e).__name__, e)
                    await asyncio.sleep(_TTS_RETRY_S)

        if all(n in self._tts_dead for n in order):
            raise TtsUnavailable(
                "no TTS engine is usable: "
                + ", ".join(sorted(n.replace("_synthesize_", "") for n in order))
                + " are all missing or broken. Replies will be text-only until one is "
                  "installed; retrying cannot help.")
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
