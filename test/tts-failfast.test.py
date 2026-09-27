"""tts-failfast.test — the TTS path must tell a missing dependency from a network blip.

The mirror image of the STT pass, at the other end of the conversation. edge-tts talks to a
NETWORK service, so a transient failure is real and worth retrying. A missing module or binary
is not, and no number of attempts will install it — yet _synthesize treated both identically:
one try per engine, a generic warning, fall through, and the user got silence with no idea why.

Checked here:
  - permanent (ImportError / missing binary) fails fast, is named, and is never retried again
  - transient still retries with backoff — the regression a careless fix would cause
  - the two paths DIFFER (the load-bearing assertion)
  - the user is told, once, that replies are text-only
  - synthesis temp files are cleaned on every exit path

Run: npm run tts-failfast
"""
import asyncio
import importlib.util
import logging
import os
import sys
import time
from pathlib import Path

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

os.environ.update({"AGENTMOB_TTS_ATTEMPTS": "2", "AGENTMOB_TTS_RETRY_S": "0.6"})

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


def make_adapter(engine="edge"):
    a = object.__new__(mod.AgentMobAdapter)
    a._tts_engine = engine
    a._tts_dead = set()
    a._tts_unavail_notified = False
    a._sent = []
    a._send_to_sidecar = lambda m: a._sent.append(m)
    a._push_status = lambda **kw: None
    a._speak_gen = 0
    a._looks_like_machine_text = lambda t: False
    a._make_voice_friendly = lambda t: t
    return a


def user_text(a):
    out = []
    for m in a._sent:
        try:
            out.append(m["d"]["text"])
        except Exception:
            pass
    return " ".join(out)


# ---- 1. PERMANENT: every engine is missing --------------------------------------------------
cap1 = Capture()
logger.addHandler(cap1)


async def all_missing():
    a = make_adapter()
    calls = {"edge": 0, "piper": 0}

    async def edge(t):
        calls["edge"] += 1
        raise ImportError("No module named 'edge_tts'")

    async def piper(t):
        calls["piper"] += 1
        raise FileNotFoundError("piper")

    a._synthesize_edge = edge
    a._synthesize_piper = piper
    t0 = time.monotonic()
    err = None
    try:
        await a._synthesize("hello")
    except Exception as e:
        err = e
    return a, calls, err, time.monotonic() - t0


a1, c1, err1, el1 = asyncio.run(all_missing())
logger.removeHandler(cap1)

ok("permanent: each engine tried exactly ONCE", c1 == {"edge": 1, "piper": 1}, str(c1))
ok("permanent: no retry delay burned", el1 < 0.5, f"{el1:.2f}s (retry sleep is 0.6s)")
ok("permanent: raises TtsUnavailable, not a generic error",
   isinstance(err1, mod.TtsUnavailable), type(err1).__name__)
ok("permanent: the log names the engine as unavailable",
   any("TTS ENGINE UNAVAILABLE" in m for m in cap1.at(logging.ERROR)),
   "; ".join(cap1.at(logging.ERROR)[:1]))
ok("permanent: the log says retrying cannot fix it",
   any("retrying cannot fix" in m for m in cap1.at(logging.ERROR)))
ok("permanent: both dead engines are remembered", a1._tts_dead == {"_synthesize_edge", "_synthesize_piper"},
   str(a1._tts_dead))


# ---- 2. a dead engine is never tried again --------------------------------------------------
async def second_call(a):
    calls = {"n": 0}

    async def edge(t):
        calls["n"] += 1
        raise ImportError("still missing")

    a._synthesize_edge = edge
    try:
        await a._synthesize("again")
    except Exception:
        pass
    return calls["n"]


n2 = asyncio.run(second_call(a1))
ok("permanent: a known-dead engine is not tried on the next reply", n2 == 0,
   f"tried {n2}x — it rediscovers the same ImportError every turn")


# ---- 3. TRANSIENT: must still retry (the opposite-direction regression) ---------------------
cap3 = Capture()
logger.addHandler(cap3)


async def transient():
    a = make_adapter()
    calls = {"n": 0}

    async def edge(t):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("canary: edge-tts network blip")
        return b"\x01\x02" * 100

    a._synthesize_edge = edge
    fell = {"through": False}

    async def piper(t):
        # Reaching piper means the retry never happened and we fell through instead. Recorded
        # rather than raised, so the red run reports a failure instead of a stack trace.
        fell["through"] = True
        return b"\x09" * 10

    a._synthesize_piper = piper
    out = await a._synthesize("hello")
    return a, calls["n"], out, fell["through"]


a3, n3, out3, fell3 = asyncio.run(transient())
logger.removeHandler(cap3)

