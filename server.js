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
  plex: { url: (env.PLEX_URL || '').replace(/\/$/, ''), token: env.PLEX_TOKEN || '' },
};
const TYPES = ['unraid', 'truenas'];

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

// Request a page without following redirects; returns { status, headers, text } or null.
async function probeHttp(url, timeout = 2500, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { redirect: 'manual', signal: ctrl.signal, ...opts, headers: { 'User-Agent': 'edith-dashboard', ...opts.headers } });
    const text = (await r.text()).slice(0, 200000);
    return { status: r.status, headers: r.headers, text };
  } catch { return null; } finally { clearTimeout(timer); }
}

const settle = async (p) => { try { return await p; } catch { return null; } };
const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- store: servers, apps, ignored ports ------------------------------------
const dataDir = env.DATA_DIR || path.join(__dirname, 'data');
const storeFile = path.join(dataDir, 'config.json');
const legacyFile = path.join(dataDir, 'apps.json');
let store = { servers: [], apps: [], ignored: [] };

function loadStore() {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  const file = fs.existsSync(storeFile) ? storeFile : fs.existsSync(legacyFile) ? legacyFile : null;
  if (file) store = { servers: [], apps: [], ignored: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  // Optional: preconfigure servers via environment on first run.
  if (!store.servers.length) {
    if (env.UNRAID_HOST) store.servers.push({ id: 'unraid', type: 'unraid', name: env.UNRAID_NAME || 'Unraid', host: env.UNRAID_HOST, url: env.UNRAID_URL || '', apiKey: env.UNRAID_API_KEY || '' });
    if (env.TRUENAS_HOST) store.servers.push({ id: 'truenas', type: 'truenas', name: env.TRUENAS_NAME || 'TrueNAS', host: env.TRUENAS_HOST, apiKey: env.TRUENAS_API_KEY || '' });
  }
  store.apps.forEach((a) => { a.id = a.id || `${a.server}-${a.port}`; });
  saveStore();
  if (file === legacyFile) try { fs.renameSync(legacyFile, legacyFile + '.bak'); } catch {}
}
function saveStore() {
  try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); }
  catch (e) { console.error(`! Can't save ${storeFile}: ${e.message} — changes will be lost on restart`); }
}

const serverById = (id) => store.servers.find((s) => s.id === id);
const hostOf = (id) => serverById(id)?.host;
// What the browser may see: never the API key.
const publicServer = ({ apiKey, ...s }) => ({ ...s, hasKey: !!apiKey });

function uniqueId(name) {
  const base = slug(name) || 'server';
  let id = base, n = 2;
  while (serverById(id)) id = `${base}-${n++}`;
  return id;
}

// --- server detection -------------------------------------------------------
const HEXOS_PORT = 43705; // HexOS serves its own UI here on top of TrueNAS

