const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const cfg = require('./lib/config');
const db = require('./lib/db');
const sec = require('./lib/security');
const { parseGuests } = require('./lib/csv');
const report = require('./lib/report');
const mail = require('./lib/mail');
const google = require('./lib/google');
const cal = require('./lib/ics');

const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // hosts terminate TLS at a proxy and forward the real client IP

/* ------------------------------------------------------------------ */
/* Platform plumbing                                                   */
/* ------------------------------------------------------------------ */
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch (_) { res.status(500).json({ ok: false }); }
});

app.use((req, res, next) => {
  if (cfg.IS_PROD && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...(cfg.IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
  });
  next();
});

app.use(express.json({ limit: '50kb' }));
app.use('/api/org/signup', sec.rateLimit('signup', 10, 60000));
app.use('/api/org/login', sec.rateLimit('login', 30, 60000));
// Limits are per IP. A campus or venue shares one IP across many people, so keep these generous.
app.use('/api/e/', sec.rateLimit('public', 600, 60000));
app.use('/api/ticket', sec.rateLimit('ticket', 300, 60000));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const str = (v, max) => String(v ?? '').trim().slice(0, max);
/** Phone numbers are optional. Keep digits, spaces and + ( ) - . only; 7 to 15 digits. Returns null when invalid. */
const cleanPhone = (v) => {
  const t = String(v ?? '').trim().slice(0, 40);
  if (!t) return '';
  if (/[^0-9+()\-.\s]/.test(t)) return null;
  const d = t.replace(/\D/g, '').length;
  return d >= 7 && d <= 15 ? t.replace(/\s+/g, ' ') : null;
};
const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : fallback);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '') && e.length <= 200;
const htmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}
function uniqueSlug(base) {
  let slug = base, i = 2;
  while (db.prepare('SELECT 1 FROM events WHERE slug=?').get(slug)) slug = `${base.slice(0, 36)}-${i++}`;
  return slug;
}
function parseDate(v) {
  const s = str(v, 40);
  if (!s) return { ok: true, value: '' };
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d.toISOString() };
}
function counts(eventId) {
  const r = db.prepare('SELECT COUNT(*) n, SUM(checked_in_at IS NOT NULL) c FROM attendees WHERE event_id=?').get(eventId);
  return { registered: r.n || 0, checked_in: r.c || 0 };
}
function guestCounts(eventId) {
  const g = guestList(eventId);
  return { expected: g.length, expected_registered: g.filter((x) => x.status !== 'not_registered').length, expected_arrived: g.filter((x) => x.status === 'checked_in').length };
}

/** Expected guests with their status, matched to registrations by email (or, when the guest has no email, by an unambiguous exact name). */
function guestList(eventId) {
  const guests = db.prepare('SELECT * FROM guests WHERE event_id=? ORDER BY name COLLATE NOCASE, id').all(eventId);
  if (!guests.length) return [];
  const att = db.prepare('SELECT id,name,email,checked_in_at FROM attendees WHERE event_id=?').all(eventId);
  const byEmail = new Map(att.map((a) => [a.email.toLowerCase(), a]));
  const nameKey = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const byName = new Map();
  for (const a of att) { const k = nameKey(a.name); byName.set(k, byName.has(k) ? null : a); }
  return guests.map((g) => {
    const a = (g.email && byEmail.get(g.email)) || (!g.email && byName.get(nameKey(g.name))) || null;
    return { ...g, attendee_id: a ? a.id : null, checked_in_at: a ? a.checked_in_at : null,
      status: !a ? 'not_registered' : a.checked_in_at ? 'checked_in' : 'registered' };
  });
}
function publicEvent(e) {
  const c = counts(e.id);
  const org = db.prepare('SELECT name FROM orgs WHERE id=?').get(e.org_id);
  return {
    slug: e.slug, name: e.name, tagline: e.tagline, description: e.description, venue: e.venue,
    starts_at: e.starts_at, ends_at: e.ends_at || '', calendar_auto: google.attendeeEnabled() && !!e.starts_at, capacity: e.capacity, org_name: org ? org.name : '',
    flyer_url: e.flyer ? '/uploads/' + e.flyer : null,
    theme: { bg: e.theme_bg, ink: e.theme_ink, accent: e.theme_accent },
    registration_open: !!e.registration_open,
    registered: c.registered, full: e.capacity > 0 && c.registered >= e.capacity
  };
}
const orgEvent = (e, role = 'owner') => {
  const o = { ...publicEvent(e), id: e.id, listed: !!e.listed, created_at: e.created_at, checked_in: counts(e.id).checked_in };
  if (role === 'owner') o.gate_key = e.gate_key; // front-desk logins scan with their session, so they never need to see the key
  return o;
};

function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function removeFlyerFile(name) {
  if (!name) return;
  try { fs.unlinkSync(path.join(cfg.UPLOAD_DIR, path.basename(name))); } catch (_) {}
}
function clampTime(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60000) return new Date().toISOString();
  return new Date(t).toISOString();
}

