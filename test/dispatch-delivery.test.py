"""dispatch-delivery.test — retry a dropped utterance only when it provably never arrived.

dispatch_text carries the user's actual speech. Dropping it means they spoke, the phone heard
them, and nothing ever answered. That is worth retrying — but only when the agent provably never
received it. handle_message() hands the turn to Hermes and returns immediately, so a failure
raised from inside it leaves delivery UNCERTAIN, and retrying there risks the agent answering
twice. A double answer is worse than a drop: the user hears two replies to one question and
cannot tell which is current.

So the two sides of the delivery boundary must behave DIFFERENTLY, and that difference is the
whole point of this test — a version that retried both, or neither, would pass a sloppier one.

Also covers the audit of _handle_sidecar_event: an unknown event type must not vanish silently.

Run: npm run dispatch-delivery
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


logger = logging.getLogger(mod.logger.name)
logger.setLevel(logging.DEBUG)


def make_adapter():
    a = object.__new__(mod.AgentMobAdapter)
    a._turn_lock = False
    a._turn_started = None
    a._deferred = ""
    a._pending_i = None
    a._surface_feedback = []
    a._surface_state = {}
    a._turn_timeout_task = None
    a._long_ack_task = None
    a._speak_gen = 0
    a._push_status = lambda **kw: None
    a._arm_long_turn_ack = lambda: None
    a._arm_turn_timeout = lambda: None
    a._end_turn_now = lambda: None
    a._augment_agent_text = lambda t: t
    # build_source() delegates to the platform base class; a stand-in with the fields
    # MessageEvent actually reads keeps this test off the Hermes plumbing.
    from types import SimpleNamespace
    a.build_source = lambda **kw: SimpleNamespace(
        platform="agentmob", chat_id="agentmobile", chat_name="Agent Mobile",
        chat_type="dm", user_id="terra", user_name="Terra")
    return a


# ---- 1. failure INSIDE handle_message: delivery uncertain -> must NOT retry ----------------
async def uncertain():
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()
    calls = []

    async def hm(event):
        calls.append(event.text)
        raise RuntimeError("canary: gateway rejected the turn")

    a.handle_message = hm
    await a.dispatch_text("what is the weather")
    logger.removeHandler(cap)
    return calls, cap


calls, cap = asyncio.run(uncertain())
ok("uncertain: handle_message was entered exactly once (NO retry)", len(calls) == 1,
   f"called {len(calls)}x — a retry here risks a double answer")
errs = cap.at(logging.ERROR)
ok("uncertain: the failure is reported at ERROR", any("dispatch failed" in m for m in errs),
   f"{len(errs)} error(s)")
ok("uncertain: it says explicitly that it is NOT retrying",
   any("NOT retrying" in m for m in errs), "; ".join(errs[:1]))
ok("uncertain: it gives the reason (double answer worse than a drop)",
   any("double answer is worse" in m for m in errs))
ok("uncertain: the lost utterance is recorded so it is not merely gone",
   any("what is the weather" in m for m in errs))
ok("uncertain: it is NOT logged as a pre-delivery failure",
   not any("BEFORE delivery" in m for m in cap.at(logging.WARNING)))


# ---- 2. failure BEFORE handle_message: provably pre-delivery -> retry once -----------------
async def predelivery():
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()
    calls = []
    state = {"fail_arm": True}

    def arm():
        # Raised from the last step before the delivery boundary: the agent cannot
        # possibly have seen this turn.
        if state["fail_arm"]:
            state["fail_arm"] = False
            raise RuntimeError("canary: could not arm the turn timeout")

    a._arm_turn_timeout = arm

    async def hm(event):
        calls.append(event.text)

    a.handle_message = hm
    try:
        await a.dispatch_text("set a timer for ten minutes")
    except Exception as e:
        logger.removeHandler(cap)
        return calls, cap, e
    logger.removeHandler(cap)
    return calls, cap, None


calls2, cap2, exc2 = asyncio.run(predelivery())
warns2 = cap2.at(logging.WARNING)
ok("pre-delivery: the utterance was RETRIED and delivered", len(calls2) == 1,
   f"handle_message called {len(calls2)}x — the retry did not happen")
ok("pre-delivery: it is logged as a pre-delivery failure",
   any("BEFORE delivery" in m for m in warns2), "; ".join(warns2[:2]))
ok("pre-delivery: it states the agent provably never saw it",
   any("provably never saw it" in m for m in warns2))
ok("pre-delivery: it did NOT claim the uncertain path",
   not any("NOT retrying" in m for m in cap2.at(logging.ERROR)))
ok("pre-delivery: the retried text is the original utterance",
   calls2 and "set a timer for ten minutes" in calls2[0], str(calls2[:1]))
ok("pre-delivery: dispatch_text did not raise out to its caller", exc2 is None, repr(exc2))

# THE DISCRIMINATION. Both are failures of the same call; only the retry differs.
ok("the two sides of the delivery boundary behave DIFFERENTLY",
   len(calls) == 1 and len(calls2) == 1
   and any("NOT retrying" in m for m in cap.at(logging.ERROR))
   and any("BEFORE delivery" in m for m in cap2.at(logging.WARNING)),
   "uncertain and pre-delivery were treated the same")


# ---- 3. a retry that also fails must not loop or vanish ------------------------------------
async def retry_fails():
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()

    def arm_always():
        raise RuntimeError("canary: arming always fails")

    a._arm_turn_timeout = arm_always
    calls = []

    async def hm(event):
        calls.append(event.text)

    a.handle_message = hm
    await a.dispatch_text("hello there")
    logger.removeHandler(cap)
    return calls, cap


calls3, cap3 = asyncio.run(retry_fails())
ok("retry-fails: it retries ONCE, not forever", len(calls3) == 0)
ok("retry-fails: the final loss is reported at ERROR",
   any("retry also failed" in m for m in cap3.at(logging.ERROR)),
   "; ".join(cap3.at(logging.ERROR)[:1]))
ok("retry-fails: the lost utterance is named", any("hello there" in m for m in cap3.at(logging.ERROR)))


# ---- 4. audit: an unknown sidecar event must not vanish ------------------------------------
async def unknown_event():
    cap = Capture()
    logger.addHandler(cap)
    a = make_adapter()
    await a._handle_sidecar_event({"type": "brand_new_thing", "payload": 1})
    logger.removeHandler(cap)
    return cap


cap4 = asyncio.run(unknown_event())
warns4 = cap4.at(logging.WARNING)
ok("unknown event: logged rather than silently dropped",
   any("unhandled sidecar event type" in m for m in warns4), f"{len(warns4)} warning(s)")
ok("unknown event: names the type", any("brand_new_thing" in m for m in warns4))
ok("unknown event: suggests the real cause (sidecar newer than adapter)",
   any("newer than this adapter" in m for m in warns4))

# ---- 5. audit: _handle_sidecar_event must not swallow, or the read loop never hears --------
src = open(ADAPTER).read()
body = src[src.index("async def _handle_sidecar_event"):src.index("def _push_status")]
ok("_handle_sidecar_event contains no try/except that could eat the WARNING",
   "except" not in body, "it now swallows — _consume_inbound's warning can never fire")

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
