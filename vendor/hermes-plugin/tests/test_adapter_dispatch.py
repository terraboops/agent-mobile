import asyncio, adapter as A

# Bare instance (skip __init__/base) with the deps send() touches stubbed.
obj = A.AgentMobAdapter.__new__(A.AgentMobAdapter)
calls = {"surface": [], "ui": [], "speak": [], "status": [], "released": 0, "reply": []}

async def fake_surface(_chat, ops):
    calls["surface"].append(ops)
    return types.SimpleNamespace(success=True, error=None, message_id="x")
async def fake_ui(_chat, ui):
    calls["ui"].append(ui); return types.SimpleNamespace(success=True, error=None, message_id="x")
async def fake_speak(text):
    calls["speak"].append((text,))
def fake_status(**kw):
    calls["status"].append(kw)
def fake_release():
    calls["released"] += 1
def fake_send_sidecar(p):
    calls["reply"].append(p)

obj._is_internal_status = A.AgentMobAdapter._is_internal_status
obj._publish_ui = fake_ui
obj._schedule_speak = fake_speak
obj._push_status = fake_status
obj._release_turn_after_reply = fake_release
obj._send_to_sidecar = fake_send_sidecar
obj._pending_i = None
obj._turn_lock = False
obj._deferred = None
obj._tts_voice = "en_US-amy-medium"

import types
R = types.SimpleNamespace
obj._publish_surface = fake_surface

async def main():
    OPS = [{"op": "register_widget_type", "name": "clock", "code": "x", "assets": []},
            {"op": "add_widget", "key": "c1", "type": "clock", "props": {}}]
    # 1) __surface__ body
    r = await obj.send("c", '{"__surface__":' + __import__('json').dumps(OPS) + ',"text":"ok"}')
    assert calls["surface"] == [OPS], calls["surface"]
    assert calls["speak"] == [("ok",)], calls["speak"]
    assert calls["status"] == [{"working": False}], calls["status"]
    assert calls["released"] == 1
    assert calls["ui"] == [] and calls["reply"] == []
    print("PASS: __surface__ routes to _publish_surface + speaks text + clears working + releases turn")

    # 2) regression: __ui__ still routes to _publish_ui (not surface)
    for k in calls: calls[k] = [] if isinstance(calls[k], list) else calls[k]
    r = await obj.send("c", '{"__ui__":{"text":"hi"}}')
    assert calls["ui"] and calls["surface"] == [], "ui should not touch surface"
    print("PASS: __ui__ (legacy) still routes to _publish_ui")

    # 3) plain text -> reply branch via sidecar push
    for k in calls: calls[k] = [] if isinstance(calls[k], list) else calls[k]
    await obj.send("c", "plain hello")
    assert calls["reply"] and calls["reply"][0]["type"] == "push", calls["reply"]
    print("PASS: plain text reply still pushes to sidecar")

    # 4) __surface__ where _publish_surface fails -> rejected, no speak
    for k in calls: calls[k] = [] if isinstance(calls[k], list) else calls[k]
    async def failing(_c, ops): return types.SimpleNamespace(success=False, error="boom", message_id="x")
    obj._publish_surface = failing
    res = await obj.send("c", '{"__surface__":' + __import__('json').dumps(OPS) + ',"text":"nope"}')
    assert res.success is False and res.error == "boom"
    assert calls["speak"] == [], "must not speak when surface rejected"
    print("PASS: surface rejection returns error, does not speak")

asyncio.run(main())
print("\nADAPTER SEND() DISPATCH: ALL PASS")
