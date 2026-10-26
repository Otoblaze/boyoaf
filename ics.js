/* Calendar helpers: an .ics file (Apple, Outlook, Google import) and a Google Calendar "add event" link. */
const crypto = require('crypto');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };

/** Start and end in milliseconds. An event with no end time is given 2 hours. Returns null when there is no start date. */
function span(event) {
  const s = Date.parse(event.starts_at || '');
  if (!Number.isFinite(s)) return null;
  let e = Date.parse(event.ends_at || '');
  if (!Number.isFinite(e) || e <= s) e = s + 2 * 3600e3;
  return { start: s, end: e };
}

const icsText = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
function fold(line) {
  // Lines are limited to 75 octets; continuation lines start with a space.
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs(event, { url = '', uidKey = '' } = {}) {
  const sp = span(event);
  if (!sp) return null;
  const uid = crypto.createHash('sha1').update(`${event.slug}|${uidKey}`).digest('hex') + '@boyo';
  const desc = [event.tagline, event.description, url ? `Event page: ${url}` : ''].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//boyo//events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(sp.start)}`, `DTEND:${stamp(sp.end)}`,
    `SUMMARY:${icsText(event.name)}`,
    event.venue ? `LOCATION:${icsText(event.venue)}` : null,
    desc ? `DESCRIPTION:${icsText(desc)}` : null,
    url ? `URL:${url}` : null,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(event.name + ' starts in 1 hour')}`, 'TRIGGER:-PT1H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

function googleLink(event, url = '') {
  const sp = span(event);
  if (!sp) return '';
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: event.name, dates: `${stamp(sp.start)}/${stamp(sp.end)}`,
    details: [event.tagline, event.description, url ? `Event page: ${url}` : ''].filter(Boolean).join('\n\n'), location: event.venue || ''
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

module.exports = { span, buildIcs, googleLink, stamp };