/** Create a registration for an event. Returns {error,status} or {id,token,existing}. */
function createAttendee(event, b, { requireTerms }) {
  const name = str(b.name, 120);
  const email = str(b.email, 200).toLowerCase();
  if (!name || !emailOk(email)) return { status: 400, error: 'Name and a valid email are required.' };
  const phone = cleanPhone(b.phone);
  if (phone === null) return { status: 400, error: 'That phone number does not look right. Use digits with an optional + and country code, or leave it empty.' };
  if (requireTerms && !b.consent_terms) return { status: 400, error: 'Please accept the privacy terms to register.' };
  const existing = db.prepare('SELECT id FROM attendees WHERE event_id=? AND email=?').get(event.id, email);
  if (existing) return { id: existing.id, token: sec.makeToken(existing.id), existing: true };
  const n = db.prepare('SELECT COUNT(*) n FROM attendees WHERE event_id=?').get(event.id).n;
  if (event.capacity > 0 && n >= event.capacity) return { status: 409, error: 'Sorry, this event is full.' };
  const id = sec.newAttendeeId();
  db.prepare(`INSERT INTO attendees (id,event_id,name,email,phone,organization,role,interests,consent_community,consent_directory)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, event.id, name, email, phone, str(b.organization, 120), str(b.role, 120), str(b.interests, 500),
    b.consent_community ? 1 : 0, b.consent_directory ? 1 : 0);
  return { id, token: sec.makeToken(id), existing: false };
}

/** Check one ticket in at one event. */
function checkin(event, token, at) {
  const id = sec.verifyToken(token);
  if (!id) return { status: 'invalid' };
  const a = db.prepare('SELECT id,event_id,name,organization,role,checked_in_at FROM attendees WHERE id=?').get(id);
  if (!a) return { status: 'invalid' };
  if (a.event_id !== event.id) return { status: 'wrong_event' };
  if (a.checked_in_at) return { status: 'duplicate', name: a.name, organization: a.organization, checked_in_at: a.checked_in_at };
  const when = at ? clampTime(at) : new Date().toISOString();
  db.prepare('UPDATE attendees SET checked_in_at=? WHERE id=? AND checked_in_at IS NULL').run(when, id);
  return { status: 'ok', name: a.name, organization: a.organization, role: a.role, checked_in_at: when };
}

/* ------------------------------------------------------------------ */
/* Public API (attendees)                                              */
/* ------------------------------------------------------------------ */
function findEventBySlug(req, res, next) {
  const e = db.prepare('SELECT * FROM events WHERE slug=?').get(String(req.params.slug || '').toLowerCase());
  if (!e) return res.status(404).json({ error: 'Event not found' });
  req.event = e;
  next();
}

app.get('/api/e/:slug', findEventBySlug, (req, res) => res.json(publicEvent(req.event)));

app.post('/api/e/:slug/register', findEventBySlug, (req, res) => {
  if (!req.event.registration_open) return res.status(403).json({ error: 'Registration for this event is closed.' });
  const r = createAttendee(req.event, req.body || {}, { requireTerms: true });
  if (r.error) return res.status(r.status).json({ error: r.error });
  // Never hand back the ticket for an email that is already registered: anyone could type
  // someone else's address and walk off with their entry. The organizer can resend it.
  if (r.existing) return res.json({ existing: true });
  res.json({ id: r.id, token: r.token, existing: false });
});

app.get('/api/e/:slug/community', findEventBySlug, (req, res) => {
  res.json(db.prepare('SELECT name,organization,role,interests FROM attendees WHERE event_id=? AND consent_directory=1 ORDER BY name').all(req.event.id));
});

app.get('/api/ticket/:token', async (req, res) => {
  const id = sec.verifyToken(req.params.token);
  if (!id) return res.status(404).json({ error: 'Invalid ticket' });
  const a = db.prepare('SELECT * FROM attendees WHERE id=?').get(id);
  if (!a) return res.status(404).json({ error: 'Ticket not found' });
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  const qr = await QRCode.toDataURL(sec.makeToken(id), { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  res.json({
    id: a.id, name: a.name, organization: a.organization, role: a.role, checked_in_at: a.checked_in_at, qr,
    event: publicEvent(e)
  });
});

/* ------------------------------------------------------------------ */
/* Organizer accounts                                                  */
/* ------------------------------------------------------------------ */
app.get('/api/org/config', (req, res) => res.json({ signup_code_required: cfg.signupCodeRequired }));

app.post('/api/org/signup', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 120), email = str(b.email, 200).toLowerCase(), password = String(b.password || '');
  if (cfg.signupCodeRequired) {
    if (sec.lock.isLocked('signup', req.ip, 8)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    if (!sec.safeEqual(b.code || '', cfg.SIGNUP_CODE)) {
      sec.lock.fail('signup', req.ip);
      return res.status(403).json({ error: 'That signup code is not valid.' });
    }
  }
  if (!name) return res.status(400).json({ error: 'Enter your organization name.' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM staff WHERE username=?').get(email)) return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
  if (db.prepare('SELECT 1 FROM orgs WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
  const r = db.prepare('INSERT INTO orgs (name,email,pass_hash) VALUES (?,?,?)').run(name, email, sec.hashPassword(password));
  sec.setSessionCookie(res, r.lastInsertRowid);
  res.json({ org: { id: r.lastInsertRowid, name, email } });
});

const DUMMY_HASH = sec.hashPassword('not-a-real-password');
app.post('/api/org/login', (req, res) => {
  if (sec.lock.isLocked('login', req.ip, 10)) return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
  const id = str((req.body || {}).email, 200).toLowerCase();
  const password = String((req.body || {}).password || '').slice(0, 200);
  const org = db.prepare('SELECT * FROM orgs WHERE email=?').get(id);
  const staff = org ? null : db.prepare('SELECT * FROM staff WHERE username=?').get(id);
  const hash = org ? org.pass_hash : staff ? staff.pass_hash : DUMMY_HASH;
  const ok = sec.verifyPassword(password, hash) && !!(org || staff);
  if (!ok) { sec.lock.fail('login', req.ip); return res.status(401).json({ error: 'Email or username, or password, is not right.' }); }
  sec.lock.clear('login', req.ip);
  if (org) {
    sec.setSessionCookie(res, org.id);
    return res.json({ org: { id: org.id, name: org.name, email: org.email }, role: 'owner' });
  }
  const o = db.prepare('SELECT id,name FROM orgs WHERE id=?').get(staff.org_id);
  db.prepare('UPDATE staff SET last_login_at=? WHERE id=?').run(new Date().toISOString(), staff.id);
  sec.setSessionCookie(res, staff.org_id, staff.id);
  res.json({ org: { id: o.id, name: o.name }, role: 'desk' });
});

app.post('/api/org/logout', (req, res) => { sec.clearSessionCookie(res); res.json({ ok: true }); });

/** Who is signed in: the company owner, or a front-desk login that belongs to that company. */
function resolveSession(req) {
  const d = sec.readSessionFull(sec.parseCookies(req.headers.cookie)[sec.COOKIE]);
  if (!d) return null;
  const org = db.prepare('SELECT id,name,email FROM orgs WHERE id=?').get(d.o);
  if (!org) return null;
  if (!d.s) return { org, role: 'owner', staff: null };
  const staff = db.prepare('SELECT id,name,username FROM staff WHERE id=? AND org_id=?').get(d.s, d.o);
  return staff ? { org, role: 'desk', staff } : null; // removing a desk login ends its sessions at once
}
function requireOrg(req, res, next) {
  const s = resolveSession(req);
  if (!s) return res.status(401).json({ error: 'Please sign in.' });
  req.org = s.org; req.role = s.role; req.staff = s.staff;
  next();
}
function requireOwner(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can do that.' });
  next();
}
const publicOrg = (req) => req.role === 'owner' ? req.org : { id: req.org.id, name: req.org.name };
function ownEvent(req, res, next) {
  const e = db.prepare('SELECT * FROM events WHERE id=? AND org_id=?').get(Number(req.params.id) || 0, req.org.id);
  if (!e) return res.status(404).json({ error: 'Event not found' });
  req.event = e;
  next();
}

app.get('/api/org/me', requireOrg, (req, res) => res.json({ org: publicOrg(req), role: req.role, staff_name: req.staff ? req.staff.name : null }));

/* ------------------------------------------------------------------ */
/* Front-desk logins (owner manages them)                              */
/* ------------------------------------------------------------------ */
const usernameOk = (u) => /^[a-z0-9][a-z0-9._@+-]{2,59}$/.test(u);
const nameTaken = (u) => !!(db.prepare('SELECT 1 FROM staff WHERE username=?').get(u) || db.prepare('SELECT 1 FROM orgs WHERE email=?').get(u));
app.get('/api/org/staff', requireOrg, requireOwner, (req, res) => {
  res.json(db.prepare('SELECT id,name,username,created_at,last_login_at FROM staff WHERE org_id=? ORDER BY name COLLATE NOCASE, id').all(req.org.id));
});
app.post('/api/org/staff', requireOrg, requireOwner, (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80), username = str(b.username, 60).toLowerCase(), password = String(b.password || '');
  if (!name) return res.status(400).json({ error: 'Enter a name, such as "Front desk 1".' });
  if (!usernameOk(username)) return res.status(400).json({ error: 'Choose a login of 3 to 60 characters: letters, numbers and . _ - @ +' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (nameTaken(username)) return res.status(409).json({ error: 'That login is already taken. Try another.' });
  if (db.prepare('SELECT COUNT(*) n FROM staff WHERE org_id=?').get(req.org.id).n >= 50) return res.status(400).json({ error: 'You can have up to 50 front-desk logins.' });
  const r = db.prepare('INSERT INTO staff (org_id,name,username,pass_hash) VALUES (?,?,?,?)').run(req.org.id, name, username, sec.hashPassword(password));
  res.json({ id: r.lastInsertRowid, name, username });
});
function ownStaff(req, res, next) {
  const m = db.prepare('SELECT * FROM staff WHERE id=? AND org_id=?').get(Number(req.params.sid) || 0, req.org.id);
  if (!m) return res.status(404).json({ error: 'Login not found' });
  req.member = m; next();
}
app.patch('/api/org/staff/:sid', requireOrg, requireOwner, ownStaff, (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) { const name = str(b.name, 80); if (!name) return res.status(400).json({ error: 'Enter a name.' }); db.prepare('UPDATE staff SET name=? WHERE id=?').run(name, req.member.id); }
  if (b.password !== undefined) {
    const p = String(b.password);
    if (p.length < 8 || p.length > 200) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
    db.prepare('UPDATE staff SET pass_hash=? WHERE id=?').run(sec.hashPassword(p), req.member.id);
  }
  res.json({ ok: true });
});
app.delete('/api/org/staff/:sid', requireOrg, requireOwner, ownStaff, (req, res) => {
  db.prepare('DELETE FROM staff WHERE id=?').run(req.member.id); res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Organizer: events                                                   */
/* ------------------------------------------------------------------ */
app.get('/api/org/events', requireOrg, (req, res) => {
  const rows = db.prepare('SELECT * FROM events WHERE org_id=? ORDER BY created_at DESC, id DESC').all(req.org.id);
  res.json(rows.map((e) => orgEvent(e, req.role)));
});

function readEventFields(b, base) {
  const out = { ...base };
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  if ('name' in b) { const n = str(b.name, 120); if (!n) return { error: 'Give the event a name.' }; set('name', n); }
  if ('tagline' in b) set('tagline', str(b.tagline, 160));
  if ('description' in b) set('description', str(b.description, 4000));
  if ('venue' in b) set('venue', str(b.venue, 200));
  if ('starts_at' in b) { const d = parseDate(b.starts_at); if (!d.ok) return { error: 'That date is not valid.' }; set('starts_at', d.value); }
  if ('ends_at' in b) { const d = parseDate(b.ends_at); if (!d.ok) return { error: 'That end time is not valid.' }; set('ends_at', d.value); }
  if (out.ends_at && (!out.starts_at || Date.parse(out.ends_at) <= Date.parse(out.starts_at))) return { error: 'The end time must be after the start time.' };
  if ('capacity' in b) {
    const c = Number(b.capacity || 0);
    if (!Number.isInteger(c) || c < 0 || c > 100000) return { error: 'Capacity must be a whole number (0 means no limit).' };
    set('capacity', c);
  }
  if (b.theme && typeof b.theme === 'object') {
    set('theme_bg', hex(b.theme.bg, out.theme_bg));
    set('theme_ink', hex(b.theme.ink, out.theme_ink));
    set('theme_accent', hex(b.theme.accent, out.theme_accent));
  }
  if ('registration_open' in b) set('registration_open', b.registration_open ? 1 : 0);
  if ('listed' in b) set('listed', b.listed ? 1 : 0);
  return { value: out };
}

app.post('/api/org/events', requireOrg, requireOwner, (req, res) => {
  const b = req.body || {};
  if (!str(b.name, 120)) return res.status(400).json({ error: 'Give the event a name.' });
  const base = { name: '', tagline: '', description: '', venue: '', starts_at: '', ends_at: '', capacity: 0,
    theme_bg: '#101614', theme_ink: '#f2f5f1', theme_accent: '#45bfb0', registration_open: 1, listed: 0 };
  const r = readEventFields(b, base);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.value;
  const slug = uniqueSlug(slugify(b.slug ? str(b.slug, 40) : v.name));
  const info = db.prepare(`INSERT INTO events
    (org_id,slug,name,tagline,description,venue,starts_at,ends_at,capacity,theme_bg,theme_ink,theme_accent,registration_open,listed,gate_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.org.id, slug, v.name, v.tagline, v.description, v.venue, v.starts_at, v.ends_at, v.capacity,
    v.theme_bg, v.theme_ink, v.theme_accent, v.registration_open, v.listed ? 1 : 0, sec.newGateKey());
  res.json(orgEvent(db.prepare('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid)));
});

app.get('/api/org/events/:id', requireOrg, ownEvent, (req, res) => res.json(orgEvent(req.event, req.role)));

app.patch('/api/org/events/:id', requireOrg, requireOwner, ownEvent, (req, res) => {
  const r = readEventFields(req.body || {}, req.event);
  if (r.error) return res.status(400).json({ error: r.error });
  const v = r.value;
  db.prepare(`UPDATE events SET name=?,tagline=?,description=?,venue=?,starts_at=?,ends_at=?,capacity=?,
    theme_bg=?,theme_ink=?,theme_accent=?,registration_open=?,listed=? WHERE id=?`).run(
    v.name, v.tagline, v.description, v.venue, v.starts_at, v.ends_at, v.capacity,
    v.theme_bg, v.theme_ink, v.theme_accent, v.registration_open, v.listed ? 1 : 0, req.event.id);
  res.json(orgEvent(db.prepare('SELECT * FROM events WHERE id=?').get(req.event.id)));
});

app.delete('/api/org/events/:id', requireOrg, requireOwner, ownEvent, (req, res) => {
  if (str((req.body || {}).confirm, 60) !== req.event.slug) return res.status(400).json({ error: 'Type the event link name to confirm deletion.' });
  removeFlyerFile(req.event.flyer);
  db.prepare('DELETE FROM events WHERE id=?').run(req.event.id);
  res.json({ ok: true });
});

app.post('/api/org/events/:id/flyer',
  requireOrg, requireOwner, ownEvent,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' }),
  (req, res) => {
    const buf = req.body;
    const ext = Buffer.isBuffer(buf) && buf.length ? sniffImage(buf) : null;
    if (!ext) return res.status(400).json({ error: 'Upload a JPG, PNG or WebP image up to 6 MB.' });
    const name = `${req.event.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(cfg.UPLOAD_DIR, name), buf);
    removeFlyerFile(req.event.flyer);
    db.prepare('UPDATE events SET flyer=? WHERE id=?').run(name, req.event.id);
    res.json({ flyer_url: '/uploads/' + name });
  });

app.delete('/api/org/events/:id/flyer', requireOrg, requireOwner, ownEvent, (req, res) => {
  removeFlyerFile(req.event.flyer);
  db.prepare("UPDATE events SET flyer='' WHERE id=?").run(req.event.id);
  res.json({ ok: true });
});

app.post('/api/org/events/:id/rotate-key', requireOrg, requireOwner, ownEvent, (req, res) => {
  const key = sec.newGateKey();
  db.prepare('UPDATE events SET gate_key=? WHERE id=?').run(key, req.event.id);
  res.json({ gate_key: key });
});

/* ------------------------------------------------------------------ */
/* Organizer: attendees and check-in                                   */
/* ------------------------------------------------------------------ */
app.get('/api/org/events/:id/stats', requireOrg, ownEvent, (req, res) => {
  const recent = db.prepare('SELECT name,organization,checked_in_at FROM attendees WHERE event_id=? AND checked_in_at IS NOT NULL ORDER BY checked_in_at DESC LIMIT 8').all(req.event.id);
  res.json({ ...counts(req.event.id), ...guestCounts(req.event.id), recent });
});

app.get('/api/org/events/:id/attendees', requireOrg, ownEvent, (req, res) => {
  const rows = db.prepare('SELECT * FROM attendees WHERE event_id=? ORDER BY created_at DESC, name').all(req.event.id);
  res.json(rows.map((a) => ({ ...a, token: sec.makeToken(a.id) })));
});

app.post('/api/org/events/:id/attendees', requireOrg, ownEvent, (req, res) => {
  const r = createAttendee(req.event, req.body || {}, { requireTerms: false });
  if (r.error) return res.status(r.status).json({ error: r.error });
  if ((req.body || {}).check_in && !r.existing) checkin(req.event, r.token);
  res.json({ id: r.id, token: r.token, existing: r.existing });
});

function ownAttendee(req, res, next) {
  const a = db.prepare('SELECT * FROM attendees WHERE id=? AND event_id=?').get(String(req.params.aid), req.event.id);
  if (!a) return res.status(404).json({ error: 'Attendee not found' });
  req.attendee = a;
  next();
}
app.post('/api/org/events/:id/attendees/:aid/checkin', requireOrg, ownEvent, ownAttendee, (req, res) => {
  res.json(checkin(req.event, sec.makeToken(req.attendee.id)));
});
app.delete('/api/org/events/:id/attendees/:aid/checkin', requireOrg, ownEvent, ownAttendee, (req, res) => {
  db.prepare('UPDATE attendees SET checked_in_at=NULL WHERE id=?').run(req.attendee.id);
  res.json({ ok: true });
});
app.delete('/api/org/events/:id/attendees/:aid', requireOrg, requireOwner, ownEvent, ownAttendee, (req, res) => {
  db.prepare('DELETE FROM attendees WHERE id=?').run(req.attendee.id);
  res.json({ ok: true });
});

app.get('/api/org/events/:id/export.csv', requireOrg, requireOwner, ownEvent, (req, res) => {
  const rows = db.prepare('SELECT * FROM attendees WHERE event_id=? ORDER BY name').all(req.event.id);
  const cols = ['id', 'name', 'email', 'phone', 'organization', 'role', 'interests', 'consent_community', 'consent_directory', 'created_at', 'checked_in_at'];
  // Guard against spreadsheet formula injection from attendee-supplied text.
  const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.event.slug}-attendees.csv"` });
  res.send(csv);
});

/* ------------------------------------------------------------------ */
/* Organizer: expected guest list (CSV upload)                         */
/* ------------------------------------------------------------------ */
app.get('/api/org/events/:id/guests', requireOrg, ownEvent, (req, res) => {
  res.json(guestList(req.event.id).map((g) => ({ ...g, token: g.attendee_id ? sec.makeToken(g.attendee_id) : null })));
});

app.post('/api/org/events/:id/guests/import',
  express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
  requireOrg, requireOwner, ownEvent, (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) return res.status(400).json({ error: 'That file is empty. Choose a CSV with a column of names.' });
    const { guests, invalid, hasHeader } = parseGuests(req.body, { emailOk, str });
    if (!guests.length) return res.status(400).json({ error: 'No names found. The first row should be headings such as Name, Email, Organization.', invalid });
    const existing = db.prepare('SELECT name,email FROM guests WHERE event_id=?').all(req.event.id);
    const nk = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const seenEmail = new Set(existing.filter((g) => g.email).map((g) => g.email));
    const seenName = new Set(existing.filter((g) => !g.email).map((g) => nk(g.name)));
    const ins = db.prepare('INSERT INTO guests (event_id,name,email,phone,organization,role) VALUES (?,?,?,?,?,?)');
    let added = 0, duplicates = 0;
    db.transaction(() => {
      for (const g of guests) {
        if (g.email ? seenEmail.has(g.email) : seenName.has(nk(g.name))) { duplicates++; continue; }
        if (g.email) seenEmail.add(g.email); else seenName.add(nk(g.name));
        ins.run(req.event.id, g.name, g.email, g.phone, g.organization, g.role); added++;
      }
    })();
    res.json({ added, duplicates, invalid, has_header: hasHeader, total: db.prepare('SELECT COUNT(*) n FROM guests WHERE event_id=?').get(req.event.id).n });
  });

