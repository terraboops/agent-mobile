"""adapter-fields.test — a hand-built test adapter must not be a different object than production.

Nine tests build their adapter with `object.__new__(AgentMobAdapter)` and set fields by hand,
because constructing the real one needs a Hermes config. That is a reasonable shortcut with one
sharp edge: when `__init__` gains a field, every hand-built adapter silently lacks it, and the
tests keep passing while exercising an object production never runs.

That has happened twice in one day:
  _outbound_q   added with the outbound queue -> bridge-recovery and inbound-resilience broke
  _connected    added after the live flush finding -> outbound-queue broke

Both were caught by an AttributeError at runtime, which only works when the missing field is on
the path the test happens to exercise. A fake missing a field that the test does NOT touch is
invisible — it just quietly tests something else.

So: every hand-built adapter must carry every field the real `__init__` sets, or name the
omission explicitly in OMIT below. A deliberate, reviewed exclusion is fine; an accidental one
is the bug. When `__init__` grows a field, this fails until someone decides which it is.

Run: npm run adapter-fields
"""
import os
import re
import sys
from pathlib import Path

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
TESTS = Path(__file__).resolve().parent
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


def real_init_fields():
    """Fields the real constructor sets, read from its body."""
    src = open(ADAPTER, encoding="utf8").read()
    i = src.index("    def __init__")
    j = src.index("\n    def ", i + 10)
    body = src[i:j]
    return set(re.findall(r"self\.(_[A-Za-z0-9_]+)\s*(?::[^=\n]+)?=", body))


def fake_fields(path):
    """Fields a test assigns onto its hand-built adapter.

    Covers the three shapes actually in use: direct attribute assignment, dict-literal keys fed
    through a setattr loop, and per-instance assignment on differently-named variables.
    """
    src = path.read_text(encoding="utf8")
    got = set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\.(_[A-Za-z0-9_]+)\s*=", src))
    got |= set(re.findall(r'["\'](_[A-Za-z0-9_]+)["\']\s*:', src))
    return got


REAL = real_init_fields()
ok("the real constructor's fields were found", len(REAL) > 20, f"{len(REAL)} fields")

# Config-only scalars a fake has no reason to carry: they are read by engine selection and
# voice config, never by the transport/turn machinery these tests drive. Every entry here is a
# deliberate exclusion — the point is that it is WRITTEN DOWN, not that it is absent.
OMIT_EVERYWHERE = {
    "_TURN_LOCK_MAX_S",          # class constant, not per-instance state
    "_platform", "_home_channel", "_home_ensured",
    "_stt_model", "_tts_voice", "_edge_voice", "_kitten_voice", "_kitten",
    "_whisper",                  # lazily-loaded STT model cache; every fake stubs _transcribe

    "_f5_ref", "_f5_ref_text", "_tts_engine",
    "_allowed_clients", "_ice", "_bind", "_port", "_node_bin",
    "_sidecar_port", "_token", "_surface_state", "_surface_feedback",
    "_speak_due", "_pending_speak", "_speak_gen", "_deferred", "_pending_i",
    "_turn_lock", "_turn_started", "_turn_timeout_task", "_long_ack_task",
    "_reader", "_writer", "_proc", "_dispatcher", "_supervisor",
    "_stt_lock", "_tts_dead", "_tts_unavail_notified",
}

# DERIVED, not hand-listed. Everything the real constructor sets that is not explicitly
# excused above is required of a fake.
#
# This was a hand-written set, and that made my own red-proof of this test CIRCULAR: to show it
# failed when __init__ gained a field, I added the field to __init__ *and* to the list. Of
# course it failed — I had told it to care. The mutation run then caught what the red-proof
# could not: adding a field to __init__ alone changed nothing, because the list did not know
# about it. The claim "when __init__ grows a field, every fake fails until someone decides" was
# only true if I remembered to edit this set, which is exactly the remembering the check exists
# to replace.
REQUIRED = REAL - OMIT_EVERYWHERE
ok("every REQUIRED field is genuinely set by the real constructor", REQUIRED <= REAL)
ok("the omit list does not claim fields the constructor never sets",
   not (OMIT_EVERYWHERE - REAL - {"_TURN_LOCK_MAX_S"}),
   f"stale entries: {sorted(OMIT_EVERYWHERE - REAL - {'_TURN_LOCK_MAX_S'})}")
