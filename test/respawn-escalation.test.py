"""respawn-escalation.test — a sidecar that can never start must not look supervised-and-healthy.

The old loop retried every 3 seconds forever, logging one identical line each time. A sidecar
that died instantly on every attempt — bad node binary, syntax error, a permanently held port —
produced exactly the same log as a healthy supervisor doing its job. Nothing escalated, nothing
backed off, and the phone simply never worked while the gateway looked fine.

This forces that state (a node binary that exits immediately, every time) and checks the loop
ends somewhere NAMED rather than looping quietly:
  - the retry delay backs off instead of pinning at 3s
  - the backoff is capped, so it never retreats to uselessly long waits
  - each line carries the attempt number, so progression is visible from the first retry
  - after a threshold it escalates to ERROR with a distinctive marker and the sidecar's own
    last output, so an operator can see WHY, not only THAT
  - it does NOT escalate for an ordinary crash of a long-running sidecar
  - a recovered sidecar resets the counter and says so

Timings come from env (AGENTMOB_RESPAWN_*), so this runs in seconds rather than minutes.
The live gateway is never involved; the adapter is driven directly on a throwaway port.

Run: npm run respawn-escalation
"""
import asyncio
import importlib.util
import logging
import os
import sys
import time

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

# Compress the policy BEFORE importing: the constants are read at module load.
os.environ.update({
    "AGENTMOB_RESPAWN_BASE_S": "0.2",
    "AGENTMOB_RESPAWN_MAX_S": "1.0",
    "AGENTMOB_RESPAWN_HEALTHY_S": "0.5",
    "AGENTMOB_RESPAWN_ESCALATE_AFTER": "4",
    "AGENTMOB_RESPAWN_ESCALATE_EVERY": "3",
    "AGENTMOB_RESPAWN_WINDOW_S": "30",
    "AGENTMOB_RESPAWN_WINDOW_MAX": "4",
})

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

ok("respawn policy is configurable (not hard-coded 3s forever)",
   mod._RESPAWN_BASE_S == 0.2 and mod._RESPAWN_ESCALATE_AFTER == 4,
   f"base={mod._RESPAWN_BASE_S} after={mod._RESPAWN_ESCALATE_AFTER}")


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        try:
            self.records.append((record.levelno, record.getMessage()))
        except Exception:
            pass

    def at(self, level):
        return [m for lv, m in self.records if lv == level]


def make_adapter(node_bin):
    """A real AgentMobAdapter with just enough config to run the respawn loop."""
    a = object.__new__(mod.AgentMobAdapter)
    a._proc = None
    a._connected = False
    a._dispatcher = None
    a._supervisor = None
    a._writer = None
    a._port = 8873          # throwaway, never 8123
    a._bind = "127.0.0.1"
    a._sidecar_port = 8874
    a._token = "test"
    a._node_bin = node_bin
    a._allowed_clients = ""
    a._ice = ""
    a._sidecar_fails = 0
    a._sidecar_wedged = False
    import collections
    a._sidecar_stderr = collections.deque(maxlen=6)
    a._restart_times = collections.deque()
    a._sidecar_flapping = False
    a._flap_reports = 0
    a._pump_stderr = lambda: asyncio.sleep(0)      # no stdout plumbing needed here
    a._connect_bridge = lambda: asyncio.sleep(0)
    return a


async def run_loop(adapter, seconds):
    task = asyncio.create_task(adapter._run_sidecar())
    await asyncio.sleep(seconds)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as e:
        # Swallowing this hid an AttributeError in the loop body and made every assertion
        # below fail for the wrong reason. Surface it.
        print(f"  !! _run_sidecar raised: {type(e).__name__}: {e}")
        raise


# ---- 1. a binary that always fails instantly ------------------------------------------------
cap = Capture()
logger = logging.getLogger(mod.logger.name)
logger.addHandler(cap)
logger.setLevel(logging.DEBUG)

