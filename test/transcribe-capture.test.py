"""transcribe-capture.test — captures must not leak, and a transient STT failure must retry.

_transcribe_and_dispatch takes a recorded utterance from disk to the agent. Two defects found
by auditing it:

1. LEAKED DIRECTORY. The sidecar does mkdtemp() per utterance and writes u.wav inside it. The
   adapter unlinked only the file, so every single utterance left an empty directory behind for
   ever. Not theoretical — 14 had accumulated on this machine before anyone looked.

2. NO RETRY, AND NO WAY TO ADD ONE. The WAV was deleted in a `finally` the moment transcription
   returned or raised, so a transient STT failure destroyed the evidence before anything could
   decide to try again. This is the one place a retry is both SAFE (nothing has reached the
   agent — the same pre-delivery rule dispatch_text follows) and nearly free (the audio is
   right there).

Both assertions are written to FAIL against the old code: the directory is checked, not just
the file, and the retry is checked by counting transcribe calls.

Run: npm run transcribe-capture
"""
import asyncio
import importlib.util
import logging
import os
import sys
import tempfile
from pathlib import Path

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

os.environ.update({"AGENTMOB_STT_ATTEMPTS": "2", "AGENTMOB_STT_RETRY_S": "0.05"})

PASS = 0
FAILS = []


def ok(name, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


spec = importlib.util.spec_from_file_location("agentmob_adapter", ADAPTER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

logger = logging.getLogger(mod.logger.name)
logger.setLevel(logging.DEBUG)


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        try:
            self.records.append((record.levelno, record.getMessage()))
        except Exception:
            pass

    def at(self, lv):
        return [m for l, m in self.records if l == lv]


def make_capture():
    """Exactly what the sidecar produces: mkdtemp('agentmob-') containing u.wav."""
    d = tempfile.mkdtemp(prefix="agentmob-")
    w = Path(d) / "u.wav"
    w.write_bytes(b"RIFF" + b"\0" * 64)
    return d, str(w)


def make_adapter():
    a = object.__new__(mod.AgentMobAdapter)
    a._stt_lock = asyncio.Lock()
    a._sent = []
    a._send_to_sidecar = lambda m: a._sent.append(m)
    a._push_status = lambda **kw: None
    a._tts_voice = None
    a._default_controls = lambda: []
    a.dispatched = []

    async def _dispatch(text, *args, **kw):
        a.dispatched.append(text)

    a.dispatch_text = _dispatch
    a._is_hallucinated_transcript = lambda t: False
    return a


# ---- 1. the happy path must leave NOTHING behind ------------------------------------------
async def happy():
    a = make_adapter()
    d, w = make_capture()
    a._transcribe = lambda p: ("turn on the lights", False)
    await a._transcribe_and_dispatch(w, False)
    return a, d, w


a1, d1, w1 = asyncio.run(happy())
ok("happy: the utterance reached the agent", a1.dispatched == ["turn on the lights"],
   str(a1.dispatched))
ok("happy: the wav file is gone", not Path(w1).exists())
ok("happy: the temp DIRECTORY is gone too (this is the leak)", not Path(d1).exists(),
   f"{d1} still exists — one leaked dir per utterance, for ever")

# ---- 2. a transient STT failure retries, and succeeds --------------------------------------
cap2 = Capture()
logger.addHandler(cap2)


async def transient():
    a = make_adapter()
    d, w = make_capture()
    calls = {"n": 0}

    def flaky(p):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("canary: mlx backend hiccup")
        return ("what time is it", False)

    a._transcribe = flaky
    await a._transcribe_and_dispatch(w, False)
    return a, d, w, calls["n"]


a2, d2, w2, n2 = asyncio.run(transient())
logger.removeHandler(cap2)
ok("transient: STT was attempted TWICE", n2 == 2, f"attempted {n2}x — no retry happened")
ok("transient: the utterance survived and reached the agent",
   a2.dispatched == ["what time is it"], str(a2.dispatched))
ok("transient: the user was NOT told 'I did not catch that'",
   not any("did not catch" in str(m) for m in a2._sent), str(a2._sent))
ok("transient: the retry is logged as provably pre-delivery",
   any("provably" in m and "pre-delivery" in m for m in cap2.at(logging.WARNING)),
   "; ".join(cap2.at(logging.WARNING)[:2]))
ok("transient: nothing leaked", not Path(d2).exists() and not Path(w2).exists())

# ---- 3. a persistent STT failure gives up, tells the user, and still cleans up -------------
cap3 = Capture()
logger.addHandler(cap3)


async def persistent():
    a = make_adapter()
    d, w = make_capture()
    calls = {"n": 0}

    def always(p):
        calls["n"] += 1
        raise RuntimeError("canary: STT is down")

    a._transcribe = always
    await a._transcribe_and_dispatch(w, False)
    return a, d, w, calls["n"]


a3, d3, w3, n3 = asyncio.run(persistent())
logger.removeHandler(cap3)
ok("persistent: it stops after the configured attempts", n3 == 2, f"attempted {n3}x")
ok("persistent: it does NOT retry for ever", n3 <= 3, f"attempted {n3}x")
ok("persistent: the user is told something", any("did not catch" in str(m) for m in a3._sent))
ok("persistent: nothing was dispatched to the agent", a3.dispatched == [])
ok("persistent: the failure is reported at ERROR",
   any("STT failed after" in m for m in cap3.at(logging.ERROR)),
   "; ".join(cap3.at(logging.ERROR)[:1]))
ok("persistent: the capture is still cleaned up",
   not Path(d3).exists() and not Path(w3).exists(), f"{d3}")

# ---- 4. cancelled while queued on the STT lock — the window with no owner -------------------
async def cancelled_while_queued():
    a = make_adapter()
    d, w = make_capture()
    await a._stt_lock.acquire()          # hold it so the task queues behind us
    a._transcribe = lambda p: ("never runs", False)
    t = asyncio.ensure_future(a._transcribe_and_dispatch(w, False))
    await asyncio.sleep(0.1)
    t.cancel()
    try:
        await t
    except asyncio.CancelledError:
        pass
    a._stt_lock.release()
    return d, w


d4, w4 = asyncio.run(cancelled_while_queued())
ok("cancelled: the capture is not orphaned", not Path(w4).exists(),
   f"{w4} left behind by a cancelled task")
ok("cancelled: its directory is not orphaned either", not Path(d4).exists(), f"{d4}")

# ---- 5. the cleanup must be conservative ---------------------------------------------------
a5 = make_adapter()
d5 = tempfile.mkdtemp(prefix="agentmob-")
w5 = Path(d5) / "u.wav"
w5.write_bytes(b"x")
sibling = Path(d5) / "something-else.bin"
sibling.write_bytes(b"y")
a5._discard_capture(str(w5))
ok("conservative: a non-empty capture dir is KEPT, not blown away", Path(d5).exists())
ok("conservative: the sibling file is untouched", sibling.exists())
sibling.unlink()
Path(d5).rmdir()

outside = tempfile.mkdtemp(prefix="not-agentmob-")
w6 = Path(outside) / "u.wav"
w6.write_bytes(b"z")
a5._discard_capture(str(w6))
ok("conservative: a directory the sidecar did not create is never removed", Path(outside).exists(),
   f"{outside} was removed — the name guard failed")
Path(outside).rmdir()

ok("conservative: discarding twice is harmless (idempotent)",
   (a5._discard_capture(str(w1)), True)[1])

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
