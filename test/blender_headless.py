# Runs the add-on in background Blender for the end-to-end test: connect, then run jobs as they come.
import importlib.util, sys, time
import bpy
url, token, seconds = sys.argv[-3], sys.argv[-2], float(sys.argv[-1])
spec = importlib.util.spec_from_file_location('blender_mcp_relay', __file__.replace('test/blender_headless.py', 'blender/blender_mcp_relay.py'))
relay = importlib.util.module_from_spec(spec); spec.loader.exec_module(relay)
bpy.ops.wm.read_homefile(use_empty=False)  # default cube, camera, light
relay.connect(url, token)
end = time.time() + seconds
while time.time() < end:
    relay.process_pending()
    time.sleep(0.05)
relay.disconnect()
print('headless blender done', relay._state)