ok("transient: the engine was retried", n3 == 2, f"tried {n3}x — the retry was destroyed")
ok("transient: it succeeded on the retry, no fallback needed", bool(out3))
ok("transient: it did NOT fall through to the next engine", not fell3,
   "fell through instead of retrying — the retry is gone")
ok("transient: the engine is NOT marked dead", a3._tts_dead == set(), str(a3._tts_dead))
ok("transient: logged as transient, not as unavailable",
   any("looks transient" in m for m in cap3.at(logging.WARNING))
   and not any("TTS ENGINE UNAVAILABLE" in m for m in cap3.at(logging.ERROR)),
   "; ".join(cap3.at(logging.WARNING)[:2]))

# THE DISCRIMINATION. Both are engine failures; only one is worth retrying.
ok("permanent and transient are told APART", c1["edge"] == 1 and n3 == 2,
   f"permanent tried {c1['edge']}x, transient tried {n3}x — they must differ")


# ---- 4. a transient failure still falls through to the next engine --------------------------
async def falls_through():
    a = make_adapter()
    calls = {"edge": 0, "piper": 0}

    async def edge(t):
        calls["edge"] += 1
        raise ConnectionError("canary: always down")

    async def piper(t):
        calls["piper"] += 1
        return b"\x03\x04" * 50

    a._synthesize_edge = edge
    a._synthesize_piper = piper
    out = await a._synthesize("hi")
    return calls, out


c4, out4 = asyncio.run(falls_through())
ok("fallback: a persistently transient engine still yields to the next", bool(out4))
ok("fallback: it exhausted its retries first", c4["edge"] == 2, str(c4))
ok("fallback: the working engine was used once", c4["piper"] == 1, str(c4))


# ---- 5. the user is told, ONCE, that replies are text-only ----------------------------------
cap5 = Capture()
logger.addHandler(cap5)


async def speak_unavailable():
    a = make_adapter()

    async def boom(t):
        raise mod.TtsUnavailable("no engine is usable")

    a._synthesize = boom
    await a._speak("here is your answer")
    first = user_text(a)
    await a._speak("and another answer")
    return a, first


a5, first5 = asyncio.run(speak_unavailable())
logger.removeHandler(cap5)

ok("user: told that voice is unavailable", "text only" in first5.lower() or "text-only" in first5.lower(),
   first5)
ok("user: the message is truthful about the host, not a mishearing",
   "isn't available on the host" in first5, first5)
ok("user: told ONCE, not on every reply", user_text(a5).count("text only") <= 1,
   user_text(a5))
ok("user: logged with a greppable marker",
   any("AGENTMOB TTS UNAVAILABLE" in m for m in cap5.at(logging.ERROR)),
   "; ".join(cap5.at(logging.ERROR)[:1]))


# ---- 6. synthesis temp files are cleaned on every exit path ---------------------------------
# Stubbed, deliberately. An earlier version of this called the real _synthesize_f5, which
# downloaded models for over two minutes and then PASSED TRIVIALLY because synthesis succeeded
# and nothing needed cleaning. A cleanup test has to make the cleanup happen.
import glob
import types


def f5_temp_files():
    base = os.environ.get("TMPDIR", "/tmp")
    return set(glob.glob(os.path.join(base, "agentmob-f5-*.wav")))


created = {}


def fake_generate(**kw):
    # Write the file the way the real engine does, THEN fail — the exact shape the finally
    # exists for. Without cleanup this leaks one wav per failed reply.
    out = kw["output_path"]
    Path(out).write_bytes(b"RIFF" + b"\0" * 32)
    created["path"] = out
    raise RuntimeError("canary: f5 blew up after writing its output")


fake_mod = types.ModuleType("f5_tts_mlx.generate")
fake_mod.generate = fake_generate
pkg = types.ModuleType("f5_tts_mlx")
pkg.generate = fake_mod
saved = {k: sys.modules.get(k) for k in ("f5_tts_mlx", "f5_tts_mlx.generate")}
sys.modules["f5_tts_mlx"] = pkg
sys.modules["f5_tts_mlx.generate"] = fake_mod

before = f5_temp_files()


async def f5_raises():
    a = make_adapter("f5")
    a._f5_ref = ""
    a._f5_ref_text = ""
    try:
        await mod.AgentMobAdapter._synthesize_f5(a, "hello")
    except Exception as e:
        return e
    return None


err6 = asyncio.run(f5_raises())
after = f5_temp_files()

for k, v in saved.items():
    if v is None:
        sys.modules.pop(k, None)
    else:
        sys.modules[k] = v

ok("temp: the failing engine really did create its temp file", "path" in created,
   "the stub never ran — this test would pass vacuously")
ok("temp: and it is cleaned up despite the failure", after == before,
   f"leaked {sorted(after - before)}")
ok("temp: the failure still propagates (cleanup does not swallow it)",
   isinstance(err6, RuntimeError) and "canary" in str(err6), repr(err6))

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
