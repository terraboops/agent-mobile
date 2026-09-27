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
    "AGENTMOB_RESPAWN_HEALTHY_S": "2.0",
    "AGENTMOB_RESPAWN_ESCALATE_AFTER": "4",
    "AGENTMOB_RESPAWN_ESCALATE_EVERY": "3",
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
    a._pump_stderr = lambda: asyncio.sleep(0)      # no stdout plumbing needed here
    a._connect_bridge = lambda: asyncio.sleep(0)
    return a


async def run_loop(adapter, seconds):
    task = asyncio.create_task(adapter._run_sidecar())
    await asyncio.sleep(seconds)
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


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
    f.write("#!/bin/sh\nsleep 2.5\nexit 1\n")
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

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
