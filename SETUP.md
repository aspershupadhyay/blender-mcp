# Set up your own Blender MCP Relay

Follow these steps once, in order, and any MCP client (Claude, Claude Code, or others) can drive the
Blender on your computer from anywhere, with your sign-in and your approval. About 15 minutes.

You need: a GitHub account, a Vercel account (free), Blender 4.2 or newer, and a copy of this
repository in your GitHub account (Fork it, or "Use this template", and keep it **private**).

In the steps below, **YOUR-URL** means your Vercel address, for example `https://blender-mcp-abc.vercel.app`.

---

## 1. Deploy on Vercel (3 min)

1. Go to https://vercel.com and sign in with GitHub.
2. **Add New… → Project**.
3. Find your copy of **blender-mcp** and press **Import**. (Not listed? Press "Adjust GitHub App Permissions" and give Vercel that repository.)
4. **Framework Preset:** `Other`. Leave Build, Output and Install as they are (`vercel.json` sets them).
5. Press **Deploy** and wait.
6. In the project, under **Domains**, copy the main address (not the long per-deployment link). That is **YOUR-URL**.

The page says "not set up yet" until step 5. That is expected.

## 2. Make a GitHub sign-in app (2 min)

1. Open https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name:** `Blender MCP Relay`
   - **Homepage URL:** `YOUR-URL`
   - **Authorization callback URL:** `YOUR-URL/auth/github/callback`
   - Leave "Enable Device Flow" off.
3. **Register application**.
4. Copy the **Client ID**.
5. **Generate a new client secret** and copy it now (GitHub shows it once).

## 3. Add Redis (2 min)

1. Vercel project → **Storage** → **Create Database** (or **Marketplace**).
2. **Upstash** → **Upstash for Redis** → **Continue**.
3. **Region:** the one nearest you (the functions run in Mumbai, `bom1`; for Europe or the US see "Other regions" below). **Plan:** Free.
4. **Create**, then connect it to your project (all environments).

This adds `REDIS_URL` / `KV_URL` by itself.

## 4. Make a secret (30 s)

Make 64 random characters:

- Mac or Linux: `openssl rand -hex 32`
- Windows PowerShell: `-join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) })`
- Or a password generator, 64 characters, letters and numbers.

## 5. Add the settings and redeploy (2 min)

Vercel project → **Settings** → **Environment Variables**. Add:

| Name | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | Client ID from step 2 |
| `GITHUB_CLIENT_SECRET` | Client secret from step 2 |
| `ALLOWED_GITHUB_LOGINS` | your GitHub username (several: `alice,bob`) |
| `SESSION_SECRET` | the 64 characters from step 4 |
| `PUBLIC_URL` (optional) | your custom domain, if you add one later |

Then **Deployments** → **⋯** on the top deployment → **Redeploy**. Settings work only after a redeploy.

## 6. Sign in (30 s)

Open **YOUR-URL** → **Sign in with GitHub** → **Authorize**. You see "Hello, @you" and the dashboard.

## 7. Install and pair the Blender add-on (3 min)

1. Download `blender/blender_mcp_relay.py` from your repository (open the file on GitHub → **Download raw file**, the ⬇ button).
2. Blender → **Edit → Preferences → Add-ons** → **⌄** (top right) → **Install from Disk…** → choose the `.py` file.
3. Tick **MCP Relay**, expand it, and set **Relay URL** = `YOUR-URL` (with `https://`, no `/mcp`, no slash at the end).
4. Close Preferences. In the 3D viewport press **N** → **MCP Relay** tab → **Pair**.
5. A code like `BCDF-2345` appears. Press **Open the relay page**, or type the code on your dashboard → **Find this Blender** → **Allow**.
6. Blender shows **Connected**; the dashboard dot turns green.

Later: press **Connect** when you want the AI to work, **Disconnect** when you stop.

## 8. Add it to Claude (2 min)

1. Dashboard → **Copy** next to "Connector URL" (`YOUR-URL/mcp`).
2. https://claude.ai/customize/connectors → **Add custom connector** → name `Blender`, paste the URL → **Add**.
3. **Connect**: your relay page opens; sign in if asked, then **Allow**.
4. Start a **new** chat or Claude Code session (connectors load when a session starts) and ask: *"run connection_status"*.

Other MCP clients: point them at `YOUR-URL/mcp`. They find the sign-in by themselves (OAuth discovery,
`/.well-known/oauth-protected-resource`) and open the same Allow page.

---

## Using it safely

- An approved app can run any Python in your Blender, with your rights on your computer. Approve only apps you trust.
- Press **Disconnect** in Blender when you are not using it. While disconnected, nothing can reach your computer.
- The dashboard shows every connected app and paired Blender; revoke or unpair any of them in one click.
- **Revoke everything** (the kill switch) removes all apps, unpairs all Blenders, drops queued jobs, and signs out everywhere.
- Lost a laptop or leaked something? Press **Revoke everything**, then change `SESSION_SECRET` in Vercel and redeploy.

## If something goes wrong

| What you see | Fix |
| --- | --- |
| "Not set up yet" after step 5 | You did not redeploy, or a variable name is misspelled. |
| GitHub: "redirect_uri is not associated" | The callback in step 2 must be exactly `YOUR-URL/auth/github/callback`. |
| "Not allowed" after sign-in | `ALLOWED_GITHUB_LOGINS` must hold your GitHub username exactly. |
| Blender: "Unpaired: pair again" | It was unpaired on the dashboard. Press **Pair** again. |
| Blender: "Retrying" | No internet, or the relay URL is wrong. Open the URL in a browser to check. |
| Claude: "No Blender is connected" | Press **Connect** in Blender's N panel. |
| A tool waits about 50 s, then gives a job id | Blender is still working (a long render). Ask for `get_result` with that id. |

## Other regions

The functions run in Mumbai (`"regions": ["bom1"]` in `vercel.json`). For the lowest delay, put both
the function and Redis near you: change `bom1` to, for example, `fra1` (Frankfurt) or `iad1`
(Washington), and pick the matching Upstash region (eu-central-1, us-east-1). Push, and Vercel redeploys.

## Update

Push to your repository; Vercel redeploys by itself. For a new add-on version, install the new
`blender_mcp_relay.py` the same way (it replaces the old one; you stay paired).
