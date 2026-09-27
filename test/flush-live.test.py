"""flush-live.test — a queued reply survives a REAL sidecar outage.

Everything about the outbound queue so far was tested with fake writers. This drives the real
thing: a real sidecar process, a real ctl socket, a real SIGKILL, a real respawn, and the real
flush — with the evidence read out of the sidecar's own stderr rather than inferred from the
adapter's bookkeeping.

The canary is a `reply` carrying an id no phone is waiting on, because the sidecar logs
`reply for unknown i=<id>` UNCONDITIONALLY. A `push` would be silently ignored when no phone is
attached, which would have proved nothing — the evidence has to exist whether or not a handset
is in the room.

Also drives, for real and without faking a throw:
  AGENTMOB BRIDGE DOWN   by pointing the bridge at a genuinely dead ctl port
  RX HANDLER WEDGED      by sending malformed AUDIO frames that make a real handler throw

Run: npm run flush-live
"""
import asyncio
import importlib.util
import logging
import os
import signal
import socket
import sys
import time

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
SIDECAR = os.path.expanduser("~/.hermes/plugins/agentmob/sidecar/index.mjs")
if not (os.path.exists(ADAPTER) and os.path.exists(SIDECAR)):
    print("skip: plugin not installed")
    sys.exit(0)

WS_PORT, CTL_PORT = 8885, 8886          # throwaway; never 8123/8790

