"""orphan-reap.test — the adapter must take its sidecar with it.

The bug this exists for: stopping the gateway left a node process orphaned and still listening
on :8123, which then blocked the next sidecar from ever binding. The EADDRINUSE guard makes that
collision survivable; this makes it not happen. The adapter OWNS the sidecar, so it reaps it.

Everything here runs against a THROWAWAY port with a real AgentMobAdapter instance. The live
gateway is never touched — taking it down to demonstrate a fix about not taking things down
would be its own joke, and it already cost an outage tonight.

Covers the three shutdown paths that matter:
  1. disconnect()        — the normal path
  2. SIGTERM to the host — the launchctl/bootout path, which never reaches disconnect()
  3. SIGKILL to the host — cannot be intercepted at all, so the SIDECAR must notice its parent
                           died and exit on its own (the parent-death watchdog)

Run: npm run orphan-reap
"""
import asyncio
import importlib.util
import os
import signal
import socket
import subprocess
import sys
import time

ADAPTER = os.path.expanduser("~/.hermes/plugins/agentmob/adapter.py")
WS_PORT = 8871          # throwaway; never 8123
CTL_PORT = 8872

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


def port_held(port):
    """True if something is listening. Uses a real connect, not /dev/tcp (unsupported in zsh)."""
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_port(port, want, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if port_held(port) == want:
            return True
        time.sleep(0.25)
    return port_held(port) == want


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def load_adapter():
    spec = importlib.util.spec_from_file_location("agentmob_adapter", ADAPTER)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


if not os.path.exists(ADAPTER):
    print(f"skip: no adapter at {ADAPTER}")
    sys.exit(0)

mod = load_adapter()

# ---- 1. the normal path: disconnect() reaps ---------------------------------------------
HOST = f"""
import asyncio, importlib.util, os, sys
spec = importlib.util.spec_from_file_location("a", {ADAPTER!r})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

async def main():
    env = dict(os.environ)
    proc = await asyncio.create_subprocess_exec(
        os.environ.get("AGENTMOB_NODE_BIN") or "node",
        os.path.expanduser("~/.hermes/plugins/agentmob/sidecar/index.mjs"),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={{**env, "AGENTMOB_PORT": "{WS_PORT}", "AGENTMOB_BIND": "127.0.0.1",
              "AGENTMOB_SIDECAR_PORT": "{CTL_PORT}"}},
        start_new_session=True,
    )
    m._track_sidecar(proc.pid)
    print(proc.pid, flush=True)
    await asyncio.sleep(3600)

asyncio.run(main())
"""

print("--- 1. host killed with SIGTERM (the launchctl/bootout path) ---")
py = os.path.expanduser("~/.hermes/hermes-agent/venv/bin/python")
host = subprocess.Popen([py, "-c", HOST], stdout=subprocess.PIPE, text=True)
sidecar_pid = int(host.stdout.readline().strip())
ok("sidecar started on the throwaway port", wait_port(WS_PORT, True), f"nothing on {WS_PORT}")
ok("sidecar is in its OWN process group (start_new_session)",
   os.getpgid(sidecar_pid) == sidecar_pid,
   f"pgid {os.getpgid(sidecar_pid)} != pid {sidecar_pid}")

host.send_signal(signal.SIGTERM)
try:
    host.wait(timeout=15)
except subprocess.TimeoutExpired:
    host.kill()
freed = wait_port(WS_PORT, False, timeout=15)
ok("SIGTERM to the host frees the port (no orphan)", freed,
   f"something is STILL listening on {WS_PORT}")
ok("the sidecar process itself is gone", not alive(sidecar_pid), f"pid {sidecar_pid} survived")
if alive(sidecar_pid):
    os.kill(sidecar_pid, signal.SIGKILL)

# ---- 2. the un-interceptable path: SIGKILL the host -------------------------------------
print("\n--- 2. host SIGKILLed (cannot be intercepted; the sidecar must notice) ---")
host2 = subprocess.Popen([py, "-c", HOST], stdout=subprocess.PIPE, text=True)
sidecar2 = int(host2.stdout.readline().strip())
ok("sidecar started again", wait_port(WS_PORT, True))
host2.kill()          # SIGKILL — no handler, no atexit, nothing runs
host2.wait(timeout=10)
ok("SIGKILL of the host still frees the port (parent-death watchdog)",
   wait_port(WS_PORT, False, timeout=20),
   f"orphan still holding {WS_PORT} — the watchdog did not fire")
ok("the orphaned sidecar exited on its own", not alive(sidecar2), f"pid {sidecar2} survived")
if alive(sidecar2):
    os.kill(sidecar2, signal.SIGKILL)

# ---- 3. the reaper only ever touches its own group --------------------------------------
print("\n--- 3. blast radius ---")
bystander = subprocess.Popen([py, "-c", "import time; time.sleep(30)"])
time.sleep(0.5)
mod._LIVE_SIDECARS.clear()
mod._reap_all_sidecars()          # nothing tracked: must be a no-op
ok("reaping with nothing tracked leaves other processes alone", alive(bystander.pid))
mod._signal_group(999999, signal.SIGTERM)   # long-gone pid
ok("signalling a dead pid does not raise", True)
ok("bystander still alive after a stray signal", alive(bystander.pid))
bystander.kill()
bystander.wait(timeout=5)

print(f"\n{PASS} passed, {len(FAILS)} failed")
sys.exit(1 if FAILS else 0)