// Works out whether a host is TrueNAS (incl. HexOS) or Unraid, and where its web UI lives.
async function detect(host) {
  const ports = [80, 443, 8080, 8443, HEXOS_PORT];
  const open = Object.fromEntries(await Promise.all(ports.map(async (p) => [p, (await tcpPing(host, p, 1500)) != null])));
  const out = { host, reachable: Object.values(open).some(Boolean), type: null, flavor: null, url: null };
  if (!out.reachable) return out;

  if (open[443]) {
    // TrueNAS lists its API versions publicly; older releases answer the REST API with a plain-text 401.
    const v = await probeHttp(`https://${host}/api/versions`);
    const isTrueNAS = (v?.status === 200 && /^\s*\[\s*"v\d/.test(v.text))
      || /^401: Unauthorized/.test((await probeHttp(`https://${host}/api/v2.0/system/info`))?.text || '')
      || /TrueNAS/i.test((await probeHttp(`https://${host}/ui/`))?.text || '');
    if (isTrueNAS) {
      out.type = 'truenas';
      out.flavor = open[HEXOS_PORT] ? 'HexOS' : 'TrueNAS';
      out.url = open[HEXOS_PORT] ? `https://${host}:${HEXOS_PORT}/` : `https://${host}/ui/`;
      return out;
    }
  }
  // Unraid: its GraphQL API answers unauthenticated requests with a CSRF / auth error;
  // older releases without the API redirect / to /Main or /login.
  for (const [scheme, port] of [['http', 80], ['http', 8080], ['https', 443], ['https', 8443]]) {
    if (!open[port]) continue;
    const base = `${scheme}://${host}${(scheme === 'http' && port === 80) || (scheme === 'https' && port === 443) ? '' : ':' + port}`;
    const g = await probeHttp(`${base}/graphql`, 2500, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"{ __typename }"}' });
    const root = g && /CSRF|UNAUTHENTICATED/i.test(g.text) ? null : await probeHttp(`${base}/`);
    const loc = root?.headers.get('location') || '';
    if ((g && /CSRF|UNAUTHENTICATED/i.test(g.text)) || /\/(Main|login)$/i.test(loc)) {
      out.type = 'unraid'; out.flavor = 'Unraid'; out.url = base;
      return out;
    }
  }
  return out;
}

// Checks an API key against the server; returns null if it works, else an error message.
async function testKey(s) {
  try {
    if (s.type === 'unraid') await unraidQuery(s, '{ info { os { hostname } } }');
    else await truenasApi(s, 'system/info');
    return null;
  } catch (e) { return e.message; }
}

// --- background health checks ----------------------------------------------
const HISTORY = 48;
const health = new Map(); // id -> { up, ms, code, checked, history: [ms|null] }

function appUrl(a) {
  if (a.url) return a.url;
  if (a.tcp) return null;
  return `${a.scheme || 'http'}://${hostOf(a.server)}:${a.port}${a.path || ''}`;
}

async function checkApp(a) {
  const host = hostOf(a.server);
  if (!host) return;
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
  try { await Promise.all(store.apps.map(checkApp)); } finally { checking = false; }
}

function appsPayload() {
  return store.apps.filter((a) => hostOf(a.server)).map((a) => {
    const h = health.get(a.id) || { history: [] };
    const seen = h.history.filter((x) => x !== undefined);
    const upCount = seen.filter((x) => x !== null).length;
    return {
      ...a, host: hostOf(a.server), link: appUrl(a),
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
  const host = hostOf(server);
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
const unraidUrl = (s) => (s.url || `http://${s.host}`).replace(/\/$/, '');

async function unraidQuery(s, ...variants) {
  // Schema shifts between Unraid API releases; try each variant until one works.
  let lastErr;
  for (const query of variants) {
    try {
      const r = await fetchJson(`${unraidUrl(s)}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': s.apiKey },
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

async function unraid(s) {
  const ui = unraidUrl(s);
  const out = { id: s.id, type: 'unraid', name: s.name, os: 'Unraid', host: s.host, ui, configured: !!s.apiKey, errors: [] };
  const u = new URL(ui);
  out.latency = await tcpPing(u.hostname, +u.port || (u.protocol === 'https:' ? 443 : 80));
  out.online = out.latency != null;
  if (!out.online || !s.apiKey) return out;

  const q = (...v) => unraidQuery(s, ...v);
  const r = await runAll({
    os: q('{ info { os { hostname uptime distro release kernel } } }'),
    version: q('{ info { versions { core { unraid } } } }', '{ info { versions { unraid } } }'),
    cpu: q('{ info { cpu { manufacturer brand cores threads } } }'),
    metrics: q(
      '{ metrics { cpu { percentTotal } memory { total used percentTotal } } }',
      '{ info { memory { total used free available } } }'),
    array: q(
      `{ array { state capacity { kilobytes { total used free } }
          parities { name size temp status }
          disks { name size temp status fsSize fsUsed fsFree }
          caches { name size temp status fsSize fsUsed fsFree } } }`),
    docker: q('{ docker { containers { names state status image autoStart } } }'),
    vms: q('{ vms { domains { name state } } }'),
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
const truenasApi = (s, p, method = 'GET', body) => fetchJson(`https://${s.host}/api/v2.0/${p}`, {
  method,
  headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

const hexos = new Map(); // host -> bool, detected once

async function truenas(s) {
  if (!hexos.has(s.host)) hexos.set(s.host, (await tcpPing(s.host, HEXOS_PORT)) != null);
  const isHex = hexos.get(s.host);
  const out = {
    id: s.id, type: 'truenas', name: s.name, os: isHex ? 'HexOS' : 'TrueNAS', host: s.host,
    ui: s.url || (isHex ? `https://${s.host}:${HEXOS_PORT}/` : `https://${s.host}/ui/`), apiUi: `https://${s.host}/ui/`,
    configured: !!s.apiKey, errors: [],
  };
  out.latency = await tcpPing(s.host, 443);
  out.online = out.latency != null;
  if (!out.online || !s.apiKey) return out;

  const api = (...a) => truenasApi(s, ...a);
  const r = await runAll({
    info: api('system/info'),
    pools: api('pool'),
    apps: api('app'),
    disks: api('disk'),
    temps: api('disk/temperatures', 'POST', {}),
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
    const t = out.pools.reduce((sum, p) => sum + (p.total || 0), 0);
    const u = out.pools.reduce((sum, p) => sum + (p.used || 0), 0);
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

const statsFor = { unraid, truenas };

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
const cleanHost = (h) => String(h || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;
  const idFrom = (prefix) => decodeURIComponent(url.pathname.slice(prefix.length));
  try {
    if (route === 'GET /api/status') {
      const [list, plex] = await Promise.all([Promise.all(store.servers.map((s) => settle(statsFor[s.type](s)))), plexStreams()]);
      const out = list.filter(Boolean);
      if (plex && out[0]) out[0].plex = plex;
      return send(res, 200, { time: Date.now(), servers: out });
    }
    if (route === 'GET /api/apps') return send(res, 200, { apps: appsPayload(), servers: store.servers.map(publicServer), interval: cfg.checkInterval });

    // servers
    if (route === 'GET /api/servers') return send(res, 200, { servers: store.servers.map(publicServer) });
    if (route === 'POST /api/servers/detect') {
      const b = await readBody(req);
      const host = cleanHost(b.host);
      if (!host) return send(res, 400, { error: 'Enter an IP address or hostname' });
      return send(res, 200, await detect(host));
    }
    if (route === 'POST /api/servers') {
      const b = await readBody(req);
      const host = cleanHost(b.host);
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name || !host) return send(res, 400, { error: 'Name and IP / hostname are required' });
      let type = TYPES.includes(b.type) ? b.type : null;
      let urlGuess = b.url ? String(b.url).trim() : '';
      if (!type || (type === 'unraid' && !urlGuess)) {
        const d = await detect(host);
        if (!d.reachable) return send(res, 400, { error: `Can't reach ${host}` });
        type = type || d.type;
        if (!type) return send(res, 400, { error: `Couldn't tell what ${host} is running — pick Unraid or TrueNAS` });
        if (!urlGuess && d.type === type && type === 'unraid') urlGuess = d.url;
      }
      const s = { id: uniqueId(name), type, name, host, url: urlGuess, apiKey: String(b.apiKey || '').trim() };
      store.servers.push(s);
      saveStore();
      const keyError = s.apiKey ? await testKey(s) : null;
      return send(res, 201, { server: publicServer(s), keyError });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/servers/')) {
      const s = serverById(idFrom('/api/servers/'));
      if (!s) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.name) s.name = String(b.name).trim().slice(0, 40);
      if (b.host) { s.host = cleanHost(b.host); hexos.delete(s.host); }
      if ('url' in b) s.url = String(b.url || '').trim();
      if (TYPES.includes(b.type)) s.type = b.type;
      if (b.apiKey) s.apiKey = String(b.apiKey).trim();
      if (b.clearKey) s.apiKey = '';
      saveStore();
      const keyError = b.apiKey ? await testKey(s) : null;
      return send(res, 200, { server: publicServer(s), keyError });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/servers/')) {
      const id = idFrom('/api/servers/');
      store.servers = store.servers.filter((s) => s.id !== id);
      store.apps.filter((a) => a.server === id).forEach((a) => health.delete(a.id));
      store.apps = store.apps.filter((a) => a.server !== id);
      store.ignored = store.ignored.filter((i) => i.server !== id);
      saveStore();
      return send(res, 200, { ok: true });
    }

    // apps
    if (route === 'POST /api/apps') {
      const b = await readBody(req);
      if (!hostOf(b.server) || !(b.port > 0 && b.port < 65536) || !b.name) return send(res, 400, { error: 'server, port and name are required' });
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
      const app = store.apps.find((a) => a.id === idFrom('/api/apps/'));
      if (!app) return send(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if ('favorite' in b) { if (b.favorite) app.favorite = true; else delete app.favorite; }
      if (b.name) app.name = String(b.name).slice(0, 60);
      if (b.icon) app.icon = String(b.icon).slice(0, 60);
      saveStore();
      return send(res, 200, app);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/apps/')) {
      const id = idFrom('/api/apps/');
      store.apps = store.apps.filter((a) => a.id !== id);
      health.delete(id);
      saveStore();
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/ignore') {
      const b = await readBody(req);
      if (hostOf(b.server) && b.port) {
        store.ignored.push({ server: b.server, port: +b.port });
        saveStore();
        if (scan.results) scan.results.forEach((r) => { if (r.server === b.server && r.port === +b.port) r.ignored = true; });
      }
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/scan') {
      const b = await readBody(req);
      if (!hostOf(b.server)) return send(res, 400, { error: 'unknown server' });
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
  console.log(`EDITH on http://localhost:${cfg.port} — ${store.servers.length} servers, ${store.apps.length} apps`);
  if (!store.servers.length) console.log('  Open the page to add your servers.');
});
