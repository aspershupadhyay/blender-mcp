bl_info = {
    "name": "MCP Relay",
    "author": "blender-mcp",
    "version": (2, 0, 0),
    "blender": (4, 2, 0),
    "location": "3D Viewport > Sidebar (N) > MCP Relay",
    "description": "Lets an AI assistant drive this Blender through your own relay server (Vercel). Outbound only.",
    "category": "System",
}

# How it works: press Pair, approve the code on your relay's page (signed in with GitHub), and this
# Blender gets its own key. Connect starts a background thread that asks the relay for work (a long
# poll, outbound HTTPS only, so no port opens on this computer). Each job runs on Blender's main
# thread through a timer, and the result goes back. Unpair it on the relay page and the key dies.
# Press Disconnect when you are not using it.

import base64
import contextlib
import io
import json
import os
import queue
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

import platform

import bpy

_jobs = queue.Queue()      # thread -> main thread
_results = queue.Queue()   # main thread -> thread
_state = {"thread": None, "stop": None, "status": "Disconnected", "done": 0, "last": "",
          "pair_code": "", "pair_token": "", "pair_status": ""}
_ns = {}                   # execute_python namespace, kept between calls


def _prefs():
    return bpy.context.preferences.addons[__name__].preferences


def _post(url, token, payload, timeout):
    headers = {"content-type": "application/json", "user-agent": "blender-mcp-relay/2"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _worker(url, token, stop):
    bridge = url.rstrip("/") + "/api/bridge"
    wait = 1.0
    while not stop.is_set():
        try:
            # Send finished results first.
            while not _results.empty():
                jid, res = _results.get_nowait()
                _post(bridge, token, {"action": "result", "id": jid, "result": res}, 30)
            r = _post(bridge, token, {"action": "next"}, 45)
            _state["status"] = "Connected"
            wait = 1.0
            job = r.get("job")
            if job:
                _jobs.put(job)
                # Wait for the main thread, then send at once.
                while not stop.is_set():
                    try:
                        jid, res = _results.get(timeout=0.5)
                        _post(bridge, token, {"action": "result", "id": jid, "result": res}, 30)
                        break
                    except queue.Empty:
                        continue
        except urllib.error.HTTPError as e:
            _state["status"] = "Unpaired: pair again" if e.code == 401 else f"Relay error {e.code}"
            if e.code == 401:
                break
            time.sleep(wait); wait = min(wait * 2, 30)
        except Exception as e:  # network drop: retry with backoff
            _state["status"] = f"Retrying ({type(e).__name__})"
            time.sleep(wait); wait = min(wait * 2, 30)
    if not _state["status"].startswith("Unpaired"):
        _state["status"] = "Disconnected"


def _pair_worker(url):
    base = url.rstrip("/")
    try:
        r = _post(base + "/api/pair/start", "", {"name": f"Blender {bpy.app.version_string} on {platform.node() or 'this computer'}"}, 20)
    except Exception as e:
        _state["pair_status"] = f"Could not reach the relay ({type(e).__name__})"
        return
    _state["pair_code"] = r["user_code"]
    _state["pair_status"] = "Approve this code on the relay page"
    _state["pair_url"] = r["verification_uri_complete"]
    end = time.time() + r.get("expires_in", 600)
    while time.time() < end and _state["pair_code"] == r["user_code"]:
        time.sleep(r.get("interval", 2))
        try:
            p = _post(base + "/api/pair/poll", "", {"device_code": r["device_code"]}, 20)
        except Exception:
            continue
        if p.get("status") == "approved":
            _state["pair_token"] = p["token"]  # the timer saves it into the preferences
            _state["pair_status"] = "Paired"
            _state["pair_code"] = ""
            return
        if p.get("status") in ("denied", "expired"):
            _state["pair_status"] = "Pairing was denied" if p["status"] == "denied" else "Code expired: press Pair again"
            _state["pair_code"] = ""
            return
    if _state["pair_code"] == r["user_code"]:
        _state["pair_status"] = "Code expired: press Pair again"
        _state["pair_code"] = ""


def _pair_timer():
    if _state["pair_token"]:
        p = _prefs()
        p.token = _state["pair_token"]
        _state["pair_token"] = ""
        bpy.ops.wm.save_userpref()
        connect(p.url, p.token)
        return None
    _redraw()
    return 0.5 if _state["pair_code"] else None


def _redraw():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


# ---------------------------------------------------------------- tools (main thread)
def _scene_info(_args):
    sc = bpy.context.scene
    objs = []
    for o in sc.objects:
        objs.append({
            "name": o.name, "type": o.type, "location": [round(v, 4) for v in o.location],
            "dimensions": [round(v, 4) for v in o.dimensions], "visible": o.visible_get(),
            "parent": o.parent.name if o.parent else None, "parent_bone": o.parent_bone or None,
            "materials": [s.material.name for s in getattr(o, "material_slots", []) if s.material],
            "modifiers": [m.type for m in getattr(o, "modifiers", [])],
        })
    info = {"file": bpy.data.filepath or "(unsaved)", "scene": sc.name, "frame": sc.frame_current,
            "engine": sc.render.engine, "camera": sc.camera.name if sc.camera else None,
            "resolution": [sc.render.resolution_x, sc.render.resolution_y], "objects": objs}
    return {"ok": True, "text": json.dumps(info, indent=1)}


def _object_info(args):
    o = bpy.data.objects.get(args.get("name", ""))
    if not o:
        return {"ok": False, "error": f"No object named {args.get('name')!r}."}
    d = {"name": o.name, "type": o.type, "location": list(o.location), "rotation": list(o.rotation_euler),
         "scale": list(o.scale), "dimensions": list(o.dimensions), "modifiers": [(m.name, m.type) for m in getattr(o, "modifiers", [])]}
    if o.type == "MESH":
        me = o.data
        d["mesh"] = {"vertices": len(me.vertices), "faces": len(me.polygons), "uv_layers": [u.name for u in me.uv_layers],
                     "attributes": [a.name for a in me.attributes],
                     "shape_keys": [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else []}
    if o.type == "ARMATURE":
        d["bones"] = [{"name": b.name, "parent": b.parent.name if b.parent else None} for b in o.data.bones]
    mats = []
    for s in getattr(o, "material_slots", []):
        m = s.material
        if not m:
            continue
        nodes = [{"name": n.name, "type": n.bl_idname,
                  "image": n.image.name if getattr(n, "image", None) else None} for n in m.node_tree.nodes] if m.use_nodes else []
        mats.append({"name": m.name, "nodes": nodes})
    d["materials"] = mats
    return {"ok": True, "text": json.dumps(d, indent=1, default=str)}


def _execute(args):
    out = io.StringIO()
    _ns.update({"bpy": bpy})
    _ns.pop("result", None)
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(args.get("code", ""), "<mcp>", "exec"), _ns)
    except Exception:
        return {"ok": False, "error": (out.getvalue() + "\n" + traceback.format_exc())[-20000:]}
    text = out.getvalue()
    if "result" in _ns:
        text += ("\n" if text else "") + "result = " + repr(_ns["result"])
    return {"ok": True, "text": text[-20000:] or "Done (no output)."}


def _image(path, max_size):
    img = bpy.data.images.load(path)
    try:
        img.reload()
        _ = img.pixels[0] if len(img.pixels) else None  # make Blender read the file, so size is real
        w, h = img.size
        k = min(1.0, max_size / max(w, h, 1))
        if k < 1.0 and w and h:
            img.scale(max(1, int(w * k)), max(1, int(h * k)))
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    os.remove(path)
    return {"data": data, "mime": "image/png"}


def _screenshot(args):
    if bpy.app.background:
        return {"ok": False, "error": "Blender runs without a window; use render_image."}
    best = None
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D" and (best is None or area.width * area.height > best[1].width * best[1].height):
                best = (win, area)
    if not best:
        return {"ok": False, "error": "No 3D viewport is open."}
    path = os.path.join(tempfile.gettempdir(), f"mcp_shot_{time.time_ns()}.png")
    with bpy.context.temp_override(window=best[0], area=best[1]):
        bpy.ops.screen.screenshot_area(filepath=path)
    return {"ok": True, "image": _image(path, int(args.get("max_size", 900)))}


def _render(args):
    sc = bpy.context.scene
    if not sc.camera:
        return {"ok": False, "error": "The scene has no active camera."}
    keep = (sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath,
            sc.cycles.samples if hasattr(sc, "cycles") else None, sc.render.resolution_percentage,
            sc.render.image_settings.file_format)
    try:
        if args.get("engine"):
            sc.render.engine = args["engine"]
        if args.get("width"):
            sc.render.resolution_x = int(args["width"])
        if args.get("height"):
            sc.render.resolution_y = int(args["height"])
        if args.get("samples") and sc.render.engine == "CYCLES":
            sc.cycles.samples = int(args["samples"])
        # Render straight at the returned size (faster than rendering big and shrinking).
        longest = max(sc.render.resolution_x, sc.render.resolution_y) * sc.render.resolution_percentage / 100
        sc.render.resolution_percentage = max(1, min(100, int(100 * int(args.get("max_size", 1200)) / max(longest, 1))))
        sc.render.image_settings.file_format = "PNG"
        path = os.path.join(tempfile.gettempdir(), f"mcp_render_{time.time_ns()}.png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        os.remove(path)
        return {"ok": True, "image": {"data": data, "mime": "image/png"}}
    finally:
        sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.filepath = keep[:4]
        if keep[4] is not None:
            sc.cycles.samples = keep[4]
        sc.render.resolution_percentage, sc.render.image_settings.file_format = keep[5], keep[6]


TOOLS = {"get_scene_info": _scene_info, "get_object_info": _object_info, "execute_python": _execute,
         "viewport_screenshot": _screenshot, "render_image": _render}


def process_pending():
    """Run waiting jobs. Called by a timer in the UI; tests call it directly in background mode."""
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            return
        fn = TOOLS.get(job.get("tool"))
        try:
            res = fn(job.get("args") or {}) if fn else {"ok": False, "error": f"Unknown tool {job.get('tool')}"}
        except Exception:
            res = {"ok": False, "error": traceback.format_exc()[-20000:]}
        _state["done"] += 1
        _state["last"] = job.get("tool", "")
        _results.put((job["id"], res))


def _timer():
    process_pending()
    _redraw()
    return 0.2 if _state["thread"] and _state["thread"].is_alive() else None


def connect(url, token):
    disconnect()
    stop = threading.Event()
    t = threading.Thread(target=_worker, args=(url, token, stop), daemon=True)
    _state.update(thread=t, stop=stop, status="Connecting")
    t.start()
    if not bpy.app.background and not bpy.app.timers.is_registered(_timer):
        bpy.app.timers.register(_timer, first_interval=0.2)


def disconnect():
    if _state["stop"]:
        _state["stop"].set()
    _state.update(thread=None, stop=None, status="Disconnected")


# ---------------------------------------------------------------- UI
class MCPRelayPrefs(bpy.types.AddonPreferences):
    bl_idname = __name__
    url: bpy.props.StringProperty(name="Relay URL", description="Your relay, e.g. https://my-relay.vercel.app")
    token: bpy.props.StringProperty(name="Key", subtype="PASSWORD", description="Set by pairing; do not share",
                                    options={"HIDDEN"})

    def draw(self, context):
        self.layout.prop(self, "url")
        self.layout.label(text="Paired" if self.token else "Not paired: press Pair in the N panel > MCP Relay",
                          icon="CHECKMARK" if self.token else "INFO")


def _url_ok(op, url):
    if url.startswith("https://") or url.startswith("http://localhost") or url.startswith("http://127.0.0.1"):
        return True
    op.report({"ERROR"}, "Set an https Relay URL in the add-on preferences")
    return False


class MCP_OT_pair(bpy.types.Operator):
    bl_idname = "mcp_relay.pair"
    bl_label = "Pair"
    bl_description = "Get a code, approve it on your relay page (signed in), and this Blender gets its own key"

    def execute(self, context):
        p = _prefs()
        if not _url_ok(self, p.url):
            return {"CANCELLED"}
        _state.update(pair_code="", pair_status="Asking the relay for a code...", pair_url="")
        threading.Thread(target=_pair_worker, args=(p.url,), daemon=True).start()
        bpy.app.timers.register(_pair_timer, first_interval=0.5)
        return {"FINISHED"}


class MCP_OT_open_pair(bpy.types.Operator):
    bl_idname = "mcp_relay.open_pair"
    bl_label = "Open the relay page"

    def execute(self, context):
        if _state.get("pair_url"):
            bpy.ops.wm.url_open(url=_state["pair_url"])
        return {"FINISHED"}


class MCP_OT_forget(bpy.types.Operator):
    bl_idname = "mcp_relay.forget"
    bl_label = "Forget key"
    bl_description = "Remove this Blender's key (also unpair it on the relay page)"

    def execute(self, context):
        disconnect()
        _prefs().token = ""
        bpy.ops.wm.save_userpref()
        return {"FINISHED"}


class MCP_OT_connect(bpy.types.Operator):
    bl_idname = "mcp_relay.connect"
    bl_label = "Connect"
    bl_description = "Start taking jobs from the relay"

    def execute(self, context):
        p = _prefs()
        if not _url_ok(self, p.url):
            return {"CANCELLED"}
        if not p.token:
            self.report({"ERROR"}, "Pair this Blender first")
            return {"CANCELLED"}
        connect(p.url, p.token)
        return {"FINISHED"}


class MCP_OT_disconnect(bpy.types.Operator):
    bl_idname = "mcp_relay.disconnect"
    bl_label = "Disconnect"

    def execute(self, context):
        disconnect()
        return {"FINISHED"}


class MCP_PT_panel(bpy.types.Panel):
    bl_label = "MCP Relay"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "MCP Relay"

    def draw(self, context):
        p = _prefs()
        col = self.layout.column()
        if not p.url:
            col.label(text="Set the Relay URL:", icon="ERROR")
            col.prop(p, "url", text="")
            return
        if not p.token:
            if _state["pair_code"]:
                box = col.box()
                box.label(text="Pairing code")
                row = box.row()
                row.scale_y = 2.0
                row.label(text=_state["pair_code"])
                box.operator("mcp_relay.open_pair", icon="URL")
            if _state["pair_status"]:
                col.label(text=_state["pair_status"], icon="INFO")
            col.operator("mcp_relay.pair", icon="LINKED")
            return
        col.label(text=_state["status"], icon="LINKED" if _state["status"] == "Connected" else "UNLINKED")
        if _state["done"]:
            col.label(text=f"Jobs run: {_state['done']} (last: {_state['last']})")
        if _state["thread"] and _state["thread"].is_alive():
            col.operator("mcp_relay.disconnect", icon="CANCEL")
        else:
            col.operator("mcp_relay.connect", icon="PLAY")
        col.separator()
        col.operator("mcp_relay.forget", icon="TRASH")


CLASSES = (MCPRelayPrefs, MCP_OT_pair, MCP_OT_open_pair, MCP_OT_forget, MCP_OT_connect, MCP_OT_disconnect, MCP_PT_panel)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)


def unregister():
    disconnect()
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
