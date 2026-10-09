import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { migrate } from './src/schema.js';
import { Store } from './src/store.js';
import { HttpError, money, playerName, validateMachine, validateSettings } from './src/validate.js';
import {
  adminConfigured,
  adminFingerprint,
  checkAdminCredentials,
  makeToken,
  rateLimit,
  readToken,
} from './src/auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH || '/admin');

const PLAYER_COOKIE = 'lm_player';
const ADMIN_COOKIE = 'lm_admin';
const PLAYER_TTL = 60 * 60 * 24 * 30;
const ADMIN_TTL = 60 * 60 * 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function normalizeAdminPath(p) {
  const clean = '/' + p.trim().replace(/^\/+|\/+$/g, '');
  if (clean === '/' || clean.startsWith('/api') || clean.startsWith('/shared')) {
    throw new Error('ADMIN_PATH must be a sub-path such as /backstage and cannot start with /api or /shared');
  }
  return clean;
}

// ---------- helpers ----------

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge, cookiePath = '/') {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${cookiePath}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    PROD ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  const type = String(req.headers['content-type'] || '');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  // Requiring JSON blocks simple cross-site form posts.
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected JSON');
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function serveFile(res, file, { noindex = false } = {}) {
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      ...(noindex ? { 'x-robots-tag': 'noindex, nofollow' } : {}),
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(dir, rel) {
  const full = path.resolve(dir, '.' + path.posix.normalize('/' + rel));
  return full.startsWith(dir + path.sep) ? full : null;
}

// ---------- app ----------

const db = await openDb();
await migrate(db);
const store = new Store(db);
await store.load();

let lobbyCache = { at: 0, data: null };
async function lobbyFeed() {
  if (Date.now() - lobbyCache.at > 10_000) {
    lobbyCache = { at: Date.now(), data: await store.recentJackpots(8) };
  }
  return lobbyCache.data;
}

async function currentPlayer(req) {
  const t = readToken(parseCookies(req)[PLAYER_COOKIE]);
  if (!t || t.kind !== 'player') return null;
  const p = await store.getPlayer(t.pid);
  if (!p || p.code !== t.code || !p.active) return null;
  return p;
}

async function requirePlayer(req) {
  const p = await currentPlayer(req);
  if (!p) throw new HttpError(401, 'Please enter your code again');
  return p;
}

function isAdmin(req) {
  const t = readToken(parseCookies(req)[ADMIN_COOKIE]);
  return Boolean(t && t.kind === 'admin' && adminConfigured() && t.fp === adminFingerprint());
}

function publicPlayer(p) {
  const { id, code, name, balance, spins, wagered, won, biggest_win, jackpots, bj_hands, bj_net, created_at } = p;
  return { id, code, name, balance, spins, wagered, won, biggest_win, jackpots, bj_hands, bj_net, created_at };
}

function playerSession(p) {
  return { 'set-cookie': cookie(PLAYER_COOKIE, makeToken({ kind: 'player', pid: p.id, code: p.code }, PLAYER_TTL), PLAYER_TTL) };
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

// ----- player API -----

route('GET', '/healthz', async () => ({ ok: true }));

route('GET', '/api/config', async () => store.publicConfig());

route('GET', '/api/lobby', async () => ({ jackpots: store.jackpots(), recent: await lobbyFeed() }));

route('POST', '/api/login', async ({ req, body }) => {
  if (!rateLimit(`login:${clientIp(req)}`, 15, 5 * 60_000)) {
    throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }
  const code = String(body.code || '');
  if (!/^\d{5}$/.test(code)) throw new HttpError(400, 'Your code is 5 digits');
  const p = await store.getPlayerByCode(code);
  if (!p) throw new HttpError(401, 'That code does not exist');
  if (!p.active) throw new HttpError(403, 'This account is disabled. Talk to the host.');
  await store.touch(p.id);
  return { status: 200, headers: playerSession(p), body: { player: publicPlayer(p) } };
});

route('POST', '/api/signup', async ({ req, body }) => {
  if (!store.settings.allowSignup) throw new HttpError(403, 'Sign-ups are closed. Ask the host for a code.');
  if (!rateLimit(`signup:${clientIp(req)}`, 5, 60 * 60_000)) {
    throw new HttpError(429, 'Too many sign-ups from this device. Try again later.');
  }
  const p = await store.createPlayer(playerName(body.name), store.settings.startingBalance);
  return { status: 201, headers: playerSession(p), body: { player: publicPlayer(p) } };
});

route('POST', '/api/logout', async () => ({
  status: 200,
  headers: { 'set-cookie': cookie(PLAYER_COOKIE, '', 0) },
  body: { ok: true },
}));

route('GET', '/api/me', async ({ req }) => {
  const p = await requirePlayer(req);
  const d = await store.playerDetails(p.id, 25);
  return { player: publicPlayer(d.player), machines: d.machines, transactions: d.transactions };
});

route('POST', '/api/spin', async ({ req, body }) => {
  const p = await requirePlayer(req);
  if (!rateLimit(`spin:${p.id}`, 8, 3000)) throw new HttpError(429, 'Slow down a little');
  return store.spin(p.id, String(body.machineId || ''), Math.round(Number(body.bet)));
});

route('GET', '/api/leaderboard', async ({ req }) => {
  await requirePlayer(req);
  if (!store.settings.showLeaderboard) throw new HttpError(404, 'The leaderboard is hidden');
  return { players: await store.leaderboard() };
});

// ----- admin API -----

route('POST', '/api/admin/login', async ({ req, body }) => {
  if (!adminConfigured()) throw new HttpError(503, 'Admin is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD.');
  if (!rateLimit(`admin:${clientIp(req)}`, 8, 15 * 60_000)) {
    throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
  }
  if (!checkAdminCredentials(String(body.username || ''), String(body.password || ''))) {
    throw new HttpError(401, 'Wrong username or password');
  }
  const token = makeToken({ kind: 'admin', fp: adminFingerprint() }, ADMIN_TTL);
  return { status: 200, headers: { 'set-cookie': cookie(ADMIN_COOKIE, token, ADMIN_TTL) }, body: { ok: true } };
});

route('POST', '/api/admin/logout', async () => ({
  status: 200,
  headers: { 'set-cookie': cookie(ADMIN_COOKIE, '', 0) },
  body: { ok: true },
}));

route('GET', '/api/admin/session', async ({ req }) => ({ admin: isAdmin(req) }));

const admin = (method, pattern, handler) =>
  route(method, pattern, async (ctx) => {
    if (!isAdmin(ctx.req)) throw new HttpError(401, 'Admin session expired');
    return handler(ctx);
  });

admin('GET', '/api/admin/dashboard', async () => store.dashboard());

admin('GET', '/api/admin/players', async ({ url }) => ({ players: await store.listPlayers(url.searchParams.get('q')) }));

admin('POST', '/api/admin/players', async ({ body }) => {
  const balance = body.balance === undefined || body.balance === '' ? store.settings.startingBalance : money(body.balance, 'Balance');
  return { player: await store.createPlayer(playerName(body.name), balance) };
});

admin('GET', '/api/admin/players/:id', async ({ params }) => store.playerDetails(Number(params.id), 50));

admin('PATCH', '/api/admin/players/:id', async ({ params, body }) => ({
  player: await store.updatePlayer(Number(params.id), {
    name: body.name === undefined ? undefined : playerName(body.name),
    active: body.active,
  }),
}));

admin('POST', '/api/admin/players/:id/adjust', async ({ params, body }) => {
  const id = Number(params.id);
  let amount;
  if (body.setBalance !== undefined) {
    const target = money(body.setBalance, 'Balance');
    const p = await store.getPlayer(id);
    if (!p) throw new HttpError(404, 'Player not found');
    amount = target - p.balance;
  } else {
    amount = money(body.amount, 'Amount', { allowNegative: true });
  }
  if (amount === 0) throw new HttpError(400, 'Nothing to change');
  return store.adjust(id, amount, 'adjust', String(body.note || '').slice(0, 120) || 'Manual adjustment');
});

admin('POST', '/api/admin/players/:id/regenerate-code', async ({ params }) => ({
  player: await store.regenerateCode(Number(params.id)),
}));

admin('DELETE', '/api/admin/players/:id', async ({ params }) => {
  await store.deletePlayer(Number(params.id));
  return { ok: true };
});

admin('POST', '/api/admin/blackjack', async ({ body }) => {
  const amount = money(body.amount, 'Amount', { allowNegative: true });
  if (amount === 0 && !body.push) throw new HttpError(400, 'Enter an amount');
  const note = String(body.note || '').slice(0, 120) || (amount > 0 ? 'Blackjack win' : amount < 0 ? 'Blackjack loss' : 'Blackjack push');
  return store.adjust(Number(body.playerId), amount, 'blackjack', note);
});

admin('GET', '/api/admin/activity', async ({ url }) => ({
  entries: await store.activity(url.searchParams.get('type') || 'all', url.searchParams.get('limit'), url.searchParams.get('before')),
}));

admin('POST', '/api/admin/transactions/:id/void', async ({ params }) => store.voidTransaction(Number(params.id)));

admin('GET', '/api/admin/machines', async () => ({ machines: store.adminMachines() }));

admin('PUT', '/api/admin/machines/:id', async ({ params, body }) => store.saveMachine(validateMachine(body, params.id)));

admin('POST', '/api/admin/machines/:id/jackpot', async ({ params, body }) =>
  store.setJackpot(params.id, money(body.amount, 'Jackpot'))
);

admin('POST', '/api/admin/machines/:id/reset', async ({ params }) => store.resetMachine(params.id));

admin('GET', '/api/admin/settings', async () => ({ settings: store.settings }));

admin('PUT', '/api/admin/settings', async ({ body }) => ({ settings: await store.saveSettings(validateSettings(body)) }));

// ---------- server ----------

const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');
const SHARED_DIR = path.join(ROOT, 'shared');

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      for (const r of routes) {
        const m = r.method === req.method && pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = await readJson(req);
        const out = await r.handler({ req, url, params, body });
        if (out && out.status && out.body !== undefined) return send(res, out.status, out.body, out.headers);
        return send(res, 200, out);
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    // Hidden admin panel.
    if (pathname === ADMIN_PATH) return send(res, 301, '', { location: ADMIN_PATH + '/' });
    if (pathname.startsWith(ADMIN_PATH + '/')) {
      const rel = pathname.slice(ADMIN_PATH.length + 1) || 'index.html';
      const file = safeJoin(ADMIN_DIR, rel);
      if (file && (await serveFile(res, file, { noindex: true }))) return;
      throw new HttpError(404, 'Not found');
    }

    if (pathname.startsWith('/shared/')) {
      const file = safeJoin(SHARED_DIR, pathname.slice('/shared/'.length));
      if (file && (await serveFile(res, file))) return;
      throw new HttpError(404, 'Not found');
    }

    const file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (file && (await serveFile(res, file))) return;
    throw new HttpError(404, 'Not found');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Lucky Machines listening on http://localhost:${PORT} (database: ${db.kind})`);
  console.log(`Admin panel: ${ADMIN_PATH}/${adminConfigured() ? '' : '  (disabled until ADMIN_USERNAME and ADMIN_PASSWORD are set)'}`);
});