ok("REQUIRED is derived from the constructor, not hand-maintained",
   len(REQUIRED) > 0 and REQUIRED == (REAL - OMIT_EVERYWHERE))


# Tests that hand-build an adapter. Each may exempt fields it deliberately does not need.
HAND_BUILT = {
    "dispatch-delivery.test.py": {"_outbound_q", "_connected", "_undelivered",
                                  "_sidecar_stderr", "_restart_times", "_sidecar_fails",
                                  "_sidecar_wedged", "_sidecar_flapping", "_flap_reports"},
    "inbound-resilience.test.py": {"_undelivered", "_sidecar_stderr", "_restart_times",
                                   "_sidecar_fails", "_sidecar_wedged", "_sidecar_flapping",
                                   "_flap_reports"},
    "bridge-recovery.test.py": {"_undelivered", "_sidecar_stderr", "_restart_times",
                                "_sidecar_fails", "_sidecar_wedged", "_sidecar_flapping",
                                "_flap_reports"},
    "flush-live.test.py": set(),
    "outbound-queue.test.py": {"_sidecar_stderr", "_restart_times", "_sidecar_fails",
                               "_sidecar_wedged", "_sidecar_flapping", "_flap_reports"},
    "respawn-escalation.test.py": {"_outbound_q", "_undelivered"},
    "stt-failfast.test.py": {"_outbound_q", "_connected", "_undelivered", "_sidecar_stderr",
                             "_restart_times", "_sidecar_fails", "_sidecar_wedged",
                             "_sidecar_flapping", "_flap_reports"},
    "tts-failfast.test.py": {"_outbound_q", "_connected", "_undelivered", "_sidecar_stderr",
                             "_restart_times", "_sidecar_fails", "_sidecar_wedged",
                             "_sidecar_flapping", "_flap_reports"},
    "transcribe-capture.test.py": {"_outbound_q", "_connected", "_undelivered",
                                   "_sidecar_stderr", "_restart_times", "_sidecar_fails",
                                   "_sidecar_wedged", "_sidecar_flapping", "_flap_reports"},
}

SELF = Path(__file__).name
found = sorted(p.name for p in TESTS.glob("*.test.py")
               if p.name != SELF and "object.__new__" in p.read_text(encoding="utf8"))
ok("every hand-building test is covered by this check",
   set(found) == set(HAND_BUILT),
   f"uncovered: {sorted(set(found) - set(HAND_BUILT))}; stale: {sorted(set(HAND_BUILT) - set(found))}")

for name, exempt in sorted(HAND_BUILT.items()):
    path = TESTS / name
    if not path.exists():
        ok(f"{name}: present", False, "listed here but missing")
        continue
    got = fake_fields(path)
    missing = (REQUIRED - got) - exempt
    ok(f"{name}: carries the state fields it does not exempt", not missing,
       f"missing {sorted(missing)} — this fake is a different object than production runs")

# orphan-reap does NOT hand-build an adapter; it drives module-level reaping and a subprocess.
# Its docstring used to claim "a real AgentMobAdapter instance", which was never true.
orphan = (TESTS / "orphan-reap.test.py").read_text(encoding="utf8")
ok("orphan-reap builds no adapter (so field parity does not apply to it)",
   "object.__new__" not in orphan)
ok("orphan-reap no longer claims to use a real adapter instance",
   "real AgentMobAdapter instance" not in orphan,
   "the docstring still overstates what it does")

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
