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
    a._undelivered = []
    # _send_to_sidecar gates on _connected as well as the socket, because a socket whose peer
    # has died still reports is_closing() == False. Tests that hand it a live writer must say
    # the bridge is up, or they are asserting against a bridge that is down.
    a._connected = False
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
a._connected = True
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
a2._connected = True
rc = a2._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "hello"}})
ok("live: sent immediately", rc == mod.SEND_SENT and w2.types() == ["reply"],
   f"{rc} {w2.types()}")
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
a4._connected = True
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
a6._connected = True
rc6 = a6._send_to_sidecar({"type": "reply", "d": {"type": "text", "text": "important"}})
logger.removeHandler(cap6)

ok("write-error: reported as queued, not as sent", rc6 == mod.SEND_QUEUED, str(rc6))
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
a7._connected = True
a7._flush_outbound()
ok("mid-flush failure: the undelivered remainder is kept", len(a7._outbound_q) >= 2,
   f"{len(a7._outbound_q)} kept — the rest were lost")


# ---- 8. the kind that decides queue-vs-drop is the INNER one -------------------------------
# _push_status sends {"type": "push", "d": {"type": "status"}}. Classifying on the OUTER type
# alone queued stale status indicators — the precise thing the selectivity exists to prevent,
# and the opposite of what the docs table claimed. Caught by auditing the callers, not the code.
cap8 = Capture()
logger.addHandler(cap8)
a8 = make_adapter()
a8._writer = None
a8._push_status = mod.AgentMobAdapter._push_status.__get__(a8)
a8._push_status(working=True)
a8._push_status(heard=True)
logger.removeHandler(cap8)

held8 = [p for _, p in a8._outbound_q]
ok("inner-kind: a status push is NOT queued despite its outer type being 'push'",
   held8 == [], f"queued {[p.get('d', {}).get('type') for p in held8]} — stale status would be "
                f"delivered on reconnect")
ok("inner-kind: it is reported as dropped, not queued",
   a8._send_to_sidecar({"type": "push", "d": {"type": "status", "working": False}})
   == mod.SEND_DROPPED)
ok("inner-kind: a real text push is still queued",
   a8._send_to_sidecar({"type": "push", "d": {"type": "text", "text": "real"}})
   == mod.SEND_QUEUED)
ok("inner-kind: a render push is still queued (agent state, not a blinking light)",
   a8._send_to_sidecar({"type": "push", "d": {"type": "render", "ui": {}}})
   == mod.SEND_QUEUED)

# ---- 9. the loss-capable callers must not claim success on a drop --------------------------
# send(), _publish_ui() and _publish_surface() returned SendResult(success=True) unconditionally,
# ignoring whether anything was actually sent. A dropped reply closed the turn over a message
# the user never saw; a dropped render poisoned the agent's render_result feedback loop.
cap9 = Capture()
logger.addHandler(cap9)


def loss_adapter():
    a = make_adapter()
    a._writer = None                       # bridge down
    a._pending_i = None
    a._tts_voice = None
    a._default_controls = lambda: []
    a._push_status = lambda **kw: None
    a._release_turn_after_reply = lambda: None
    a._drain_surface_feedback = lambda: []
    a._surface_state = {}
    a._surface_feedback = []
    return a


async def dropped_reply():
    a = loss_adapter()
    # force the DROP path rather than the queue, so the caller sees a real loss
    a._send_to_sidecar = lambda payload: mod.SEND_DROPPED
    return await mod.AgentMobAdapter.send(a, "agentmobile", "here is your answer")


res9 = asyncio.run(dropped_reply())
logger.removeHandler(cap9)

ok("caller: send() reports FAILURE when the reply was dropped",
   res9.success is False, f"success={res9.success} — the turn closed over a lost reply")
ok("caller: the error says what happened", "could not be delivered" in (res9.error or ""),
   str(res9.error))
ok("caller: the loss is logged with a greppable marker",
   any("AGENTMOB REPLY LOST" in m for m in cap9.at(logging.ERROR)),
   "; ".join(cap9.at(logging.ERROR)[:1]))

cap10 = Capture()
logger.addHandler(cap10)


async def dropped_render():
    a = loss_adapter()
    a._send_to_sidecar = lambda payload: mod.SEND_DROPPED
    a._lint_ui = lambda ui: []
    return await mod.AgentMobAdapter._publish_ui(a, "agentmobile",
                                                 {"components": [{"t": "text", "text": "hi"}]})


try:
    res10 = asyncio.run(dropped_render())
    ok("caller: _publish_ui reports FAILURE when the render was dropped",
       res10.success is False, f"success={res10.success}")
    ok("caller: the render loss is logged",
       any("AGENTMOB RENDER LOST" in m for m in cap10.at(logging.ERROR)),
       "; ".join(cap10.at(logging.ERROR)[:1]))