adapter = make_adapter("/usr/bin/false")     # exits 1 immediately, every time
adapter._sidecar_stderr.append("[sidecar] canary: could not start")
t0 = time.monotonic()
asyncio.run(run_loop(adapter, 6.0))
elapsed = time.monotonic() - t0

warns = cap.at(logging.WARNING)
errors = cap.at(logging.ERROR)

ok("it kept retrying (the supervisor still supervises)", adapter._sidecar_fails >= 4,
   f"only {adapter._sidecar_fails} attempt(s)")
ok("each retry names the attempt number",
   any("failed start #1" in m for m in warns) and any("failed start #2" in m for m in warns),
   "; ".join(warns[:3]))
ok("the delay BACKS OFF instead of pinning at the base",
   any("retrying in 1s" in m or "retrying in 0s" in m for m in warns) and
   len({m.split("retrying in ")[-1] for m in warns if "retrying in " in m}) > 1,
   "; ".join(warns[:5]))
ok("it ESCALATES to ERROR after the threshold", len(errors) >= 1,
   f"{len(errors)} error records")
ok("the escalation carries a distinctive, greppable marker",
   any("AGENTMOB SIDECAR WEDGED" in m for m in errors), "; ".join(errors[:2]))
ok("the escalation says the phone cannot connect and will not self-heal",
   any("will not recover on its own" in m for m in errors))
ok("the escalation includes the sidecar's own last output (WHY, not just THAT)",
   any("canary: could not start" in m for m in errors), "; ".join(errors[:1]))
ok("the wedged flag is set for anything else to read", adapter._sidecar_wedged is True)
ok("it does NOT spam an ERROR on every single attempt",
   len(errors) < adapter._sidecar_fails,
   f"{len(errors)} errors for {adapter._sidecar_fails} attempts")
ok("backoff is capped (the loop did not stall for minutes)", elapsed < 10,
   f"{elapsed:.1f}s")

# A wedge must be reached in a sane number of attempts, not hundreds.
ok("attempts are bounded by backoff, not a hot spin", adapter._sidecar_fails < 40,
   f"{adapter._sidecar_fails} attempts in ~6s")

logger.removeHandler(cap)

# ---- 2. a sidecar that runs a while then dies is NOT a wedge --------------------------------
cap2 = Capture()
logger.addHandler(cap2)

adapter2 = make_adapter("/bin/sleep")
# /bin/sleep with the sidecar path as its arg errors out; use a wrapper that lives long enough.
wrapper = "/tmp/agentmob-slow-exit.sh"
with open(wrapper, "w") as f:
    f.write("#!/bin/sh\nsleep 0.8\nexit 1\n")
os.chmod(wrapper, 0o755)
adapter2._node_bin = wrapper

asyncio.run(run_loop(adapter2, 6.0))
errors2 = cap2.at(logging.ERROR)
ok("a long-running sidecar that dies does NOT trip the wedge alarm",
   not any("WEDGED" in m for m in errors2), "; ".join(errors2[:2]))
ok("its failure counter stays reset (healthy uptime clears it)",
   adapter2._sidecar_fails == 0, f"fails={adapter2._sidecar_fails}")
# The ordinary restart line must be DISTINCT from the failed-start line, or a healthy
# restart and a wedge read the same in the log.
warns2 = cap2.at(logging.WARNING)
ok("a healthy restart logs the ordinary form, not 'failed start #n'",
   any("respawning" in m and "failed start" not in m for m in warns2),
   "; ".join(warns2[:3]))
ok("being cancelled (shutdown) is not counted as a failed start",
   not any("failed start" in m for m in warns2), "; ".join(warns2[:3]))
logger.removeHandler(cap2)
os.unlink(wrapper)


# ---- 3. the STAY-UP-THEN-DIE loop: healthy uptime every time, still a crash loop -----------
# This is the case the consecutive-failure counter structurally cannot see: each run clears it,
# so the old code warned forever at the crash's own period and never escalated or backed off.
print("\n--- 3. sidecar that stays up past the healthy threshold, then dies, repeatedly ---")
cap3 = Capture()
logger.addHandler(cap3)

