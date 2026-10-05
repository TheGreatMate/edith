// EDITH — Every Device In The House. Tiny zero-dependency homelab dashboard for Unraid and HexOS / TrueNAS SCALE.
// Run: node server.js  ->  http://localhost:7575   (or via docker-compose.yaml)
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Homelab servers almost always use self-signed certs on the LAN.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- config ---------------------------------------------------------------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = process.env;
const cfg = {
  port: +(env.PORT || 7575),
  checkInterval: +(env.CHECK_INTERVAL || 30) * 1000,
  unraid: {
    name: env.UNRAID_NAME || 'Unraid',
    host: env.UNRAID_HOST || '',
    ui: env.UNRAID_URL || (env.UNRAID_HOST ? `http://${env.UNRAID_HOST}` : ''),
    key: env.UNRAID_API_KEY || '',
  },
  truenas: {
    name: env.TRUENAS_NAME || 'TrueNAS',
    host: env.TRUENAS_HOST || '',
    key: env.TRUENAS_API_KEY || '',
  },
  plex: { url: (env.PLEX_URL || '').replace(/\/$/, ''), token: env.PLEX_TOKEN || '' },
};
// Only servers with a host configured are shown.
const servers = ['unraid', 'truenas'].filter((id) => cfg[id].host).map((id) => ({ id, name: cfg[id].name, host: cfg[id].host }));
const hosts = Object.fromEntries(servers.map((x) => [x.id, x.host]));

// --- helpers --------------------------------------------------------------
function tcpPing(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok ? Date.now() - t0 : null); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function fetchJson(url, opts = {}, timeout = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}${text ? ': ' + text.slice(0, 120) : ''}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(timer); }
}

// GET a page without following redirects; returns { status, headers, text } or null.
async function probeHttp(url, timeout = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'edith-dashboard' } });
    const text = (await r.text()).slice(0, 200000);
    return { status: r.status, headers: r.headers, text };
  } catch { return null; } finally { clearTimeout(timer); }
}

const settle = async (p) => { try { return await p; } catch { return null; } };

// --- app store ------------------------------------------------------------
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const storeFile = path.join(dataDir, 'apps.json');
let store = { apps: [], ignored: [] };

function loadStore() {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  if (fs.existsSync(storeFile)) {
    store = { apps: [], ignored: [], ...JSON.parse(fs.readFileSync(storeFile, 'utf8')) };
  } else {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.default.json'), 'utf8'));
    store = { apps: seed, ignored: [] };
  }
  store.apps.forEach((a) => { a.id = a.id || `${a.server}-${a.port}`; });
  saveStore();
}
function saveStore() {
  try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); }
  catch (e) { console.error(`! Can't save ${storeFile}: ${e.message} — changes will be lost on restart`); }
}

function appUrl(a) {
  if (a.url) return a.url;
  if (a.tcp) return null;
  return `${a.scheme || 'http'}://${hosts[a.server]}:${a.port}${a.path || ''}`;
}

// --- background health checks ----------------------------------------------
const HISTORY = 48;
const health = new Map(); // id -> { up, ms, code, checked, history: [ms|null] }

async function checkApp(a) {
  const host = hosts[a.server];
  const ms = await tcpPing(host, a.port, 2000);
  let code = null;
  if (ms != null && !a.tcp) {
    const r = await probeHttp(`${a.scheme || 'http'}://${host}:${a.port}${a.path || '/'}`, 4000);
    code = r?.status ?? null;
  }
  const h = health.get(a.id) || { history: [] };
  h.up = ms != null;
  h.degraded = h.up && code != null && code >= 500;
  h.ms = ms; h.code = code; h.checked = Date.now();
  h.history = [...h.history, h.up ? (h.degraded ? -1 : ms) : null].slice(-HISTORY);
  health.set(a.id, h);
}

let checking = false;
async function checkAll() {
  if (checking) return;
  checking = true;
  try { await Promise.all(store.apps.filter((a) => hosts[a.server]).map(checkApp)); } finally { checking = false; }
}