function ownGuest(req, res, next) {
  const g = db.prepare('SELECT * FROM guests WHERE id=? AND event_id=?').get(Number(req.params.gid), req.event.id);
  if (!g) return res.status(404).json({ error: 'Guest not found' });
  req.guest = g; next();
}
app.delete('/api/org/events/:id/guests/:gid', requireOrg, requireOwner, ownEvent, ownGuest, (req, res) => {
  db.prepare('DELETE FROM guests WHERE id=?').run(req.guest.id); res.json({ ok: true });
});
app.delete('/api/org/events/:id/guests', requireOrg, requireOwner, ownEvent, (req, res) => {
  const r = db.prepare('DELETE FROM guests WHERE event_id=?').run(req.event.id); res.json({ removed: r.changes });
});
/** Turn an expected guest into a registration (and optionally check them in). Needs an email, which can be supplied here. */
app.post('/api/org/events/:id/guests/:gid/register', requireOrg, ownEvent, ownGuest, (req, res) => {
  const b = req.body || {};
  const email = str(b.email, 200).toLowerCase() || req.guest.email;
  if (!emailOk(email)) return res.status(400).json({ error: 'Add an email address to register this guest.' });
  const r = createAttendee(req.event, { name: req.guest.name, email, phone: req.guest.phone, organization: req.guest.organization, role: req.guest.role }, { requireTerms: false });
  if (r.error) return res.status(r.status).json({ error: r.error });
  db.prepare('UPDATE guests SET email=? WHERE id=?').run(email, req.guest.id);
  if (b.check_in) checkin(req.event, r.token);
  res.json({ id: r.id, token: r.token, existing: r.existing });
});
app.get('/api/org/events/:id/guests.csv', requireOrg, requireOwner, ownEvent, (req, res) => {
  const rows = guestList(req.event.id);
  const cols = ['name', 'email', 'phone', 'organization', 'role', 'status', 'checked_in_at'];
  const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.event.slug}-guest-list.csv"` });
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});