flap = "/tmp/agentmob-flap.sh"
with open(flap, "w") as f:
    f.write("#!/bin/sh\nsleep 0.8\nexit 3\n")     # 0.8s > HEALTHY_S 0.5 -> 'healthy' every time
os.chmod(flap, 0o755)

adapter3 = make_adapter(flap)
adapter3._sidecar_stderr.append("[sidecar] canary: died on first audio frame")
t3 = time.monotonic()
asyncio.run(run_loop(adapter3, 8.0))
el3 = time.monotonic() - t3

warns3 = cap3.at(logging.WARNING)
errors3 = cap3.at(logging.ERROR)

ok("stay-up loop: the fast-failure counter never trips (as designed)",
   adapter3._sidecar_fails == 0, f"fails={adapter3._sidecar_fails}")
ok("stay-up loop: it is NOT reported as WEDGED (that would be the wrong diagnosis)",
   not any("WEDGED" in m for m in errors3), "; ".join(errors3[:1]))
ok("stay-up loop: it IS escalated as FLAPPING",
   any("AGENTMOB SIDECAR FLAPPING" in m for m in errors3),
   f"{len(errors3)} error(s): " + "; ".join(errors3[:2]))
ok("stay-up loop: the flap report counts restarts over the window",
   any("restarts in the last 30s" in m for m in errors3), "; ".join(errors3[:1]))
ok("stay-up loop: it says it starts but will not stay up",
   any("will not stay up" in m for m in errors3))
ok("stay-up loop: it carries the sidecar's own last output",
   any("died on first audio frame" in m for m in errors3))
ok("stay-up loop: the flapping flag is set", adapter3._sidecar_flapping is True)
ok("stay-up loop: ordinary lines report the window count",
   any("restart(s) in the last" in m for m in warns3), "; ".join(warns3[:2]))
ok("stay-up loop: it BACKS OFF (does not keep restarting at the crash's own period)",
   any("Backing off to" in m for m in errors3), "; ".join(errors3[:1]))
ok("stay-up loop: does not spam an ERROR per restart",
   len(errors3) < len(adapter3._restart_times), f"{len(errors3)} errors / {len(adapter3._restart_times)} restarts")
logger.removeHandler(cap3)

# ---- 4. DISCRIMINATION: one genuine crash must not fire the alarm --------------------------
# Without this the rate window is just a wider net. A single crash, or a couple spread out, is
# ordinary operation — the alarm has to stay quiet or it trains people to ignore it.
print("\n--- 4. a single genuine crash is NOT a flap ---")
cap4 = Capture()
logger.addHandler(cap4)

once = "/tmp/agentmob-once.sh"
with open(once, "w") as f:
    # dies once, then stays up for the rest of the run
    f.write("#!/bin/sh\nif [ ! -f /tmp/agentmob-once.flag ]; then touch /tmp/agentmob-once.flag; "
            "sleep 0.8; exit 4; fi\nsleep 30\n")
os.chmod(once, 0o755)
if os.path.exists("/tmp/agentmob-once.flag"):
    os.unlink("/tmp/agentmob-once.flag")

adapter4 = make_adapter(once)
asyncio.run(run_loop(adapter4, 5.0))
errors4 = cap4.at(logging.ERROR)

ok("single crash: exactly one restart recorded", len(adapter4._restart_times) == 1,
   f"{len(adapter4._restart_times)} restarts")
ok("single crash: NO flapping alarm", not any("FLAPPING" in m for m in errors4),
   "; ".join(errors4[:1]))
ok("single crash: NO wedged alarm", not any("WEDGED" in m for m in errors4))
ok("single crash: the flapping flag stays clear", adapter4._sidecar_flapping is False)
logger.removeHandler(cap4)
os.unlink(flap)
os.unlink(once)
if os.path.exists("/tmp/agentmob-once.flag"):
    os.unlink("/tmp/agentmob-once.flag")

