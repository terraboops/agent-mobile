"""outbound-queue.test — "the user is told" must survive a bridge reconnect.

_send_to_sidecar is the single road every outbound message takes: agent replies, the "heard you"
status, and every user-facing failure notice added across this codebase. It dropped on a closed
bridge and returned False — and NOTHING checks that return value. So every "the user is told"
guarantee written elsewhere was quietly conditional on the bridge being up at that instant.
Reconnects are fast (110-220ms measured) but a reply lands in that window sooner or later.

The fix is not "queue everything". A stale status indicator, or speech arriving after the moment
it belonged to, is worse than nothing — the same reasoning as not retrying a TTS turn that
already failed. So the SELECTIVITY is the load-bearing part of this test: a version that queued
all of it, or none of it, would pass a sloppier one.

Run: npm run outbound-queue
"""
import asyncio
import importlib.util
import json
import logging
import os
import sys
import time

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

os.environ.update({"AGENTMOB_OUTBOUND_QUEUE_MAX": "5", "AGENTMOB_OUTBOUND_MAX_AGE_S": "1.0"})

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


class FakeWriter:
    def __init__(self, closing=False, explode=False):
        self.buf = []
        self._closing = closing
        self.explode = explode

    def is_closing(self):
        return self._closing

    def write(self, b):
        if self.explode:
            raise OSError("canary: socket write failed")
        self.buf.append(json.loads(b.decode().strip()))

    def types(self):
        return [m.get("type") for m in self.buf]


def make_adapter():
    a = object.__new__(mod.AgentMobAdapter)
    a._writer = None
    a._outbound_q = __import__("collections").deque(maxlen=mod._OUTBOUND_QUEUE_MAX)
    return a


# ---- 1. bridge down: durable text is HELD, ephemeral is dropped ---------------------------
cap1 = Capture()
logger.addHandler(cap1)

a = make_adapter()
a._writer = None                               # bridge is gone

a._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "speech recognition is broken"}})
a._send_to_sidecar({"type": "push", "d": {"type": "text", "text": "voice output is off"}})
a._send_to_sidecar({"type": "status", "d": {"working": True}})
a._send_to_sidecar({"type": "typing"})
a._send_to_sidecar({"type": "pcm", "pcm_b64": "AAAA"})

held = [p.get("type") for _, p in a._outbound_q]
logger.removeHandler(cap1)

ok("down: a user-facing reply is held", "reply" in held, str(held))
ok("down: a user-facing push is held", "push" in held, str(held))
ok("down: a status indicator is NOT held (stale is worse than absent)", "status" not in held, str(held))
ok("down: typing is NOT held", "typing" not in held, str(held))
ok("down: audio is NOT held (speech arriving late is worse than none)", "pcm" not in held, str(held))
ok("down: the drop of a time-sensitive message is still logged",
   any("time-sensitive" in m for m in cap1.at(logging.WARNING)),
   "; ".join(cap1.at(logging.WARNING)[:2]))
ok("down: the queueing is logged at WARNING, not debug",
   any("queued" in m for m in cap1.at(logging.WARNING)))

# ---- 2. reconnect flushes exactly what was held --------------------------------------------
cap2 = Capture()
logger.addHandler(cap2)
w = FakeWriter()
a._writer = w
sent = a._flush_outbound()
logger.removeHandler(cap2)

ok("flush: both durable messages were delivered", sent == 2, f"sent {sent}")
ok("flush: they arrive in order", w.types() == ["reply", "push"], str(w.types()))
ok("flush: the text survived intact",
   w.buf and w.buf[0]["d"]["text"] == "speech recognition is broken", str(w.buf[:1]))
ok("flush: the queue is now empty", len(a._outbound_q) == 0, str(len(a._outbound_q)))
ok("flush: the reconnect delivery is announced",
   any("flushed 2 queued" in m for m in cap2.at(logging.WARNING)),
   "; ".join(cap2.at(logging.WARNING)[:1]))

# ---- 3. a normal send with a live bridge still goes straight out ----------------------------
a2 = make_adapter()
w2 = FakeWriter()
a2._writer = w2
rc = a2._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "hello"}})
ok("live: sent immediately", rc is True and w2.types() == ["reply"], str(w2.types()))
ok("live: nothing was queued", len(a2._outbound_q) == 0)

# ---- 4. stale messages are discarded rather than delivered late -----------------------------
cap4 = Capture()
logger.addHandler(cap4)
a4 = make_adapter()
a4._writer = None
a4._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "old news"}})
# age it past the limit. Guarded: with no queueing at all this is empty, and an IndexError
# here would abort the run instead of reporting the failures it is meant to expose.
if a4._outbound_q:
    a4._outbound_q[0] = (time.monotonic() - 5.0, a4._outbound_q[0][1])
w4 = FakeWriter()
a4._writer = w4
sent4 = a4._flush_outbound()
logger.removeHandler(cap4)

ok("stale: a message older than the limit is NOT delivered", sent4 == 0 and w4.buf == [],
   str(w4.types()))
ok("stale: the discard is reported",
   bool(a4._outbound_q) is False and any("discarded 1" in m for m in cap4.at(logging.WARNING)),
   "; ".join(cap4.at(logging.WARNING)[:1]))

# ---- 5. the queue is bounded (a long outage must not grow without limit) --------------------
a5 = make_adapter()
a5._writer = None
for i in range(20):
    a5._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": f"msg{i}"}})
ok("bounded: the queue never exceeds its cap", len(a5._outbound_q) == mod._OUTBOUND_QUEUE_MAX,
   f"{len(a5._outbound_q)} held, cap is {mod._OUTBOUND_QUEUE_MAX}")
ok("bounded: it keeps the NEWEST messages",
   bool(a5._outbound_q) and a5._outbound_q[-1][1]["d"]["text"] == "msg19",
   str(list(a5._outbound_q)[-1:]))

# ---- 6. a write that explodes is queued, not lost, and logged above debug -------------------
cap6 = Capture()
logger.addHandler(cap6)
a6 = make_adapter()
a6._writer = FakeWriter(explode=True)
rc6 = a6._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "important"}})
logger.removeHandler(cap6)

ok("write-error: returns False", rc6 is False)
ok("write-error: the message is retained for the next connection", len(a6._outbound_q) == 1,
   str(len(a6._outbound_q)))
ok("write-error: logged at WARNING (was debug)",
   any("failed to write" in m for m in cap6.at(logging.WARNING)),
   "; ".join(cap6.at(logging.WARNING)[:1]))

# ---- 7. the bridge dying DURING a flush keeps the rest ---------------------------------------
a7 = make_adapter()
a7._writer = None
for i in range(3):
    a7._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": f"m{i}"}})


class DiesAfterOne(FakeWriter):
    def write(self, b):
        if self.buf:
            self._closing = True
            raise OSError("canary: bridge died mid-flush")
        super().write(b)


a7._writer = DiesAfterOne()
a7._flush_outbound()
ok("mid-flush failure: the undelivered remainder is kept", len(a7._outbound_q) >= 2,
   f"{len(a7._outbound_q)} kept — the rest were lost")

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