/* ------------------------------------------------------------------ */
/* Organizer: post-event report (owner only)                           */
/* ------------------------------------------------------------------ */
function buildReport(event, tz) {
  const attendees = db.prepare('SELECT id,name,organization,role,interests,consent_community,consent_directory,created_at,checked_in_at FROM attendees WHERE event_id=?').all(event.id);
  return report.summarize({ event, attendees, guests: guestList(event.id), tz: report.safeZone(str(tz, 60) || 'UTC') });
}
app.get('/api/org/events/:id/report', requireOrg, requireOwner, ownEvent, (req, res) => {
  res.json({ ...buildReport(req.event, req.query.tz), mail_enabled: mail.configured(), email: req.org.email });
});
app.get('/api/org/events/:id/report.html', requireOrg, requireOwner, ownEvent, (req, res) => {
  const html = report.renderHtml(buildReport(req.event, req.query.tz), { orgName: req.org.name });
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (req.query.download) h['Content-Disposition'] = `attachment; filename="${req.event.slug}-report.html"`;
  res.set(h).send(html);
});
const mailSent = new Map(); // event id -> recent send times (in memory, per server)
app.post('/api/org/events/:id/report/email', requireOrg, requireOwner, ownEvent, async (req, res) => {
  if (!mail.configured()) return res.status(503).json({ error: 'Email is not set up on this server yet. Download the report instead, or ask whoever runs the server to set SMTP_URL.' });
  const now = Date.now(), recent = (mailSent.get(req.event.id) || []).filter((t) => now - t < 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: 'You have sent this report several times in the last hour. Try again later.' });
  const tz = (req.body || {}).tz;
  const s = buildReport(req.event, tz);
  const link = `${req.protocol}://${req.get('host')}/dashboard/events/${req.event.id}`;
  const { html, text } = report.renderEmail(s, { link });
  try {
    await mail.send({
      to: req.org.email, // always the owner's own address, never one typed into the request
      subject: `${req.event.name}: event report`, text, html,
      attachments: [{ filename: `${req.event.slug}-report.html`, content: report.renderHtml(s, { orgName: req.org.name }), contentType: 'text/html; charset=utf-8' }]
    });
  } catch (e) {
    console.error('Report email failed:', e.message);
    return res.status(502).json({ error: 'The email could not be sent. Check the mail settings on the server, or download the report instead.' });
  }
  recent.push(now); mailSent.set(req.event.id, recent);
  res.json({ sent_to: req.org.email });
});