# ---- 5. a raising _connect_bridge must SURFACE, not vanish ---------------------------------
# It was a bare create_task: the exception went into the task object and nowhere else, leaving
# the adapter holding a live sidecar it could not talk to, with an empty log.
print("\n--- 5. a failing _connect_bridge surfaces ---")
cap5 = Capture()
logger.addHandler(cap5)


async def _boom():
    raise RuntimeError("canary: ctl connect refused")


async def _drive():
    mod._supervise_task(_boom(), "_connect_bridge")
    await asyncio.sleep(0.5)

asyncio.run(_drive())
errors5 = cap5.at(logging.ERROR)
ok("connect_bridge: the failure is logged at ERROR, not swallowed",
   any("AGENTMOB TASK FAILED" in m for m in errors5), f"{len(errors5)} error(s)")
ok("connect_bridge: the log names WHICH task died",
   any("_connect_bridge" in m for m in errors5))
ok("connect_bridge: it carries the original exception",
   any("canary: ctl connect refused" in m for m in errors5))
ok("connect_bridge: it says the path is dead until restart",
   any("dead until" in m for m in errors5))


async def _cancel_is_quiet():
    async def _long():
        await asyncio.sleep(10)
    t = mod._supervise_task(_long(), "_cancelled_task")
    await asyncio.sleep(0.1)
    t.cancel()
    await asyncio.sleep(0.2)

cap5.records.clear()
asyncio.run(_cancel_is_quiet())
ok("connect_bridge: a CANCELLED task is not reported as a failure",
   not any("AGENTMOB TASK FAILED" in m for m in cap5.at(logging.ERROR)))
logger.removeHandler(cap5)


# ---- 6. the SPEECH PATH: a raising task must not read as "nothing to say" ------------------
# These were bare create_task. On the speech path a swallowed exception is indistinguishable
# from the agent simply having nothing to say: the phone just goes quiet. Driven through the
# REAL call site (_schedule_speak schedules _flush_speak), not through the helper directly.
print("\n--- 6. speech-path tasks surface their failures ---")
cap6 = Capture()
logger.addHandler(cap6)


def speech_adapter():
    a = object.__new__(mod.AgentMobAdapter)
    a._pending_speak = ""
    a._speak_due = None
    a._speak_gen = 0
    return a


async def _drive_speak():
    a = speech_adapter()

    async def _boom():
        raise RuntimeError("canary: TTS backend exploded")

    a._flush_speak = _boom
    await a._schedule_speak("say something out loud")
    await asyncio.sleep(0.4)
    return a

adapter6 = asyncio.run(_drive_speak())
errors6 = cap6.at(logging.ERROR)

ok("speech path: a failing _flush_speak surfaces at ERROR",
   any("AGENTMOB TASK FAILED" in m for m in errors6), f"{len(errors6)} error(s)")
ok("speech path: the log names flush_speak specifically",
   any("flush_speak" in m for m in errors6), "; ".join(errors6[:1]))
ok("speech path: the original exception is carried",
   any("canary: TTS backend exploded" in m for m in errors6))
ok("speech path: it was actually scheduled through the real call site",
   adapter6._speak_due is not None)
cap6.records.clear()


# A cancelled speech task is ordinary (a newer reply supersedes an older one) and must stay
# quiet, or every barge-in would log an error and the alarm would mean nothing.
async def _drive_cancel():
    a = speech_adapter()

    async def _slow():
        await asyncio.sleep(10)

    a._flush_speak = _slow
    await a._schedule_speak("first reply")
    await asyncio.sleep(0.1)
    a._speak_due.cancel()
    await asyncio.sleep(0.2)