except Exception as e:
    ok("caller: _publish_ui reports FAILURE when the render was dropped", False, repr(e))
    ok("caller: the render loss is logged", False, repr(e))
logger.removeHandler(cap10)

cap11 = Capture()
logger.addHandler(cap11)


async def dropped_surface():
    a = loss_adapter()
    a._send_to_sidecar = lambda payload: mod.SEND_DROPPED
    # A batch that passes the op linter, so the DELIVERY path is what is under test rather
    # than the validator (an invalid batch returns success=False for the wrong reason and the
    # assertion would pass without the fix).
    return await mod.AgentMobAdapter._publish_surface(
        a, "agentmobile",
        [{"op": "register_widget_type", "name": "tile", "code": "window.render=()=>{}"},
         {"op": "add_widget", "key": "k1", "type": "tile"},
         {"op": "publish", "key": "k1"}])


try:
    res11 = asyncio.run(dropped_surface())
    ok("caller: _publish_surface reports FAILURE when the ops were dropped",
       res11.success is False, f"success={res11.success}")
    ok("caller: the surface loss is logged",
       any("AGENTMOB SURFACE LOST" in m for m in cap11.at(logging.ERROR)),
       "; ".join(cap11.at(logging.ERROR)[:1]))
except Exception as e:
    ok("caller: _publish_surface reports FAILURE when the ops were dropped", False, repr(e))
    ok("caller: the surface loss is logged", False, repr(e))
logger.removeHandler(cap11)

# A QUEUED reply is NOT a loss — it will arrive, and reporting failure would be its own lie.
async def queued_reply():
    a = loss_adapter()
    a._send_to_sidecar = lambda payload: mod.SEND_QUEUED
    return await mod.AgentMobAdapter.send(a, "agentmobile", "deferred but fine")


res12 = asyncio.run(queued_reply())
ok("caller: a QUEUED reply still reports success (deferred is not lost)",
   res12.success is True, f"success={res12.success}")


# ---- 10. a message that ages out must not stay a silent lie -------------------------------
# send() reports success for a QUEUED message because it will arrive. If the bridge never comes
# back it ages out instead, and by then the turn is closed and the agent believes it answered.
# That cannot be undone retroactively, so the agent is told on its NEXT turn.
cap13 = Capture()
logger.addHandler(cap13)

a13 = make_adapter()
a13._undelivered = []
a13._writer = None
a13._send_to_sidecar({"type": "push", "d": {"type": "text", "text": "the answer you asked for"}})
a13._outbound_q[0] = (time.monotonic() - 999.0, a13._outbound_q[0][1])
a13._writer = FakeWriter()
a13._connected = True
a13._flush_outbound()
logger.removeHandler(cap13)

ok("expired: nothing was delivered late", a13._writer.buf == [], str(a13._writer.types()))
ok("expired: the loss is recorded for the agent", len(a13._undelivered) == 1,
   str(a13._undelivered))
ok("expired: the record says WHAT was lost, not just that something was",
   "the answer you asked for" in (a13._undelivered[0] if a13._undelivered else ""),
   str(a13._undelivered))
ok("expired: logged with a greppable marker",
   any("AGENTMOB UNDELIVERED" in m for m in cap13.at(logging.ERROR)),
   "; ".join(cap13.at(logging.ERROR)[:1]))

# the agent actually receives it on its next turn
a13._surface_feedback = []
a13._surface_state = {}
a13._drain_surface_feedback = lambda: []
augmented = mod.AgentMobAdapter._augment_agent_text(a13, "what did you say?")
ok("expired: the agent is told on its next turn", "[undelivered" in augmented, augmented)
ok("expired: the note carries the lost text so the agent can repeat it",
   "the answer you asked for" in augmented, augmented)
ok("expired: the confession is drained, not repeated for ever",
   "[undelivered" not in mod.AgentMobAdapter._augment_agent_text(a13, "and now?"))

# a render loss is described usefully, not as an opaque blob
a14 = make_adapter()
a14._undelivered = []
a14._writer = None
a14._send_to_sidecar({"type": "push", "d": {"type": "render",
                                            "ui": {"components": [{"t": "chart"}, {"t": "text"}]}}})
a14._outbound_q[0] = (time.monotonic() - 999.0, a14._outbound_q[0][1])
a14._writer = FakeWriter()
a14._connected = True
a14._flush_outbound()
ok("expired: a lost render names its components",
   a14._undelivered and "chart" in a14._undelivered[0], str(a14._undelivered))

# an ephemeral drop is NOT confessed — the agent does not need to re-send a blinking light
a15 = make_adapter()
a15._undelivered = []
a15._writer = None
a15._send_to_sidecar({"type": "push", "d": {"type": "status", "working": True}})
a15._send_to_sidecar({"type": "pcm", "pcm_b64": "AAAA"})
ok("expired: dropped status/pcm are NOT reported to the agent as losses",
   a15._undelivered == [], str(a15._undelivered))

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
