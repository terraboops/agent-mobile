"""bridge-recovery.test — the loopback bridge must heal itself, not just announce its death.

The adapter talks to the sidecar over a loopback control socket. If that socket dies while the
sidecar keeps running, the adapter is deaf and mute: no audio events in, no pushes out, and the
phone just goes silent. The old code made that permanent — `except Exception: logger.debug(...);
return` ended the bridge on any unexpected error, at debug level so it was invisible too, and
nothing rebuilt it while the sidecar stayed alive (only a sidecar RESPAWN builds a new one).

Supervising the task made that death visible. Visible and still broken is not recovery, so this
tests the recovery itself: a REAL sidecar on throwaway ports, a REAL bridge, the socket broken
underneath it mid-run, and the adapter expected to reconnect on its own with the sidecar never
restarting.

Run: npm run bridge-recovery
"""
import asyncio
import importlib.util
import os
import socket
import subprocess
import sys
import time

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
SIDECAR = os.path.expanduser("~/.hermes/plugins/agentmob/sidecar/index.mjs")
WS_PORT, CTL_PORT = 8877, 8878          # throwaway; never 8123/8790

if not (os.path.exists(ADAPTER) and os.path.exists(SIDECAR)):
    print("skip: plugin not installed")
    sys.exit(0)

os.environ.update({"AGENTMOB_BRIDGE_BASE_S": "0.1", "AGENTMOB_BRIDGE_MAX_S": "1",
                   "AGENTMOB_BRIDGE_ESCALATE_AFTER": "4"})

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

import logging


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


def ctl_connections():
    """How many ESTABLISHED sockets the sidecar's ctl port has — proof from the OS, not us."""
    try:
        out = subprocess.run(["lsof", "-nP", f"-iTCP:{CTL_PORT}", "-sTCP:ESTABLISHED"],
                             capture_output=True, text=True, timeout=10).stdout
        return max(0, len(out.strip().split("\n")) - 1)
    except Exception:
        return -1