function appsPayload() {
  return store.apps.filter((a) => hosts[a.server]).map((a) => {
    const h = health.get(a.id) || { history: [] };
    const seen = h.history.filter((x) => x !== undefined);
    const upCount = seen.filter((x) => x !== null).length;
    return {
      ...a, host: hosts[a.server], link: appUrl(a),
      up: h.up ?? null, degraded: !!h.degraded, ms: h.ms ?? null, code: h.code ?? null, checked: h.checked ?? null,
      history: h.history, uptime: seen.length ? upCount / seen.length : null,
    };
  });
}

// --- port scanner -----------------------------------------------------------
const NOISE = new Set([111, 135, 137, 138, 139, 3702, 5353, 5355, 5357]);
const KNOWN = {
  22: 'SSH', 81: 'Nginx Proxy Manager', 445: 'SMB Shares', 2049: 'NFS', 2283: 'Immich', 3001: 'Uptime Kuma',
  5055: 'Overseerr', 5900: 'VNC', 6080: 'noVNC', 6767: 'Bazarr', 7878: 'Radarr', 8096: 'Jellyfin', 8123: 'Home Assistant',
  8181: 'Tautulli', 8200: 'Duplicati', 8384: 'Syncthing', 8686: 'Lidarr', 8989: 'Sonarr', 9000: 'Portainer',
  9443: 'Portainer', 9696: 'Prowlarr', 11000: 'Nextcloud AIO', 19999: 'Netdata', 21116: 'RustDesk Server',
  25565: 'Minecraft', 25575: 'Minecraft RCON', 32400: 'Plex', 61208: 'Glances',
};
const GENERIC_TITLE = /^(\d{3}\b|default site|just a moment|welcome to nginx|index of|error|redirect|loading)/i;
const slug = (s) => s.toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fingerprint(host, port) {
  for (const scheme of ['http', 'https']) {
    const r = await probeHttp(`${scheme}://${host}:${port}/`);
    if (!r) continue;
    if (scheme === 'http' && r.status === 400 && /https/i.test(r.text)) continue; // plain HTTP to an HTTPS port
    const title = (r.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
    const desc = r.text.match(/<meta name="(?:description|application-name)" content="([^"]+)"/i)?.[1];
    let name = null;
    if (r.headers.get('x-syncthing-version')) name = 'Syncthing';
    else if (/immich/i.test(r.text)) name = 'Immich';
    else if (/duplicati/i.test(r.text)) name = 'Duplicati';
    else if (title && !GENERIC_TITLE.test(title)) name = title;
    else if (desc && desc.length < 40) name = desc;
    const loc = r.headers.get('location');
    return {
      scheme, http: true, status: r.status, title, redirect: loc || null,
      software: r.headers.get('server') || null, name: name || KNOWN[port] || null,
    };
  }
  return { http: false, name: KNOWN[port] || null };
}

let scan = { running: false };

async function runScan(server) {
  const host = hosts[server];
  scan = { running: true, server, host, progress: 0, phase: 'Scanning ports', found: [], results: [], started: Date.now() };
  const open = [];
  const BATCH = 1000;
  for (let p = 1; p <= 65535; p += BATCH) {
    const ports = Array.from({ length: Math.min(BATCH, 65536 - p) }, (_, i) => p + i);
    const res = await Promise.all(ports.map((port) => tcpPing(host, port, 700).then((ms) => (ms != null ? port : 0))));
    res.forEach((port) => port && !NOISE.has(port) && open.push(port));
    scan.progress = Math.min(0.9, (p + BATCH) / 65535 * 0.9);
    scan.found = [...open];
  }
  scan.phase = 'Identifying services';
  const tracked = new Set(store.apps.filter((a) => a.server === server).map((a) => a.port));
  const ignored = new Set(store.ignored.filter((i) => i.server === server).map((i) => i.port));
  let done = 0;
  const results = await Promise.all(open.map(async (port) => {
    const fp = await fingerprint(host, port);
    scan.progress = 0.9 + (++done / open.length) * 0.1;
    const name = fp.name || `Service :${port}`;
    return {
      server, port, ...fp, name, icon: slug(name),
      tracked: tracked.has(port), ignored: ignored.has(port),
      link: fp.http ? `${fp.scheme}://${host}:${port}/` : null,
    };
  }));
  scan = { ...scan, running: false, progress: 1, phase: 'Done', results, finished: Date.now() };
}

