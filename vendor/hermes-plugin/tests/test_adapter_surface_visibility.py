import asyncio
import adapter as A

obj = A.AgentMobAdapter.__new__(A.AgentMobAdapter)
obj._surface_feedback = []
obj._surface_state = {}


async def evt(payload):
    await obj._handle_sidecar_event(payload)


# 1) a surface_state device->agent event stores the reported state (not a turn)
asyncio.run(evt({"type": "surface_state",
                 "state": {"assets": [], "types": ["clock", "weather_tile"], "widgets": ["c1", "w_weather"]}}))
assert obj._surface_state["types"] == ["clock", "weather_tile"], obj._surface_state
assert obj._surface_state["widgets"] == ["c1", "w_weather"], obj._surface_state
print("PASS: surface_state event stored")

# 2) augmenting a turn surfaces the current surface so agents push to existing keys
out = obj._augment_agent_text("show me the weather")
assert "current surface: types=clock,weather_tile widgets=c1,w_weather" in out, out
assert "render " not in out, out  # no feedback pending here
print("PASS: current surface injected into agent context")

# 3) render feedback and surface state both appear together
obj._surface_feedback.append({"type": "render_result", "key": "probe", "ok": False, "error": "boom"})
out2 = obj._augment_agent_text("again")
assert "[render probe=FAILED: boom]" in out2, out2
assert "current surface" in out2, out2
print("PASS: render feedback + surface state both injected")

# 4) nothing to show -> no noise appended
obj._surface_state = {}
obj._surface_feedback = []
out3 = obj._augment_agent_text("plain hello")
assert out3 == "plain hello", out3
print("PASS: empty surface adds no noise")

print("\nSURFACE VISIBILITY: ALL PASS")
