import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET is not set; sessions will reset whenever the server restarts');
}

const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');

export function makeToken(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
    'base64url'
  );
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, sign(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  // Hash first so the comparison is constant time regardless of length.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Fingerprint of the admin credentials, embedded in admin sessions so that
// changing ADMIN_USERNAME or ADMIN_PASSWORD signs every admin out.
export function adminFingerprint() {
  return createHash('sha256')
    .update(`${process.env.ADMIN_USERNAME}\n${process.env.ADMIN_PASSWORD}`)
    .digest('base64url')
    .slice(0, 16);
}

export function adminConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
}

export function checkAdminCredentials(username, password) {
  if (!adminConfigured()) return false;
  const userOk = safeEqual(username, process.env.ADMIN_USERNAME);
  const passOk = safeEqual(password, process.env.ADMIN_PASSWORD);
  return userOk && passOk;
}

// Fixed-window rate limiter keyed by IP + bucket name.
const hits = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60_000).unref();