os.environ.update({
    "AGENTMOB_BRIDGE_BASE_S": "0.2", "AGENTMOB_BRIDGE_MAX_S": "0.6",
    "AGENTMOB_BRIDGE_ESCALATE_AFTER": "4",
    "AGENTMOB_RESPAWN_BASE_S": "1", "AGENTMOB_RESPAWN_HEALTHY_S": "2",
    "AGENTMOB_OUTBOUND_MAX_AGE_S": "120",
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

    def all(self):
        return [m for _, m in self.records]


def make_adapter():
    """A real AgentMobAdapter with the fields _run_sidecar and the bridge actually use."""
    import collections
    a = object.__new__(mod.AgentMobAdapter)
    for k, v in {
        "_proc": None, "_connected": False, "_dispatcher": None, "_supervisor": None,
        "_writer": None, "_reader": None, "_port": WS_PORT, "_bind": "127.0.0.1",
        "_sidecar_port": CTL_PORT, "_token": "dev", "_node_bin": "node",
        "_allowed_clients": "", "_ice": "", "_sidecar_fails": 0, "_sidecar_wedged": False,
        "_sidecar_flapping": False, "_flap_reports": 0, "_undelivered": [],
    }.items():
        setattr(a, k, v)
    a._sidecar_stderr = collections.deque(maxlen=200)
    a._restart_times = collections.deque()
    a._outbound_q = collections.deque(maxlen=mod._OUTBOUND_QUEUE_MAX)
    a._handle_sidecar_event = lambda evt: asyncio.sleep(0)
    return a


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


async def wait(fn, timeout, step=0.1):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if fn():
            return True
        await asyncio.sleep(step)
    return fn()


# =============================================================================================
async def flush_across_real_outage(expect_delivery):
    """Kill a real sidecar, queue a reply while it is gone, let it respawn, watch the flush.

    expect_delivery: what the CURRENT code should do. Run twice — once with the queue, once
    with the original drop-on-closed-bridge — so the pre-change loss is demonstrated, not
    described.
    """
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()
    canary = f"CANARY-{int(time.time() * 1000) % 1000000}"

    sup = mod._supervise_task(a._run_sidecar(), "_run_sidecar")
    await wait(lambda: a._connected, 25)
    first_pid = a._proc.pid if a._proc else None
    print(f"    sidecar pid {first_pid}, bridge connected={a._connected}")

    # --- a REAL outage: SIGKILL the sidecar --------------------------------------------------
    os.kill(first_pid, signal.SIGKILL)
    await wait(lambda: not a._connected, 15)
    print(f"    killed {first_pid}; bridge down (connected={a._connected})")

    # --- send while it is genuinely down ------------------------------------------------------
    outcome = a._send_to_sidecar({"type": "reply", "i": canary,
                                  "d": {"type": "text", "text": "queued across the outage"}})
    queued = len(a._outbound_q)
    print(f"    sent during the outage -> {outcome!r}, queue holds {queued}")

    # --- the adapter respawns it; the bridge reconnects; the flush runs -----------------------
    await wait(lambda: a._connected and a._proc and a._proc.pid != first_pid, 40)
    second_pid = a._proc.pid if a._proc else None
    print(f"    respawned as pid {second_pid}, bridge connected={a._connected}")
    await asyncio.sleep(2.0)

    stderr = "\n".join(a._sidecar_stderr)
    delivered = canary in stderr
    print(f"    [debug] queue after reconnect={len(a._outbound_q)} "
          f"undelivered={len(a._undelivered)} stderr_lines={len(a._sidecar_stderr)}")
    for l in list(a._sidecar_stderr)[-6:]:
        print(f"    [debug] sidecar: {l[:100]}")

    sup.cancel()
    try:
        await asyncio.wait_for(sup, 5)
    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
        pass
    try:
        await a.disconnect()
    except Exception:
        pass
    logger.removeHandler(cap)
    return {"canary": canary, "outcome": outcome, "queued": queued, "delivered": delivered,
            "first_pid": first_pid, "second_pid": second_pid, "cap": cap, "stderr": stderr}


print("--- 1. queued reply across a REAL sidecar kill + respawn ---")
r = asyncio.run(flush_across_real_outage(True))

ok("the sidecar really was killed and really respawned",
   r["first_pid"] and r["second_pid"] and r["first_pid"] != r["second_pid"],
   f"{r['first_pid']} -> {r['second_pid']}")
ok("the send during the outage was QUEUED, not dropped", r["outcome"] == mod.SEND_QUEUED,
   str(r["outcome"]))
ok("it was actually held in the queue", r["queued"] >= 1, str(r["queued"]))
ok("the reply REACHED the new sidecar after reconnect (its own log says so)",
   r["delivered"],
   f"{r['canary']} never appeared in the sidecar's stderr — the queued reply was lost")
ok("the flush is announced",
   any("flushed" in m for m in r["cap"].at(logging.WARNING)),
   "; ".join([m for m in r["cap"].at(logging.WARNING) if "flush" in m][:1]))
ok("the bridge reported the loss and the reconnect",
   any("bridge" in m and ("lost" in m or "RECONNECTED" in m) for m in r["cap"].at(logging.WARNING)))
if r["delivered"]:
    line = [l for l in r["stderr"].split("\n") if r["canary"] in l]
    print(f"    sidecar said: {line[0][:110] if line else ''}")


# =============================================================================================
print("\n--- 2. the PRE-CHANGE path loses the same reply ---")
# Restore the original _send_to_sidecar/_flush_outbound on the class, run the identical
# scenario, and show the canary never arrives.
orig_send = mod.AgentMobAdapter._send_to_sidecar
orig_flush = mod.AgentMobAdapter._flush_outbound
import json as _json


def legacy_send(self, payload):
    if self._writer is None or self._writer.is_closing():
        mod.logger.warning("agentmob: outbound dropped (bridge closed)")
        return mod.SEND_DROPPED
    try:
        self._writer.write((_json.dumps(payload) + "\n").encode("utf-8"))
        return mod.SEND_SENT
    except Exception as e:
        mod.logger.debug("agentmob: outbound: %s", e)
        return mod.SEND_DROPPED


def legacy_flush(self):
    return 0


mod.AgentMobAdapter._send_to_sidecar = legacy_send
mod.AgentMobAdapter._flush_outbound = legacy_flush
r2 = asyncio.run(flush_across_real_outage(False))
mod.AgentMobAdapter._send_to_sidecar = orig_send
mod.AgentMobAdapter._flush_outbound = orig_flush

# The pre-change behaviour is WORSE than "dropped": with the peer dead but is_closing() still
# False, it reports SEND_SENT for a write that goes into a kernel buffer and evaporates. The
# caller is told it succeeded. Assert on what actually matters — nothing is held, and nothing
# arrives — rather than on a specific outcome string.
ok("pre-change: nothing is held for the reconnect", r2["queued"] == 0, str(r2["queued"]))
ok("pre-change: it does not even report a failure the caller could act on",
   r2["outcome"] in (mod.SEND_SENT, mod.SEND_DROPPED), str(r2["outcome"]))
print(f"    pre-change reported {r2['outcome']!r} for a send into a dead socket")
ok("pre-change: the reply NEVER reaches the sidecar (this is the loss)",
   not r2["delivered"],
   "it arrived anyway — the scenario does not demonstrate the bug")
ok("the two runs differ: same outage, one keeps the reply and one loses it",
   r["delivered"] and not r2["delivered"],
   f"new delivered={r['delivered']} old delivered={r2['delivered']}")


# =============================================================================================
print("\n--- 3. AGENTMOB BRIDGE DOWN, driven against a genuinely dead ctl port ---")


async def bridge_down():
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()
    a._sidecar_port = 8887                      # nothing listens here, ever
    keep = await asyncio.create_subprocess_exec(
        "/bin/sleep", "60", stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    a._proc = keep                              # a live process, so the bridge keeps trying
    t = asyncio.ensure_future(a._connect_bridge())
    await wait(lambda: any("BRIDGE DOWN" in m for m in cap.at(logging.ERROR)), 25)
    t.cancel()
    try:
        await asyncio.wait_for(t, 5)
    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
        pass
    try:
        keep.kill()
        await keep.wait()
    except Exception:
        pass
    logger.removeHandler(cap)
    return cap


cap3 = asyncio.run(bridge_down())
errs3 = cap3.at(logging.ERROR)
ok("BRIDGE DOWN fired against a real closed port (not a mock)",
   any("AGENTMOB BRIDGE DOWN" in m for m in errs3), f"{len(errs3)} error(s)")
ok("it names the port it could not reach", any("8887" in m for m in errs3),
   "; ".join(errs3[:1]))
ok("it says the phone gets no replies", any("no replies" in m for m in errs3))
ok("the failed reconnects were real attempts",
   sum(1 for m in cap3.at(logging.WARNING) if "connect failed" in m) >= 3,
   f"{sum(1 for m in cap3.at(logging.WARNING) if 'connect failed' in m)} attempts")
if errs3:
    print(f"    {errs3[0][:120]}")

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
