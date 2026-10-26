const crypto = require('crypto');
const { SESSION_KEY, TICKET_KEY, IS_PROD } = require('./config');

/* ---------- constant-time compare ---------- */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* ---------- passwords (scrypt) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

/* ---------- signed session cookie ---------- */
const COOKIE = 'sid';
const SESSION_DAYS = 14;
const mac = (payload) => crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');

function makeSession(orgId, staffId = 0) {
  const payload = Buffer.from(JSON.stringify({ o: orgId, s: staffId || 0, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + mac(payload);
}
/** Returns {o: orgId, s: staffId or 0} for a valid, unexpired cookie, else null. */
function readSessionFull(value) {
  if (!value) return null;
  const [payload, sig] = String(value).split('.');
  if (!payload || !sig || !safeEqual(sig, mac(payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d && d.e > Date.now() ? { o: d.o, s: d.s || 0 } : null;
  } catch (_) { return null; }
}
function readSession(value) { const d = readSessionFull(value); return d ? d.o : null; }
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, orgId, staffId = 0) {
  const parts = [`${COOKIE}=${encodeURIComponent(makeSession(orgId, staffId))}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (IS_PROD) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- tickets (HMAC-signed attendee ids) ---------- */
const sign = (id) => crypto.createHmac('sha256', TICKET_KEY).update(id).digest('base64url').slice(0, 16);
const makeToken = (id) => `${id}.${sign(id)}`;
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [id, sig] = token.split('.');
  if (!id || !sig || !safeEqual(sig, sign(id))) return null;
  return id;
}
const newAttendeeId = () => crypto.randomBytes(6).toString('hex').toUpperCase();
const newGateKey = () => crypto.randomBytes(9).toString('base64url');

/* ---------- in-memory rate limiting (single instance) ---------- */
const hits = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const k = bucket + ':' + req.ip;
    const now = Date.now();
    const rec = hits.get(k);
    if (!rec || now > rec.reset) { hits.set(k, { n: 1, reset: now + windowMs }); return next(); }
    if (++rec.n > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    next();
  };
}
// Lockout after repeated failures. Check isLocked() BEFORE comparing a secret, and call fail() on a miss.
const lock = {
  isLocked(bucket, ip, max = 15) {
    const k = 'fail:' + bucket + ':' + ip, rec = hits.get(k);
    if (rec && Date.now() > rec.reset) { hits.delete(k); return false; }
    return !!rec && rec.n >= max;
  },
  fail(bucket, ip, windowMs = 60000) {
    const k = 'fail:' + bucket + ':' + ip, rec = hits.get(k);
    if (rec && Date.now() <= rec.reset) rec.n++; else hits.set(k, { n: 1, reset: Date.now() + windowMs });
  },
  clear(bucket, ip) { hits.delete('fail:' + bucket + ':' + ip); }
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

module.exports = {
  safeEqual, hashPassword, verifyPassword,
  COOKIE, setSessionCookie, clearSessionCookie, readSession, readSessionFull, parseCookies,
  makeToken, verifyToken, newAttendeeId, newGateKey,
  rateLimit, lock
};