async def main():
    global PASS
    cap = Capture()
    logger = logging.getLogger(mod.logger.name)
    logger.addHandler(cap)
    logger.setLevel(logging.DEBUG)

    proc = await asyncio.create_subprocess_exec(
        os.environ.get("AGENTMOB_NODE_BIN") or "node", SIDECAR,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        env={**os.environ, "AGENTMOB_PORT": str(WS_PORT), "AGENTMOB_BIND": "127.0.0.1",
             "AGENTMOB_SIDECAR_PORT": str(CTL_PORT)},
        start_new_session=True,
    )
    sidecar_pid = proc.pid
    await asyncio.sleep(3)

    a = object.__new__(mod.AgentMobAdapter)
    a._proc = proc
    a._sidecar_port = CTL_PORT
    a._token = "dev"
    a._reader = a._writer = None
    a._connected = False
    a._handle_sidecar_event = lambda evt: asyncio.sleep(0)

    task = asyncio.ensure_future(a._connect_bridge())

    async def wait_connected(timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if a._connected and a._writer is not None and not a._writer.is_closing():
                return True
            await asyncio.sleep(0.02)
        return False

    ok("bridge connects to a real sidecar", await wait_connected(10), "never connected")
    first_writer = a._writer
    ok("the OS sees an established ctl connection", ctl_connections() >= 1,
       f"lsof says {ctl_connections()}")

    # Traffic works BEFORE the break — otherwise "traffic resumed" proves nothing.
    a._writer.write(b'{"type":"noop","phase":"before"}\n')
    await a._writer.drain()
    ok("traffic flows before the break (drain completed)", True)

    # ---- break the bridge mid-run: close the socket underneath it -------------------------
    print("\n  breaking the bridge (closing the socket the adapter holds)…")
    broke_at = time.monotonic()
    a._writer.close()
    try:
        await asyncio.wait_for(a._writer.wait_closed(), 2)
    except Exception:
        pass

    recovered = await wait_connected(15)
    recover_s = time.monotonic() - broke_at

    ok("the adapter RECONNECTED on its own", recovered, f"still down after {recover_s:.2f}s")
    ok("it is a NEW socket, not the closed one", a._writer is not first_writer)
    ok("the new socket is open", a._writer is not None and not a._writer.is_closing())
    print(f"  measured recovery: {recover_s * 1000:.0f} ms")
    ok("recovery took under 5s", recover_s < 5, f"{recover_s:.2f}s")

    # ---- traffic actually resumes ----------------------------------------------------------
    sent_ok = True
    try:
        a._writer.write(b'{"type":"noop","phase":"after"}\n')
        await a._writer.drain()
    except Exception as e:
        sent_ok = False
        print(f"    write after recovery failed: {e}")
    ok("traffic RESUMES after recovery (write + drain succeed)", sent_ok)
    ok("the OS sees an established ctl connection again", ctl_connections() >= 1,
       f"lsof says {ctl_connections()}")

    # ---- and the sidecar was never restarted ----------------------------------------------
    ok("the sidecar was NOT restarted (same pid throughout)", proc.pid == sidecar_pid,
       f"{sidecar_pid} -> {proc.pid}")
    ok("the sidecar is still the same live process", proc.returncode is None)

    warns = cap.at(logging.WARNING)
    ok("the loss was logged at WARNING, not swallowed at debug",
       any("bridge lost" in m or "bridge error" in m or "connect failed" in m for m in warns),
       "; ".join(warns[:3]))
    ok("the reconnection is announced", any("RECONNECTED" in m for m in warns),
       "; ".join(warns[:3]))

    # ---- a second break proves it is a loop, not a one-shot retry --------------------------
    print("\n  breaking it a second time…")
    second_writer = a._writer
    t2 = time.monotonic()
    a._writer.close()
    try:
        await asyncio.wait_for(a._writer.wait_closed(), 2)
    except Exception:
        pass
    again = await wait_connected(15)
    print(f"  measured recovery #2: {(time.monotonic() - t2) * 1000:.0f} ms")
    ok("it recovers REPEATEDLY (a loop, not a single retry)", again)
    ok("and again on a fresh socket", a._writer is not second_writer)

    # ---- the case that was actually TERMINAL: an unexpected exception ----------------------
    # Closing the socket (above) produces a clean EOF, which the ORIGINAL code already survived
    # — its `while True` looped and reconnected in ~22ms. The genuinely fatal path was
    # `except Exception: logger.debug(...); return`: ANY unexpected error ended the bridge for
    # good, invisibly, while the sidecar kept running. So inject that class of failure.
    print("\n  injecting an unexpected exception inside the bridge…")
    real_consume = a._consume_inbound
    state = {"n": 0}

    async def flaky_consume():
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("canary: unexpected bridge error")
        return await real_consume()

    a._consume_inbound = flaky_consume
    third_writer = a._writer
    t3 = time.monotonic()
    a._writer.close()
    try:
        await asyncio.wait_for(a._writer.wait_closed(), 2)
    except Exception:
        pass

    survived = await wait_connected(15)
    t3_ms = (time.monotonic() - t3) * 1000
    ok("an UNEXPECTED exception is not terminal for the bridge", survived,
       "bridge died permanently — this is the case the old code could not survive")
    ok("it raised where we think it did (the injection actually fired)", state["n"] >= 1,
       f"consume called {state['n']}x")
    if survived:
        print(f"  measured recovery after an unexpected exception: {t3_ms:.0f} ms")
    ok("it reconnected on a fresh socket after the exception", a._writer is not third_writer)
    warns_x = cap.at(logging.WARNING)
    ok("the unexpected error is visible at WARNING (was debug-only)",
       any("bridge error" in m and "canary" in m for m in warns_x),
       "; ".join([m for m in warns_x if "bridge" in m][:2]))
    a._consume_inbound = real_consume

    # Cancelling must actually stop it. _consume_inbound used to swallow CancelledError, so
    # the bridge reconnected forever and the task could never be shut down — a hang that only
    # appeared once the bridge stopped giving up on errors.
    task.cancel()
    stopped = True
    try:
        await asyncio.wait_for(task, 5)
    except asyncio.CancelledError:
        pass
    except asyncio.TimeoutError:
        stopped = False
    except Exception:
        pass
    ok("the bridge task can still be CANCELLED (shutdown does not hang)", stopped,
       "task ignored cancellation")
    logger.removeHandler(cap)

    # Reap the throwaway sidecar through its own group.
    mod._signal_group(sidecar_pid, __import__("signal").SIGKILL)
    try:
        await asyncio.wait_for(proc.wait(), 5)
    except Exception:
        pass


asyncio.run(main())
print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
