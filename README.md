<p align="center"><img src="public/icon.svg" width="96" alt="EDITH"></p>

<h1 align="center">EDITH</h1>
<p align="center"><b>Every Device In The House</b> — a homelab dashboard</p>

Live status for your Unraid and HexOS / TrueNAS SCALE servers, plus an Apps board that health-checks every tracked port every 30s. Zero dependencies — one Node file and one HTML page.

## Install (Docker)

**HexOS / TrueNAS SCALE**

1. Create a dataset for EDITH's data (e.g. `apps/edith`) and note its path (`/mnt/<pool>/apps/edith`).
2. TrueNAS UI → **Apps** → **Discover Apps** → **⋮** → **Install via YAML**.
3. Paste [`docker-compose.yaml`](docker-compose.yaml), set the volume path from step 1, and save.

**Anywhere else:** `docker compose up -d` with the same file.

Then open `http://<host>:7575`. On first start EDITH asks for your servers — give each one a name and its IP address or hostname, and it works out whether it's running Unraid or TrueNAS (HexOS included). Add more with **+ Add another server**, or later from **⚙ Servers** or the **+ Add server** card.

The image `ghcr.io/thegreatmate/edith:latest` is rebuilt on every push to `main`. To update, redeploy the app (it pulls `latest` on start).

## API keys (optional)

Without a key, a server card shows whether it's reachable. Add one in **⚙ Servers** for CPU, memory, disk, container and VM stats:

- **Unraid:** Settings → Management Access → API Keys → create a key with the *viewer* role (Unraid 7.2+, or the Unraid Connect plugin).
- **TrueNAS / HexOS:** `https://<server>/ui/` → user icon → API Keys → Add.

Keys are checked when you save them, stored only in `data/config.json` on the machine running EDITH, and never sent back to the browser. EDITH has no login of its own, so run it on your LAN only.

## Apps

- **Scan for apps** checks every TCP port on a server, names what it finds (page title, headers, well-known ports) and lets you **Add** or **Ignore** each one.
- **Favorites** is the default view. Tap ☆ on any app to pin it; **View all** shows everything.
- **Edit** shows × buttons to stop tracking an app.
- Icons come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) by name; edit `icon` in `data/config.json` to change one.

## Themes

Dark, light and retro (pixel fonts, chunky borders, block meters). Defaults to your system setting.

## Settings

| Variable | Purpose |
| --- | --- |
| `PORT` | Web port (default 7575) |
| `CHECK_INTERVAL` | Seconds between app health checks (default 30) |
| `PLEX_URL`, `PLEX_TOKEN` | Optional — shows "Now playing" |
| `DATA_DIR` | Where `config.json` is stored (default `./data`) |
| `UNRAID_*`, `TRUENAS_*` | Advanced — preconfigure servers instead of using the setup screen (see `.env.example`) |

## Run locally

Double-click `start.cmd`, or `node server.js` (Node 18+).
