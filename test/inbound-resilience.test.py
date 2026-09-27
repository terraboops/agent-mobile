"""inbound-resilience.test — a failing handler must not cost the connection, or hide.

`_consume_inbound` used to wrap the socket read and the event handler in ONE try block and
`break` at debug level. So an event the handler choked on tore down a perfectly healthy socket:
_connect_bridge reconnected, read the same kind of event, choked again — connect, read, throw,
reconnect, forever. The log showed bridge churn and, at debug, nothing about the cause.

A failing handler is not a broken socket. This drives the real `_consume_inbound` against a
stand-in ctl server that speaks the sidecar's NDJSON protocol (the real sidecar emits nothing
without a phone, and this needs events on demand), and counts ACCEPTED CONNECTIONS — the
observable that separates the two behaviours:

    old: one reconnect per poisonous event, cause invisible
    new: one connection throughout, cause at WARNING, escalating to ERROR

Run: npm run inbound-resilience
"""
import asyncio
import importlib.util
import json
import logging
import os
import sys

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

os.environ.update({"AGENTMOB_BRIDGE_BASE_S": "0.05", "AGENTMOB_BRIDGE_MAX_S": "0.2",
                   "AGENTMOB_INBOUND_ERROR_ESCALATE": "3"})

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


class FakeSidecar:
    """Speaks the sidecar's ctl protocol: read a token line, then push NDJSON events."""

    def __init__(self):
        self.connections = 0
        self.server = None
        self.writers = []

    async def start(self):
        self.server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        return self.server.sockets[0].getsockname()[1]

    async def _client(self, reader, writer):
        self.connections += 1
        await reader.readline()          # the auth token
        self.writers.append(writer)

    async def push(self, obj):
        """Send one event to every live client."""
        data = (json.dumps(obj) + "\n").encode()
        for w in list(self.writers):
            try:
                w.write(data)
                await w.drain()
            except Exception:
                self.writers.remove(w)

    async def stop(self):
        for w in list(self.writers):
            try:
                w.close()
            except Exception:
                pass
        self.server.close()
        await self.server.wait_closed()


async def main():
    cap = Capture()
    logger = logging.getLogger(mod.logger.name)
    logger.addHandler(cap)
    logger.setLevel(logging.DEBUG)

    fake = FakeSidecar()
    port = await fake.start()

    # A live process so the bridge does not exit thinking the sidecar is gone.
    keepalive = await asyncio.create_subprocess_exec(
        "/bin/sleep", "120", stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)

    a = object.__new__(mod.AgentMobAdapter)
    a._proc = keepalive
    a._sidecar_port = port
    a._token = "dev"
    a._reader = a._writer = None
    a._connected = False

    seen = []

    async def handler(evt):
        seen.append(evt)
        if evt.get("type") == "poison":
            raise RuntimeError("canary: handler cannot process this event")

    a._handle_sidecar_event = handler

    task = asyncio.ensure_future(a._connect_bridge())
    for _ in range(100):
        if a._connected:
            break
        await asyncio.sleep(0.02)
    ok("bridge connected to the stand-in sidecar", a._connected)
    ok("exactly one connection so far", fake.connections == 1, f"{fake.connections}")

    # ---- a healthy event still works ---------------------------------------------------
    await fake.push({"type": "hello"})
    await asyncio.sleep(0.3)
    ok("a normal event is handled", any(e.get("type") == "hello" for e in seen))

    # ---- the poisonous events: handler raises on every one ------------------------------
    before = fake.connections
    for i in range(6):
        await fake.push({"type": "poison", "i": i})
        await asyncio.sleep(0.15)

    poisons = [e for e in seen if e.get("type") == "poison"]
    ok("EVERY poisonous event was read, not just the first",
       len(poisons) >= 5, f"only {len(poisons)} reached the handler")
    ok("the connection was NOT torn down by the handler failures",
       fake.connections == before,
       f"reconnected {fake.connections - before}x — the socket is paying for a handler bug")
    ok("the bridge is still connected", a._connected)

    warns = cap.at(logging.WARNING)
    errors = cap.at(logging.ERROR)
    ok("each handler failure is visible at WARNING (was debug-only)",
       sum(1 for m in warns if "inbound handler failed" in m) >= 5,
       f"{sum(1 for m in warns if 'inbound handler failed' in m)} warning(s)")
    ok("the warning names the event type it choked on",
       any("'poison'" in m or '"poison"' in m for m in warns), "; ".join(warns[:2]))
    ok("the original exception is carried",
       any("canary: handler cannot process this event" in m for m in warns))
    ok("it ESCALATES to ERROR once it is clearly not a one-off",
       any("AGENTMOB INBOUND HANDLER FAILING" in m for m in errors),
       f"{len(errors)} error(s)")
    ok("the escalation says the bridge is healthy and this is a handler bug",
       any("handler bug, not a connection problem" in m for m in errors))
    ok("it does not escalate once per event", len(errors) < len(poisons),
       f"{len(errors)} errors for {len(poisons)} bad events")

    # ---- recovery: a good event after the bad ones resets the counter --------------------
    cap.records.clear()
    await fake.push({"type": "hello-again"})
    await asyncio.sleep(0.3)
    ok("a good event is still processed after the failures",
       any(e.get("type") == "hello-again" for e in seen))
    await fake.push({"type": "poison", "i": 99})
    await asyncio.sleep(0.2)
    ok("one bad event after a success is only a WARNING, not an escalation",
       not any("INBOUND HANDLER FAILING" in m for m in cap.at(logging.ERROR)),
       "escalated on a single failure")

    # ---- a real socket loss DOES still reconnect ----------------------------------------
    before2 = fake.connections
    for w in list(fake.writers):
        w.close()
    fake.writers.clear()
    for _ in range(150):
        if fake.connections > before2 and a._connected:
            break
        await asyncio.sleep(0.02)
    ok("a genuine socket loss still triggers a reconnect",
       fake.connections > before2,
       "the loop stopped reconnecting — socket errors must still end the read loop")

    task.cancel()
    try:
        await asyncio.wait_for(task, 5)
    except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
        pass
    logger.removeHandler(cap)
    await fake.stop()
    try:
        keepalive.kill()
        await keepalive.wait()
    except Exception:
        pass


asyncio.run(main())
print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
