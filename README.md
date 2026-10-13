<p align="center"><img src="public/icon-192.png" width="96" alt="Blender MCP Relay"></p>

# Blender MCP Relay

Drive the Blender on your own computer from Claude, or any MCP client, from anywhere. A private relay
on your Vercel: you sign in with GitHub, approve each app the way you approve Figma's or GitHub's MCP
connectors, and pair each Blender with a code. Nothing on your computer listens for connections.

```
Claude ──MCP + OAuth──▶ Vercel (bom1) ──BLPOP──▶ Redis ◀──BLPOP── Blender add-on (outbound HTTPS)
```

## How it is secured

| Door | Who gets in | How |
| --- | --- | --- |
| Web page | You only | GitHub sign-in; only logins in `ALLOWED_GITHUB_LOGINS`. Session = signed cookie (`__Host-`, HttpOnly, Secure, SameSite) plus a server record, 12 h. |
| MCP (`/mcp`) | Apps you approved | OAuth 2.1: dynamic client registration, PKCE S256 only, exact redirect match, 1 h access tokens, 30-day refresh tokens rotated on every use. Replaying an old refresh token revokes that whole grant. |
| Blender bridge | Blenders you paired | Device-code pairing: the add-on shows a code, you approve it on the page while signed in, and that Blender gets its own key, handed over once. |

- Every token is random (256 bit) and stored only as a SHA-256 hash.
- Consent and pairing need your session and a CSRF token. The consent request is bound to your session.
- Rate limits on sign-in, registration, token, and pairing endpoints.
- Strict security headers: CSP `'self'` only (three.js is vendored), no framing, HSTS, no referrer.
- **Kill switch** on the dashboard: revokes every app, unpairs every Blender, drops queued jobs, and signs out every session.
- Jobs older than 55 s are never run (a caller that gave up never fires late).

`execute_python` still means: an approved app can run any Python in your Blender, with your rights on
your computer. Approve only apps you trust, and press **Disconnect** in Blender when you stop.

## Speed

- **No polling.** Jobs and results move through Redis `BLPOP` over TCP: Blender gets a job the moment
  it is queued, and the MCP call gets the result the moment Blender pushes it. Round trip = network + Blender's work.
- **Close to you.** Functions run in `bom1` (Mumbai, `vercel.json`). Create the Redis database in the same region (AWS ap-south-1).
- **One warm function.** All routes go through one function, so it stays warm.
- **Renders at the returned size**, not rendered big and shrunk.
- Rust would not help: the time is in the network and in Blender, not in the relay's code.

## Set it up (about 15 minutes)

Follow **[SETUP.md](SETUP.md)**: exact steps, click by click, for anyone (Vercel, GitHub sign-in app, Redis, settings, Blender add-on, Claude connector), with fixes for common problems.

## Tools

| Tool | What it does |
| --- | --- |
| `connection_status` | Is a paired Blender connected now? |
| `get_scene_info` | Objects, camera, engine, resolution, frame, file. |
| `get_object_info` | One object: transform, mesh counts, UVs, attributes, shape keys, materials and nodes, bones. |
| `execute_python` | Run Python in Blender (`bpy`; variables persist). Returns output and `result`. |
| `viewport_screenshot` | Picture of the 3D viewport. |
| `render_image` | Render the active camera; scene settings are restored after. |
| `get_result` | Collect a job that ran past one request (about 50 s). |

## Develop

```sh
npm install
npm test                      # 13 security and protocol tests, in-memory store, no Blender
SESSION_SECRET=$(openssl rand -hex 32) GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ALLOWED_GITHUB_LOGINS=you npm run dev
```

Without `REDIS_URL` the relay uses an in-memory store (one process; development only).

## Files

- `api/router.js`: the one function: routes, dashboard API, kill switch
- `lib/oauth.js`: OAuth 2.1 server for MCP clients
- `lib/github.js`: owner sign-in
- `lib/blender.js`: pairing and the bridge
- `lib/tools.js`, `lib/mcp.js`: tools and the MCP protocol (Streamable HTTP, JSON replies)
- `lib/security.js`, `lib/store.js`: tokens, sessions, CSRF, rate limits, headers; Redis or memory
- `public/`: the 3D web page (three.js, vendored), icon, styles
- `blender/blender_mcp_relay.py`: the add-on