asyncio.run(_drive_cancel())
ok("speech path: a CANCELLED speak task logs nothing (barge-in is normal)",
   not any("AGENTMOB TASK FAILED" in m for m in cap6.at(logging.ERROR)),
   "; ".join(cap6.at(logging.ERROR)[:1]))
logger.removeHandler(cap6)

# Every speech-path scheduler must be supervised, not just the one driven above.
src = open(os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")).read()
import re as _re
bare = [ln.strip() for ln in src.split("\n")
        if "asyncio.create_task(" in ln and not ln.strip().startswith("#")
        and '"""' not in ln]
ok("no bare asyncio.create_task remains on any path", not bare,
   " | ".join(bare[:4]))
for name in ("turn_timeout_watch", "long_turn_ack", "dispatch_text",
             "flush_speak", "clear_speaking_after"):
    ok(f"speech path: {name} is supervised", f'"{name}"' in src)

# ---- 7. SLOW death: dying every couple of minutes must still be caught ---------------------
# The fast window has a blind spot by construction — a restart every ~2 minutes is 5 per 600s,
# one under the threshold, so it would never fire. Reloaded with its own config so the FAST
# tier cannot fire at all and only the slow tier can.
print("\n--- 7. slow-tempo crash loop (fast window cannot see it) ---")
os.environ.update({
    "AGENTMOB_RESPAWN_WINDOW_S": "0.05",     # fast window effectively off
    "AGENTMOB_RESPAWN_WINDOW_MAX": "999",
    "AGENTMOB_RESPAWN_SLOW_WINDOW_S": "30",
    "AGENTMOB_RESPAWN_SLOW_MAX": "4",
})
slow_spec = importlib.util.spec_from_file_location("agentmob_adapter_slow", ADAPTER)
smod = importlib.util.module_from_spec(slow_spec)
slow_spec.loader.exec_module(smod)

ok("slow tier: the fast window is disabled for this scenario",
   smod._RESPAWN_WINDOW_MAX == 999 and smod._RESPAWN_SLOW_MAX == 4)

cap7 = Capture()
slogger = logging.getLogger(smod.logger.name)
slogger.addHandler(cap7)

slow_sh = "/tmp/agentmob-slow.sh"
with open(slow_sh, "w") as f:
    f.write("#!/bin/sh\nsleep 0.8\nexit 5\n")     # healthy uptime every time
os.chmod(slow_sh, 0o755)

a7 = object.__new__(smod.AgentMobAdapter)
for k, v in {"_proc": None, "_connected": False, "_dispatcher": None, "_supervisor": None,
             "_writer": None, "_port": 8875, "_bind": "127.0.0.1", "_sidecar_port": 8876,
             "_token": "t", "_node_bin": slow_sh, "_allowed_clients": "", "_ice": "",
             "_sidecar_fails": 0, "_sidecar_wedged": False, "_sidecar_flapping": False,
             "_flap_reports": 0}.items():
    setattr(a7, k, v)
import collections as _c
a7._sidecar_stderr = _c.deque(maxlen=6)
a7._restart_times = _c.deque()
a7._pump_stderr = lambda: asyncio.sleep(0)
a7._connect_bridge = lambda: asyncio.sleep(0)

asyncio.run(run_loop(a7, 6.0))
errors7 = cap7.at(logging.ERROR)
ok("slow tier: the FAST window never fired (it cannot see this tempo)",
   not any("in the last 0s" in m for m in errors7))
ok("slow tier: FLAPPING still fires on the slow window",
   any("AGENTMOB SIDECAR FLAPPING" in m for m in errors7),
   f"{len(errors7)} error(s): " + "; ".join(errors7[:1]))
ok("slow tier: it reports the slow window length",
   any("in the last 30s" in m for m in errors7), "; ".join(errors7[:1]))
ok("slow tier: the fast-failure counter stayed clear (uptime was healthy)",
   a7._sidecar_fails == 0, f"fails={a7._sidecar_fails}")
slogger.removeHandler(cap7)
os.unlink(slow_sh)

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
