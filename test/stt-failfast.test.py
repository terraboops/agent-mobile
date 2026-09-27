"""stt-failfast.test — a broken STT install must not look like a transient hiccup.

_transcribe imports mlx_whisper INSIDE the function, so a missing or broken install surfaced as
an ImportError on the first UTTERANCE rather than at startup. Once STT gained a retry, it then
retried an import that could never succeed: it spent the retry delay and told the user
"(I did not catch that.)" — the identical message and timing it gives for a one-off glitch.

They are different problems. One resolves itself; the other never will, and the user repeating
themselves is wasted effort. This checks they are told apart — by the retry loop, by the log,
and by the user-facing message.

The discrimination assertion is the load-bearing one: a version that failed fast on EVERYTHING
would pass the permanent cases while silently destroying the transient retry, which is a real
regression in the opposite direction.

Run: npm run stt-failfast
"""
import asyncio
import importlib.util
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

os.environ.update({"AGENTMOB_STT_ATTEMPTS": "2", "AGENTMOB_STT_RETRY_S": "0.6"})

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


def user_text(a):
    out = []
    for m in a._sent:
        try:
            out.append(m["d"]["text"])
        except Exception:
            pass
    return " ".join(out)


# ---- 1. PERMANENT: the STT backend cannot be imported ---------------------------------------
cap1 = Capture()
logger.addHandler(cap1)


async def permanent():
    a = make_adapter()
    d, w = make_capture()
    calls = {"n": 0}

    def broken(p):
        calls["n"] += 1
        raise ImportError("No module named 'mlx_whisper'")

    a._transcribe = broken
    t0 = time.monotonic()
    await a._transcribe_and_dispatch(w, False)
    return a, d, w, calls["n"], time.monotonic() - t0


a1, d1, w1, n1, el1 = asyncio.run(permanent())
logger.removeHandler(cap1)

ok("permanent: attempted exactly ONCE (no retry of an impossible import)", n1 == 1,
   f"attempted {n1}x — it retried something that can never succeed")
ok("permanent: no retry delay was spent", el1 < 0.5, f"took {el1:.2f}s (retry sleep is 0.6s)")
ok("permanent: logged with its own name, not as a generic STT failure",
   any("STT UNAVAILABLE" in m for m in cap1.at(logging.ERROR)),
   "; ".join(cap1.at(logging.ERROR)[:1]))
ok("permanent: the log says retrying cannot help",
   any("retrying cannot help" in m for m in cap1.at(logging.ERROR)))
ok("permanent: the USER is told the host is broken, not that it misheard",
   "isn't working on the host" in user_text(a1), user_text(a1))
ok("permanent: the user is NOT told '(I did not catch that.)'",
   "did not catch that" not in user_text(a1), user_text(a1))
ok("permanent: nothing was dispatched to the agent", a1.dispatched == [])
ok("permanent: the capture is still cleaned up", not Path(d1).exists() and not Path(w1).exists())

# ---- 2. TRANSIENT: must STILL retry (the regression guard) -----------------------------------
cap2 = Capture()
logger.addHandler(cap2)


async def transient():
    a = make_adapter()
    d, w = make_capture()
    calls = {"n": 0}

    def flaky(p):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("canary: metal backend hiccup")
        return ("play some music", False)

    a._transcribe = flaky
    await a._transcribe_and_dispatch(w, False)
    return a, d, w, calls["n"]


a2, d2, w2, n2 = asyncio.run(transient())
logger.removeHandler(cap2)

ok("transient: still attempted TWICE (fail-fast did not eat the retry)", n2 == 2,
   f"attempted {n2}x")
ok("transient: the utterance still reached the agent", a2.dispatched == ["play some music"],
   str(a2.dispatched))
ok("transient: NOT reported as unavailable",
   not any("STT UNAVAILABLE" in m for m in cap2.at(logging.ERROR)),
   "; ".join(cap2.at(logging.ERROR)[:1]))

# THE DISCRIMINATION: both are STT failures; only one is permanent.
ok("permanent and transient are told APART", n1 == 1 and n2 == 2,
   f"permanent tried {n1}x, transient tried {n2}x — they must differ")

# ---- 3. a missing capture is permanent for this utterance ------------------------------------
async def missing_capture():
    a = make_adapter()
    d, w = make_capture()
    calls = {"n": 0}

    def gone(p):
        calls["n"] += 1
        raise FileNotFoundError(p)

    a._transcribe = gone
    await a._transcribe_and_dispatch(w, False)
    return calls["n"], a


n3, a3 = asyncio.run(missing_capture())
ok("missing capture: not retried (the same file will still be missing)", n3 == 1, f"{n3}x")
ok("missing capture: the user is told something", bool(user_text(a3)))

# ---- 4. the STARTUP probe: a missing backend is known before anyone speaks --------------------
cap4 = Capture()
logger.addHandler(cap4)
mod._stt_probe = None
with mock.patch.object(importlib.util, "find_spec", return_value=None):
    available = mod.stt_available()
logger.removeHandler(cap4)

ok("probe: reports STT unavailable when the module is absent", available is False)
ok("probe: says so at ERROR, at startup, before any utterance",
   any("STT UNAVAILABLE" in m for m in cap4.at(logging.ERROR)),
   "; ".join(cap4.at(logging.ERROR)[:1]))
ok("probe: names the module so the fix is obvious",
   any("mlx_whisper" in m for m in cap4.at(logging.ERROR)))
ok("probe: suggests how to install it",
   any("pip install mlx-whisper" in m for m in cap4.at(logging.ERROR)))

cap5 = Capture()
logger.addHandler(cap5)
mod._stt_probe = None
with mock.patch.object(importlib.util, "find_spec", return_value=object()):
    available2 = mod.stt_available()
logger.removeHandler(cap5)
ok("probe: reports available when the module is present", available2 is True)
ok("probe: says nothing at ERROR when it is fine", not cap5.at(logging.ERROR),
   "; ".join(cap5.at(logging.ERROR)[:1]))

mod._stt_probe = None
calls = {"n": 0}
real = importlib.util.find_spec


def counting(name, *a, **k):
    if name == "mlx_whisper":
        calls["n"] += 1
    return real(name, *a, **k)


with mock.patch.object(importlib.util, "find_spec", counting):
    mod.stt_available()
    mod.stt_available()
    mod.stt_available()
ok("probe: runs once and caches (it is on the startup path)", calls["n"] == 1,
   f"probed {calls['n']}x")
mod._stt_probe = None

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