// --- server stats (Unraid GraphQL) -----------------------------------------
async function unraidQuery(...variants) {
  // Schema shifts between Unraid API releases; try each variant until one works.
  let lastErr;
  for (const query of variants) {
    try {
      const r = await fetchJson(`${cfg.unraid.ui}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.unraid.key },
        body: JSON.stringify({ query }),
      });
      if (r.errors?.length && (!r.data || Object.values(r.data).every((v) => v == null))) throw new Error(r.errors[0].message);
      return r.data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const kb = (v) => (v == null ? null : Number(v) * 1024);
const mapDisk = (d, role) => ({
  name: d.name, role, size: kb(d.size), temp: d.temp ?? null, status: d.status ?? null,
  total: kb(d.fsSize), used: kb(d.fsUsed), free: kb(d.fsFree),
});

async function runAll(tasks, out) {
  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(Object.values(tasks));
  const r = {};
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') r[keys[i]] = res.value;
    else out.errors.push(`${keys[i]}: ${res.reason?.message || res.reason}`);
  });
  return r;
}

async function plexStreams() {
  if (!cfg.plex.url || !cfg.plex.token) return null;
  const s = await settle(fetchJson(`${cfg.plex.url}/status/sessions?X-Plex-Token=${cfg.plex.token}`, { headers: { Accept: 'application/json' } }, 3000));
  if (!s?.MediaContainer) return null;
  return { streams: (s.MediaContainer.Metadata || []).map((m) => ({
    title: m.grandparentTitle ? `${m.grandparentTitle} — ${m.title}` : m.title,
    user: m.User?.title, state: m.Player?.state,
    progress: m.duration ? m.viewOffset / m.duration : null,
  })) };
}

async function unraid() {
  const c = cfg.unraid;
  const out = { id: 'unraid', name: c.name, os: 'Unraid', host: c.host, ui: c.ui, configured: !!c.key, errors: [] };
  const u = new URL(c.ui);
  out.latency = await tcpPing(u.hostname, +u.port || (u.protocol === 'https:' ? 443 : 80));
  out.online = out.latency != null;
  if (!out.online || !c.key) return out;

  const r = await runAll({
    os: unraidQuery('{ info { os { hostname uptime distro release kernel } } }'),
    version: unraidQuery('{ info { versions { core { unraid } } } }', '{ info { versions { unraid } } }'),
    cpu: unraidQuery('{ info { cpu { manufacturer brand cores threads } } }'),
    metrics: unraidQuery(
      '{ metrics { cpu { percentTotal } memory { total used percentTotal } } }',
      '{ info { memory { total used free available } } }'),
    array: unraidQuery(
      `{ array { state capacity { kilobytes { total used free } }
          parities { name size temp status }
          disks { name size temp status fsSize fsUsed fsFree }
          caches { name size temp status fsSize fsUsed fsFree } } }`),
    docker: unraidQuery('{ docker { containers { names state status image autoStart } } }'),
    vms: unraidQuery('{ vms { domains { name state } } }'),
  }, out);

  const os = r.os?.info?.os;
  if (os) {
    out.hostname = os.hostname;
    const up = os.uptime;
    out.uptime = typeof up === 'number' ? up : up ? Math.round((Date.now() - Date.parse(up)) / 1000) : null;
  }
  const v = r.version?.info?.versions;
  out.version = v?.core?.unraid || v?.unraid || null;
  const cp = r.cpu?.info?.cpu;
  if (cp) out.cpu = { model: [cp.manufacturer, cp.brand].filter(Boolean).join(' '), cores: cp.cores, threads: cp.threads };
  const m = r.metrics;
  if (m?.metrics) {
    out.cpu = { ...(out.cpu || {}), usage: m.metrics.cpu?.percentTotal ?? null };
    out.memory = { total: +m.metrics.memory?.total, used: +m.metrics.memory?.used };
  } else if (m?.info?.memory) {
    const mm = m.info.memory;
    out.memory = { total: +mm.total, used: mm.available != null ? mm.total - mm.available : +mm.used };
  }
  const a = r.array?.array;
  if (a) {
    const k = a.capacity?.kilobytes || {};
    out.array = { state: a.state, total: kb(k.total), used: kb(k.used), free: kb(k.free) };
    out.disks = [
      ...(a.parities || []).map((d) => mapDisk(d, 'parity')),
      ...(a.disks || []).map((d) => mapDisk(d, 'data')),
      ...(a.caches || []).map((d) => mapDisk(d, 'cache')),
    ];
  }
  out.containers = (r.docker?.docker?.containers || []).map((x) => ({
    name: (x.names?.[0] || '').replace(/^\//, ''),
    state: String(x.state || '').toLowerCase(), status: x.status, image: x.image,
  })).sort((a, b) => a.name.localeCompare(b.name));
  out.vms = (r.vms?.vms?.domains || []).map((d) => ({ name: d.name, state: String(d.state || '').toLowerCase() }));
  return out;
}

// --- server stats (TrueNAS SCALE REST v2.0, incl. HexOS) ---------------------
const truenasApi = (p, method = 'GET', body) => fetchJson(`https://${cfg.truenas.host}/api/v2.0/${p}`, {
  method,
  headers: { Authorization: `Bearer ${cfg.truenas.key}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

const HEXOS_PORT = 43705; // HexOS serves its own UI here on top of TrueNAS
let hexos = null;

async function truenas() {
  const c = cfg.truenas;
  if (hexos === null) hexos = (await tcpPing(c.host, HEXOS_PORT)) != null;
  const out = {
    id: 'truenas', name: c.name, os: hexos ? 'HexOS' : 'TrueNAS', host: c.host,
    ui: hexos ? `https://${c.host}:${HEXOS_PORT}/` : `https://${c.host}/ui/`, apiUi: `https://${c.host}/ui/`,
    configured: !!c.key, errors: [],
  };
  out.latency = await tcpPing(c.host, 443);
  out.online = out.latency != null;
  if (!out.online || !c.key) return out;

  const r = await runAll({
    info: truenasApi('system/info'),
    pools: truenasApi('pool'),
    apps: truenasApi('app'),
    disks: truenasApi('disk'),
    temps: truenasApi('disk/temperatures', 'POST', {}),
  }, out);

  if (r.info) {
    const i = r.info;
    out.hostname = i.hostname;
    out.version = i.version;
    out.uptime = Math.round(i.uptime_seconds || 0);
    out.cpu = { model: i.model, cores: i.physical_cores || i.cores, threads: i.cores, load: i.loadavg };
    if (i.loadavg && i.cores) out.cpu.usage = Math.min(100, (i.loadavg[0] / i.cores) * 100);
    out.memory = { total: i.physmem, used: null };
  }
  if (Array.isArray(r.pools)) {
    out.pools = r.pools.map((p) => ({ name: p.name, status: p.status, healthy: p.healthy, total: p.size, used: p.allocated, free: p.free }));
    const t = out.pools.reduce((s, p) => s + (p.total || 0), 0);
    const u = out.pools.reduce((s, p) => s + (p.used || 0), 0);
    out.array = { state: out.pools.every((p) => p.healthy) ? 'HEALTHY' : 'DEGRADED', total: t, used: u, free: t - u };
  }
  const temps = r.temps && typeof r.temps === 'object' ? r.temps : {};
  if (Array.isArray(r.disks)) {
    out.disks = r.disks.map((d) => ({ name: d.name, role: d.pool || 'disk', model: d.model, size: d.size, temp: temps[d.name] ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (Array.isArray(r.apps)) {
    out.containers = r.apps.map((a) => ({
      name: a.name, state: String(a.state || '').toLowerCase(),
      status: a.human_version || a.version, upgrade: !!a.upgrade_available,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

// --- http -----------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/status') {
      const fns = { unraid, truenas };
      const [list, plex] = await Promise.all([Promise.all(servers.map((x) => settle(fns[x.id]()))), plexStreams()]);
      const out = list.filter(Boolean);
      if (plex && out[0]) out[0].plex = plex;
      return send(res, 200, { time: Date.now(), servers: out });
    }
    if (route === 'GET /api/apps') return send(res, 200, { apps: appsPayload(), servers, interval: cfg.checkInterval });

    if (route === 'POST /api/apps') {
      const b = await readBody(req);
      if (!hosts[b.server] || !(b.port > 0 && b.port < 65536) || !b.name) return send(res, 400, { error: 'server, port and name are required' });
      const id = `${b.server}-${b.port}`;
      if (store.apps.some((a) => a.id === id)) return send(res, 409, { error: 'That port is already tracked' });
      const app = { id, name: String(b.name).slice(0, 60), server: b.server, port: +b.port, icon: b.icon || slug(b.name) };
      if (b.scheme === 'https') app.scheme = 'https';
      if (b.tcp) app.tcp = true;
      if (b.path) app.path = String(b.path);
      store.apps.push(app);
      store.ignored = store.ignored.filter((i) => !(i.server === b.server && i.port === +b.port));
      saveStore();
      checkApp(app);
      return send(res, 201, app);
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/apps/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/apps/'.length));
      const app = store.apps.find((a) => a.id === id);
      if (!app) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if ('favorite' in b) { if (b.favorite) app.favorite = true; else delete app.favorite; }
      if (b.name) app.name = String(b.name).slice(0, 60);
      if (b.icon) app.icon = String(b.icon).slice(0, 60);
      saveStore();
      return send(res, 200, app);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/apps/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/apps/'.length));
      store.apps = store.apps.filter((a) => a.id !== id);
      health.delete(id);
      saveStore();
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/ignore') {
      const b = await readBody(req);
      if (hosts[b.server] && b.port) {
        store.ignored.push({ server: b.server, port: +b.port });
        saveStore();
        if (scan.results) scan.results.forEach((r) => { if (r.server === b.server && r.port === +b.port) r.ignored = true; });
      }
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/scan') {
      const b = await readBody(req);
      if (!hosts[b.server]) return send(res, 400, { error: 'unknown server' });
      if (scan.running) return send(res, 409, { error: 'A scan is already running' });
      runScan(b.server).catch((e) => { scan = { running: false, error: e.message }; });
      return send(res, 202, { ok: true });
    }
    if (route === 'GET /api/scan') {
      const tracked = new Set(store.apps.map((a) => `${a.server}-${a.port}`));
      if (scan.results) scan.results.forEach((r) => { r.tracked = tracked.has(`${r.server}-${r.port}`); });
      return send(res, 200, scan);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (url.pathname === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(path.join(__dirname, 'public', 'icon.svg')).pipe(res);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

loadStore();
checkAll();
setInterval(checkAll, cfg.checkInterval);

server.listen(cfg.port, () => {
  console.log(`EDITH on http://localhost:${cfg.port} — tracking ${store.apps.length} apps`);
  if (!servers.length) console.log('  ! No servers configured — set UNRAID_HOST and/or TRUENAS_HOST');
  for (const x of servers) if (!cfg[x.id].key) console.log(`  ! ${x.id.toUpperCase()}_API_KEY not set — ${x.name} shows reachability only`);
});
