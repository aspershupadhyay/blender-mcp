# blender-mcp relay

Let Claude (or any MCP client) drive the Blender on your computer from anywhere, through your own
server on Vercel. Nothing on your computer listens for connections: the Blender add-on reaches out
to the relay and asks for work.

```
Claude ──MCP──▶ Vercel /api/mcp ──job──▶ Upstash Redis ◀──long poll── Blender add-on (your computer)
       ◀─result─                ◀─result─               ──result──▶
```

## Warning: this is remote code execution, on purpose

`execute_python` runs any Python inside your Blender, with your user's rights on your computer.
Anyone who has your `RELAY_TOKEN` can do that. So:

- Use a long random token (the server refuses one under 32 characters) and never share it or the connector URL.
- Press **Disconnect** in Blender when you are not using it. While disconnected, nothing can reach your computer.
- If the token leaks, change `RELAY_TOKEN` in Vercel and redeploy at once.
- Keep this repository private: the token is not in it, but the setup is.

## Set it up (about 15 minutes)

1. **Token.** Make one: `openssl rand -hex 32` (or any 64 random characters).
2. **Deploy.** On vercel.com: Add New → Project → import this repository → Deploy (no build settings needed).
3. **Queue.** In the Vercel project: Storage → Marketplace → **Upstash for Redis** → create (the free plan is enough) → connect it to this project. This adds the Redis variables.
4. **Secret.** Project → Settings → Environment Variables: add `RELAY_TOKEN` = your token (Production). Then Deployments → ⋯ → Redeploy.
5. **Blender add-on.** In Blender 4.2 or later: Edit → Preferences → Add-ons → ⌄ → Install from Disk → `blender/blender_mcp_relay.py`. Turn it on, open its preferences, and set **Relay URL** = `https://<your-project>.vercel.app` and **Token** = your token.
6. **Connect.** In the 3D viewport press N → **MCP Relay** tab → **Connect**. The status turns to *Connected*.
7. **Claude.** At https://claude.ai/customize/connectors add a custom connector with the URL
   `https://<your-project>.vercel.app/api/mcp?key=<your token>`. Start a new chat or Claude Code session (connectors load when a session starts).

Ask Claude to "run connection_status" first.

## Tools

| Tool | What it does |
| --- | --- |
| `connection_status` | Is Blender connected now? |
| `get_scene_info` | Objects, camera, engine, frame. |
| `get_object_info` | One object: transform, mesh counts, materials, bones, shape keys. |
| `execute_python` | Run Python in Blender (`bpy`); returns printed output and `result`. |
| `viewport_screenshot` | Picture of the 3D viewport (Blender with a window). |
| `render_image` | Render the active camera; returns the image. |
| `get_result` | Collect a job that took longer than one request (about 50 s). |

## Limits

- One request waits at most about 50 s (Vercel function limit, `vercel.json`). Longer jobs return a job id; `get_result` collects them.
- Jobs run one at a time on Blender's main thread; Blender's interface pauses while a job runs.
- Upstash usage: the add-on's long poll costs about one Redis command a second while connected
  (about 3,600 an hour). Upstash's free plan (500,000 commands a month at the time of writing) covers
  well over 100 connected hours a month. Disconnect when idle.
- Claude's custom connectors cannot send headers, so the MCP door takes the token in the URL (`?key=`).
  The add-on uses an `Authorization` header. OAuth would be stronger; it is not built.

## Develop

```sh
npm install
RELAY_TOKEN=$(openssl rand -hex 32) npm run dev     # local relay on http://localhost:3000, in-memory queue
RELAY_TOKEN=... npm test                             # end to end with headless Blender (pip install bpy)
```

The MCP endpoint is a small stateless Streamable HTTP server (`api/mcp.js`, JSON replies, no
server-sent events): `initialize`, `ping`, `tools/list`, `tools/call`.