/* ------------------------------------------------------------------ */
/* Other upcoming events on bọyọ, shown to people who have registered   */
/* ------------------------------------------------------------------ */
/** Events that organizers chose to list, still open and in the future. Leaves out the one just joined and any the person already registered for. */
function upcomingFor(excludeEventId, email, limit = 6) {
  const rows = db.prepare("SELECT * FROM events WHERE listed=1 AND registration_open=1 AND starts_at!='' AND starts_at>? AND id!=? ORDER BY starts_at ASC, id ASC LIMIT 80")
    .all(new Date().toISOString(), excludeEventId);
  const has = db.prepare('SELECT 1 FROM attendees WHERE event_id=? AND email=?');
  const out = [];
  for (const e of rows) {
    const n = counts(e.id).registered;
    if (e.capacity > 0 && n >= e.capacity) continue;
    if (email && has.get(e.id, email)) continue;
    const org = db.prepare('SELECT name FROM orgs WHERE id=?').get(e.org_id);
    out.push({
      slug: e.slug, name: e.name, tagline: e.tagline, org_name: org ? org.name : '', starts_at: e.starts_at, venue: e.venue,
      flyer_url: e.flyer ? '/uploads/' + e.flyer : null, theme: { bg: e.theme_bg, accent: e.theme_accent },
      spots_left: e.capacity > 0 ? e.capacity - n : null
    });
    if (out.length >= limit) break;
  }
  return out;
}
app.get('/api/ticket/:token/upcoming', (req, res) => {
  const id = sec.verifyToken(String(req.params.token || ''));
  const a = id && db.prepare('SELECT id,event_id,email FROM attendees WHERE id=?').get(id);
  if (!a) return res.status(404).json({ error: 'Ticket not found' });
  res.set('Cache-Control', 'no-store').json(upcomingFor(a.event_id, a.email));
});

