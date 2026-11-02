/* Google sign-in and Calendar, using plain HTTPS calls (no extra packages).
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. The redirect address to register in Google Cloud is
 *   <your site address>/api/google/callback
 * Organizer sign-in reads their calendar (to pick an event date). Attendee sign-in adds one event to their own calendar. */
const crypto = require('crypto');
const cfg = require('./config');

const SCOPE_ORG = 'openid email https://www.googleapis.com/auth/calendar.readonly';
const SCOPE_ATTENDEE = 'https://www.googleapis.com/auth/calendar.events';

let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f || ((...a) => fetch(...a)); }
let override = null;
function setCredentials(c) { override = c; } // tests

const creds = () => override || { id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '' };
const enabled = () => { const c = creds(); return !!(c.id && c.secret); };
/** One-tap add for attendees can be switched off on its own (GOOGLE_ATTENDEE_ADD=false), for example while the app is not yet verified by Google. */
const attendeeEnabled = () => enabled() && process.env.GOOGLE_ATTENDEE_ADD !== 'false';

/* ---- signed state (survives the round trip to Google; cannot be forged or reused after 10 minutes) ---- */
const b64 = (b) => Buffer.from(b).toString('base64url');
function signState(obj) {
  const body = b64(JSON.stringify({ ...obj, n: crypto.randomBytes(6).toString('hex'), x: Date.now() + 10 * 60000 }));
  return body + '.' + crypto.createHmac('sha256', cfg.SESSION_KEY).update('g:' + body).digest('base64url');
}
function readState(s) {
  const [body, sig] = String(s || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', cfg.SESSION_KEY).update('g:' + body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch (_) { return null; }
}

/* ---- keep the organizer's refresh token encrypted at rest ---- */
const KEY = crypto.createHmac('sha256', cfg.SECRET).update('google-token-v1').digest();
function seal(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((x) => x.toString('base64url')).join('.');
}
function unseal(s) {
  try {
    const [iv, tag, enc] = String(s).split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

function authUrl({ redirectUri, scope, state, offline }) {
  const q = new URLSearchParams({ client_id: creds().id, redirect_uri: redirectUri, response_type: 'code', scope, state, include_granted_scopes: 'true' });
  if (offline) { q.set('access_type', 'offline'); q.set('prompt', 'consent'); } else q.set('prompt', 'select_account');
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

async function post(url, params) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || 'Google refused the request'); e.google = j.error || ''; e.status = r.status; throw e; }
  return j;
}
const exchangeCode = (code, redirectUri) => post('https://oauth2.googleapis.com/token', { code, client_id: creds().id, client_secret: creds().secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
const refreshAccess = (refreshToken) => post('https://oauth2.googleapis.com/token', { refresh_token: refreshToken, client_id: creds().id, client_secret: creds().secret, grant_type: 'refresh_token' });
async function revoke(token) { try { await post('https://oauth2.googleapis.com/revoke', { token }); } catch (_) {} }

async function api(method, url, accessToken, body) {
  const r = await fetchImpl(url, { method, headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'Google Calendar request failed'); e.status = r.status; throw e; }
  return j;
}
async function userEmail(accessToken) {
  try { return (await api('GET', 'https://openidconnect.googleapis.com/v1/userinfo', accessToken)).email || ''; } catch (_) { return ''; }
}

/** Upcoming events on the organizer's main calendar, in a shape the event form can use. */
async function listUpcoming(accessToken) {
  const q = new URLSearchParams({ timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 365 * 86400e3).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', fields: 'items(id,status,summary,description,location,start,end)' });
  const j = await api('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + q.toString(), accessToken);
  return (j.items || []).filter((i) => i.status !== 'cancelled' && i.start).map((i) => ({
    id: i.id, title: String(i.summary || '(No title)').slice(0, 200), location: String(i.location || '').slice(0, 200), description: String(i.description || '').slice(0, 1000),
    all_day: !i.start.dateTime, start: i.start.dateTime || i.start.date, end: (i.end && (i.end.dateTime || i.end.date)) || ''
  }));
}

/** Add the event to the signed-in person's own calendar. Using a fixed id means a second try cannot create a duplicate. */
async function addEvent(accessToken, { id, summary, location, description, startIso, endIso, url }) {
  const body = {
    id, summary, location, description, start: { dateTime: startIso }, end: { dateTime: endIso },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] }, source: url ? { title: 'bọyọ', url } : undefined
  };
  try { await api('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', accessToken, body); return 'added'; }
  catch (e) { if (e.status === 409) return 'already'; throw e; }
}

module.exports = { enabled, attendeeEnabled, setFetch, setCredentials, SCOPE_ORG, SCOPE_ATTENDEE, signState, readState, seal, unseal, authUrl, exchangeCode, refreshAccess, revoke, userEmail, listUpcoming, addEvent };
