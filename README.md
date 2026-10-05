<p align="center"><img src="public/icon.svg" width="96" alt="EDITH"></p>

<h1 align="center">EDITH</h1>
<p align="center"><b>Every Device In The House</b> — a homelab dashboard</p>

Live status for an Unraid server and/or a HexOS / TrueNAS SCALE server, plus an Apps board that health-checks every tracked port every 30s. Zero dependencies — one Node file and one HTML page.

## Deploy on HexOS / TrueNAS (Docker)

1. Create a dataset for the dashboard's data (e.g. `apps/edith`) and note its path (`/mnt/<pool>/apps/edith`).
2. TrueNAS UI → **Apps** → **Discover Apps** → **⋮** → **Install via YAML**.
3. Paste [`docker-compose.yaml`](docker-compose.yaml), set the volume path from step 1, fill in your server names, IPs and API keys, and save.
4. Open `http://<server>:7575`.

The image `ghcr.io/thegreatmate/edith:latest` is rebuilt on every push to `main`.
To update, redeploy the app in TrueNAS (it pulls `latest` on start).

## Run locally

Double-click `start.cmd`, or `node server.js` (Node 18+). Config goes in `.env` (see `.env.example`).

## Configuration

| Variable | Purpose |
| --- | --- |
| `UNRAID_NAME`, `UNRAID_HOST` | Display name and IP of your Unraid server (leave host empty to hide it) |
| `UNRAID_URL` | Web UI URL if it isn't `http://UNRAID_HOST` |
| `UNRAID_API_KEY` | Unraid → Settings → Management Access → API Keys (*viewer* role) |
| `TRUENAS_NAME`, `TRUENAS_HOST` | Display name and IP of your HexOS / TrueNAS SCALE server (HexOS is auto-detected) |
| `TRUENAS_API_KEY` | TrueNAS UI → user icon → API Keys → Add |
| `PLEX_URL`, `PLEX_TOKEN` | Optional — shows "Now playing" |
| `CHECK_INTERVAL` | Seconds between app health checks (default 30) |
| `DATA_DIR` | Where `apps.json` is stored (default `./data`) |

Without API keys the server cards show reachability only; the Apps board works either way.

## Apps

- **Themes:** dark, light and retro (pixel fonts, chunky borders, block meters). Defaults to your system setting.
- **Favorites** is the default view. Tap ☆ on any app to pin it; **View all** shows everything.
- **Scan for apps** checks every TCP port on a server, names what it finds (page title, headers, well-known ports) and lets you **Add** or **Ignore** each one.
- **Edit** shows × buttons to stop tracking an app.
- Icons come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) by name; edit `icon` in `data/apps.json` to change one.
- The app list starts empty — run a scan to fill it. Everything is saved in `data/apps.json`.