/* ------------------------------------------------------------------ */
/* Calendars: .ics files, Google Calendar for organizers and attendees */
/* ------------------------------------------------------------------ */
const siteBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const redirectUri = (req) => siteBase(req) + '/api/google/callback';
const icsHeaders = (slug) => ({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}.ics"`, 'Cache-Control': 'no-store' });

app.get('/api/e/:slug/calendar.ics', findEventBySlug, (req, res) => {
  const ics = cal.buildIcs(req.event, { url: `${siteBase(req)}/e/${req.event.slug}` });
  if (!ics) return res.status(404).json({ error: 'This event has no date yet.' });
  res.set(icsHeaders(req.event.slug)).send(ics);
});
app.get('/api/ticket/:token/calendar.ics', (req, res) => {
  const id = sec.verifyToken(String(req.params.token || ''));
  const a = id && db.prepare('SELECT * FROM attendees WHERE id=?').get(id);
  if (!a) return res.status(404).json({ error: 'Ticket not found' });
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
  const ics = cal.buildIcs(e, { url: `${siteBase(req)}/e/${e.slug}`, uidKey: a.id });
  if (!ics) return res.status(404).json({ error: 'This event has no date yet.' });
  res.set(icsHeaders(e.slug)).send(ics);
});

const safeReturn = (p, fallback) => (/^\/dashboard(\/[a-z0-9/_-]*)?$/i.test(String(p || '')) ? p : fallback);
const orgGoogleReady = (req, res) => { if (!google.enabled()) { res.status(503).json({ error: 'Google Calendar is not set up on this server yet.' }); return false; } return true; };

app.get('/api/org/google/status', requireOrg, requireOwner, (req, res) => {
  const o = db.prepare('SELECT google_refresh, google_email FROM orgs WHERE id=?').get(req.org.id);
  res.json({ enabled: google.enabled(), connected: !!o.google_refresh, email: o.google_email || '' });
});
app.get('/api/org/google/connect', requireOrg, requireOwner, (req, res) => {
  if (!google.enabled()) return res.redirect(safeReturn(req.query.return, '/dashboard') + '?google=unavailable');
  const state = google.signState({ t: 'org', o: req.org.id, r: safeReturn(req.query.return, '/dashboard') });
  res.redirect(google.authUrl({ redirectUri: redirectUri(req), scope: google.SCOPE_ORG, state, offline: true }));
});
app.delete('/api/org/google', requireOrg, requireOwner, async (req, res) => {
  const o = db.prepare('SELECT google_refresh FROM orgs WHERE id=?').get(req.org.id);
  const t = o.google_refresh && google.unseal(o.google_refresh);
  db.prepare("UPDATE orgs SET google_refresh='', google_email='' WHERE id=?").run(req.org.id);
  if (t) await google.revoke(t);
  res.json({ ok: true });
});
app.get('/api/org/google/events', requireOrg, requireOwner, async (req, res) => {
  if (!orgGoogleReady(req, res)) return;
  const o = db.prepare('SELECT google_refresh FROM orgs WHERE id=?').get(req.org.id);
  const rt = o.google_refresh && google.unseal(o.google_refresh);
  if (!rt) return res.status(409).json({ error: 'Connect your Google Calendar first.', code: 'not_connected' });
  try {
    const tok = await google.refreshAccess(rt);
    res.json(await google.listUpcoming(tok.access_token));
  } catch (e) {
    if (e.google === 'invalid_grant') { db.prepare("UPDATE orgs SET google_refresh='', google_email='' WHERE id=?").run(req.org.id); return res.status(409).json({ error: 'Google access was withdrawn. Connect your calendar again.', code: 'not_connected' }); }
    console.error('Google Calendar list failed:', e.message);
    res.status(502).json({ error: 'Could not read your Google Calendar. Try again in a moment.' });
  }
});

/** Attendee: add this event to my Google Calendar (one consent screen, nothing stored afterwards). */
app.get('/api/google/attendee/start', (req, res) => {
  const token = String(req.query.token || '');
  const id = sec.verifyToken(token);
  const a = id && db.prepare('SELECT * FROM attendees WHERE id=?').get(id);
  if (!a) return res.redirect('/');
  if (!google.attendeeEnabled()) return res.redirect(`/t/${encodeURIComponent(token)}?calendar=unavailable`);
  const state = google.signState({ t: 'att', a: a.id });
  res.redirect(google.authUrl({ redirectUri: redirectUri(req), scope: google.SCOPE_ATTENDEE, state, offline: false }));
});

app.get('/api/google/callback', async (req, res) => {
  const st = google.readState(req.query.state);
  if (!st) return res.status(400).send('This sign-in link has expired. Go back and try again.');
  const done = (p) => res.redirect(p);
  if (st.t === 'org') {
    const back = safeReturn(st.r, '/dashboard');
    const sess = resolveSession(req);
    if (!sess || sess.role !== 'owner' || sess.org.id !== st.o) return done('/login');
    if (req.query.error || !req.query.code) return done(back + '?google=declined');
    try {
      const tok = await google.exchangeCode(String(req.query.code), redirectUri(req));
      if (!tok.refresh_token) return done(back + '?google=failed');
      const email = await google.userEmail(tok.access_token);
      db.prepare('UPDATE orgs SET google_refresh=?, google_email=? WHERE id=?').run(google.seal(tok.refresh_token), email, st.o);
      return done(back + '?google=connected');
    } catch (e) { console.error('Google connect failed:', e.message); return done(back + '?google=failed'); }
  }
  const a = db.prepare('SELECT * FROM attendees WHERE id=?').get(String(st.a || ''));
  if (!a) return done('/');
  const ticket = `/t/${encodeURIComponent(sec.makeToken(a.id))}`;
  if (req.query.error || !req.query.code) return done(ticket + '?calendar=declined');
  try {
    const e = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
    const sp = cal.span(e);
    if (!sp) return done(ticket + '?calendar=failed');
    const tok = await google.exchangeCode(String(req.query.code), redirectUri(req));
    const url = `${siteBase(req)}/e/${e.slug}`;
    const r = await google.addEvent(tok.access_token, {
      id: 'ev' + a.id.toLowerCase().replace(/[^0-9a-v]/g, ''), summary: e.name, location: e.venue,
      description: [e.tagline, e.description, `Your ticket: ${siteBase(req)}${ticket}`].filter(Boolean).join('\n\n'),
      startIso: new Date(sp.start).toISOString(), endIso: new Date(sp.end).toISOString(), url
    });
    return done(ticket + '?calendar=' + r);
  } catch (e) { console.error('Google add-to-calendar failed:', e.message); return done(ticket + '?calendar=failed'); }
});

/* ------------------------------------------------------------------ */
/* Gate scanner API (per event, protected by the event's gate key)     */
/* ------------------------------------------------------------------ */
function gateAuth(req, res, next) {
  const e = db.prepare('SELECT * FROM events WHERE slug=?').get(String(req.params.slug || '').toLowerCase());
  if (!e) return res.status(404).json({ error: 'Event not found' });
  const sess = resolveSession(req);
  if (sess && sess.org.id === e.org_id) { req.event = e; return next(); } // the owner and front-desk logins can scan without the key
  if (sec.lock.isLocked('gate', req.ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
  if (!sec.safeEqual(req.get('x-gate-key') || '', e.gate_key)) {
    sec.lock.fail('gate', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.event = e;
  next();
}

app.get('/api/gate/:slug/manifest', gateAuth, (req, res) => {
  const rows = db.prepare('SELECT id,name,organization,role,email,phone,checked_in_at FROM attendees WHERE event_id=? ORDER BY name').all(req.event.id)
    .map((r) => ({ ...r, token: sec.makeToken(r.id) })); // lets the scanner verify tickets offline
  res.json({ generated_at: new Date().toISOString(), event: publicEvent(req.event), attendees: rows });
});
app.post('/api/gate/:slug/checkin', gateAuth, (req, res) => res.json(checkin(req.event, (req.body || {}).token)));
app.post('/api/gate/:slug/sync', gateAuth, (req, res) => {
  const scans = Array.isArray((req.body || {}).scans) ? req.body.scans.slice(0, 500) : [];
  res.json({ results: scans.map((s) => ({ token: s.token, ...checkin(req.event, s.token, s.scannedAt) })) });
});

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get('/', page('index.html'));
app.get(['/login', '/signup'], page('auth.html'));
app.get('/dashboard', page('dashboard.html'));
app.get(['/dashboard/events/new', '/dashboard/events/:id'], page('manage.html'));
app.get('/e/:slug/community', page('community.html'));
app.get('/t/:token', page('ticket.html'));
app.get('/scan/:slug', page('scan.html'));

// Event page: inject share-preview tags so links look right in WhatsApp, X, LinkedIn.
app.get('/e/:slug', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE slug=?').get(String(req.params.slug || '').toLowerCase());
  let html = fs.readFileSync(path.join(PUBLIC, 'event.html'), 'utf8');
  let meta = '';
  if (e) {
    const base = `${req.protocol}://${req.get('host')}`;
    const desc = e.tagline || e.description.slice(0, 160) || 'Register for this event.';
    meta = [
      `<title>${htmlEsc(e.name)}</title>`,
      `<meta property="og:site_name" content="bọyọ">`,
      `<meta property="og:title" content="${htmlEsc(e.name)}">`,
      `<meta property="og:description" content="${htmlEsc(desc)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${htmlEsc(base + '/e/' + e.slug)}">`,
      `<meta property="og:image" content="${htmlEsc(base + (e.flyer ? '/uploads/' + e.flyer : '/brand/og.png'))}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="theme-color" content="${htmlEsc(e.theme_bg)}">`
    ].join('\n');
  }
  res.status(e ? 200 : 404).type('html').send(html.replace('<!--OG-->', meta));
});

app.use('/uploads', express.static(cfg.UPLOAD_DIR, { maxAge: '7d', index: false, dotfiles: 'deny' }));
app.get('/vendor/jsqr.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
app.use('/fonts', express.static(path.join(PUBLIC, 'fonts'), { maxAge: '365d', immutable: true }));
app.use('/brand', express.static(path.join(PUBLIC, 'brand'), { maxAge: '7d' }));
app.use(express.static(PUBLIC, { extensions: [] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (6 MB max).' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`bọyọ running on http://localhost:${PORT}`));
}
module.exports = { app };
