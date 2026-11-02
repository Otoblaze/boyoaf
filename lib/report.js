/* Builds the "how did your event go" report from plain rows. No database access here. */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);

function safeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (_) { return 'UTC'; }
}
function parts(iso, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute) };
}
const fmtTime = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const fmtDay = (ymd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ymd + 'T12:00:00Z'));
const fmtLong = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(iso));

function top(list, n) {
  const m = new Map();
  for (const raw of list) { const k = String(raw || '').trim(); if (!k) continue; const key = k.toLowerCase(); const e = m.get(key) || { label: k, n: 0 }; e.n++; m.set(key, e); }
  return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, n);
}

/**
 * event: {name, venue, starts_at, capacity}; attendees: rows from the attendees table; guests: guestList() rows.
 * Returns plain numbers and series that the HTML and email builders render.
 */
function summarize({ event, attendees, guests = [], tz }) {
  tz = safeZone(tz || 'UTC');
  const n = attendees.length;
  const inn = attendees.filter((a) => a.checked_in_at);
  const c = inn.length;
  const out = { tz, event: { name: event.name, venue: event.venue || '', starts_at: event.starts_at || '', capacity: event.capacity || 0 } };
  out.registered = n; out.checked_in = c; out.no_shows = n - c; out.turnout = pct(c, n);
  out.capacity_fill = event.capacity > 0 ? pct(n, event.capacity) : null;

  // Registrations per day
  const byDay = new Map();
  for (const a of attendees) { const d = parts(a.created_at.replace(' ', 'T') + (a.created_at.includes('Z') ? '' : 'Z'), tz).date; byDay.set(d, (byDay.get(d) || 0) + 1); }
  out.registrations_by_day = [...byDay.entries()].sort().map(([date, count]) => ({ date, label: fmtDay(date), count }));
  const peakReg = [...out.registrations_by_day].sort((a, b) => b.count - a.count)[0];
  out.peak_registration_day = peakReg || null;

  // Arrivals
  const times = inn.map((a) => new Date(a.checked_in_at).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  out.first_arrival = times.length ? fmtTime(new Date(times[0]).toISOString(), tz) : null;
  out.last_arrival = times.length ? fmtTime(new Date(times[times.length - 1]).toISOString(), tz) : null;
  out.arrivals = [];
  out.bucket_minutes = 0;
  if (times.length) {
    const span = (times[times.length - 1] - times[0]) / 60000;
    const step = span <= 240 ? 15 : span <= 720 ? 30 : 60;
    out.bucket_minutes = step;
    const buckets = new Map();
    for (const t of times) { const k = Math.floor(t / (step * 60000)) * step * 60000; buckets.set(k, (buckets.get(k) || 0) + 1); }
    const first = Math.min(...buckets.keys()), last = Math.max(...buckets.keys());
    for (let k = first; k <= last; k += step * 60000) {
      out.arrivals.push({ label: fmtTime(new Date(k).toISOString(), tz), count: buckets.get(k) || 0 });
    }
    const pk = [...out.arrivals].sort((a, b) => b.count - a.count)[0];
    out.peak_arrival = { label: pk.label, count: pk.count, minutes: step };
    // Arrival against the start time
    const start = Date.parse(event.starts_at || '');
    if (Number.isFinite(start)) {
      out.vs_start = {
        before: times.filter((t) => t <= start).length,
        within30: times.filter((t) => t > start && t <= start + 30 * 60000).length,
        later: times.filter((t) => t > start + 30 * 60000).length
      };
    }
  } else out.peak_arrival = null;

  // Community
  out.opt_updates = attendees.filter((a) => a.consent_community).length;
  out.opt_directory = attendees.filter((a) => a.consent_directory).length;

  // Who came
  out.top_organizations = top(inn.map((a) => a.organization), 8);
  out.top_roles = top(inn.map((a) => a.role), 8);
  out.top_interests = top(attendees.flatMap((a) => String(a.interests || '').split(/[,;\n]/)), 10);

  // Expected guests
  if (guests.length) {
    const arrived = guests.filter((g) => g.status === 'checked_in');
    const matched = new Set(guests.filter((g) => g.attendee_id).map((g) => g.attendee_id));
    out.expected = {
      total: guests.length,
      registered: guests.filter((g) => g.status !== 'not_registered').length,
      arrived: arrived.length,
      missing: guests.length - arrived.length,
      missing_list: guests.filter((g) => g.status !== 'checked_in').slice(0, 200).map((g) => ({ name: g.name, organization: g.organization || '', status: g.status })),
      unlisted_arrivals: inn.filter((a) => !matched.has(a.id)).length
    };
  } else out.expected = null;
  return out;
}

let LOGO = '';
try { LOGO = fs.readFileSync(path.join(__dirname, '..', 'public', 'brand', 'logo.svg'), 'utf8').replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/#1b1a17/g, 'currentColor'); } catch (_) {}

function headline(s) {
  const bits = [`${s.checked_in} of ${s.registered} registered people came (${s.turnout}%)`];
  if (s.peak_arrival) bits.push(`the busiest ${s.peak_arrival.minutes} minutes were from ${s.peak_arrival.label}, with ${s.peak_arrival.count} arrivals`);
  return bits.join('; ') + '.';
}

function barSvg(rows, { color = '#e8590c', h = 180 } = {}) {
  if (!rows.length) return '';
  const w = Math.max(320, rows.length * 34), max = Math.max(...rows.map((r) => r.count), 1), bw = w / rows.length;
  const step = Math.ceil(rows.length / 12);
  const bars = rows.map((r, i) => {
    const bh = Math.max(r.count ? 2 : 0, Math.round(((h - 40) * r.count) / max)), bwid = Math.min(bw * 0.76, 44), x = i * bw + (bw - bwid) / 2;
    return `<rect x="${x.toFixed(1)}" y="${h - 22 - bh}" width="${bwid.toFixed(1)}" height="${bh}" rx="3" fill="${color}"/>` +
      (r.count ? `<text x="${(x + bwid / 2).toFixed(1)}" y="${h - 26 - bh}" text-anchor="middle" font-size="11" fill="currentColor">${r.count}</text>` : '') +
      (i % step === 0 ? `<text x="${(x + bwid / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".7">${esc(r.label)}</text>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart" style="width:100%;height:auto;max-height:240px">${bars}<line x1="0" x2="${w}" y1="${h - 22}" y2="${h - 22}" stroke="currentColor" opacity=".25"/></svg>`;
}
function listRows(rows, total) {
  if (!rows.length) return '<p class="muted">Nothing recorded.</p>';
  const max = Math.max(...rows.map((r) => r.n), 1);
  return '<div class="rank">' + rows.map((r) => `<div class="rk"><span>${esc(r.label)}</span><span class="rkb"><i style="width:${Math.round((100 * r.n) / max)}%"></i></span><b>${r.n}</b></div>`).join('') + '</div>';
}

/** A standalone page: opens anywhere, prints cleanly to PDF. */
function renderHtml(s, { generatedAt = new Date(), orgName = '' } = {}) {
  const tile = (n, l) => `<div class="tile"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
  const when = s.event.starts_at ? fmtLong(s.event.starts_at, s.tz) : '';
  const exp = s.expected;
  const sections = [];
  sections.push(`<section><h2>At a glance</h2><div class="tiles">${[
    tile(s.registered, 'Registered'), tile(s.checked_in, 'Checked in'), tile(s.turnout + '%', 'Turnout'), tile(s.no_shows, 'Did not come'),
    s.capacity_fill != null ? tile(s.capacity_fill + '%', `Of ${s.event.capacity} places filled`) : '',
    s.first_arrival ? tile(s.first_arrival, 'First arrival') : '', s.last_arrival ? tile(s.last_arrival, 'Last arrival') : ''
  ].join('')}</div><p class="lead">${esc(headline(s))}</p></section>`);
  if (s.arrivals.length) {
    let vs = '';
    if (s.vs_start) vs = `<p>Against the start time: <b>${s.vs_start.before}</b> arrived before it, <b>${s.vs_start.within30}</b> within 30 minutes after, and <b>${s.vs_start.later}</b> later.</p>`;
    sections.push(`<section><h2>Arrivals through the day</h2><p class="muted">People checked in per ${s.bucket_minutes} minutes (${esc(s.tz)} time).</p>${barSvg(s.arrivals)}${vs}</section>`);
  }
  if (s.registrations_by_day.length === 1) {
    sections.push(`<section><h2>When people registered</h2><p>All ${s.registrations_by_day[0].count} registrations came on <b>${esc(s.registrations_by_day[0].label)}</b>.</p></section>`);
  } else if (s.registrations_by_day.length) {
    sections.push(`<section><h2>When people registered</h2>${barSvg(s.registrations_by_day, { color: '#1b1a17' })}${s.peak_registration_day ? `<p>Busiest day: <b>${esc(s.peak_registration_day.label)}</b> with ${s.peak_registration_day.count} registrations.</p>` : ''}</section>`);
  }
  if (exp) {
    sections.push(`<section><h2>Expected guests</h2><div class="tiles">${tile(exp.total, 'On your guest list')}${tile(exp.registered, 'Registered')}${tile(exp.arrived, 'Came')}${tile(exp.missing, 'Did not come')}${tile(exp.unlisted_arrivals, 'Came but were not listed')}</div>` +
      (exp.missing_list.length ? `<h3>Expected but not checked in</h3><table><thead><tr><th>Name</th><th>Organization</th><th>Status</th></tr></thead><tbody>${exp.missing_list.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.organization)}</td><td>${m.status === 'registered' ? 'Registered, did not come' : 'Never registered'}</td></tr>`).join('')}</tbody></table>${exp.missing > exp.missing_list.length ? `<p class="muted">Showing the first ${exp.missing_list.length}. Download the guest list for everyone.</p>` : ''}` : '<p>Everyone on the list came.</p>') + '</section>');
  }
  sections.push(`<section class="two"><div><h2>Who came</h2><h3>Organizations</h3>${listRows(s.top_organizations)}</div><div><h2>&nbsp;</h2><h3>Roles</h3>${listRows(s.top_roles)}</div></section>`);
  if (s.top_interests.length) sections.push(`<section><h2>What people are interested in</h2>${listRows(s.top_interests)}</section>`);
  sections.push(`<section><h2>Your community</h2><div class="tiles">${tile(s.opt_updates, 'Want updates (' + pct(s.opt_updates, s.registered) + '%)')}${tile(s.opt_directory, 'Joined the attendee directory (' + pct(s.opt_directory, s.registered) + '%)')}</div><p class="muted">Only people who ticked these boxes should be contacted or listed. The full attendee list is in your attendee export.</p></section>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(s.event.name)}: event report</title><style>
:root{--bg:#f4efe6;--card:#fbf8f2;--ink:#1b1a17;--muted:#6a655a;--line:#ddd5c4;--accent:#e8590c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Bricolage","Segoe UI",system-ui,-apple-system,Arial,sans-serif;padding:24px 16px 48px}
.page{max-width:820px;margin:0 auto;display:grid;gap:16px}header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.logo{height:26px;width:auto;aspect-ratio:925.75/283.75;color:var(--ink)}h1{margin:6px 0 2px;font-size:2rem;line-height:1.1;letter-spacing:-.03em}h2{margin:0 0 6px;font-size:1.2rem;letter-spacing:-.02em}h3{margin:14px 0 6px;font-size:1rem}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;break-inside:avoid}.muted{color:var(--muted)}.lead{font-size:1.05rem;margin:12px 0 0}p{margin:6px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.tile{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.tile b{display:block;font-size:1.7rem;line-height:1.1;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:.82rem}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.rank{display:grid;gap:6px}.rk{display:grid;grid-template-columns:minmax(80px,1.2fr) 2fr auto;gap:10px;align-items:center;font-size:.9rem}.rkb{height:8px;background:var(--bg);border-radius:9px;overflow:hidden;border:1px solid var(--line)}.rkb i{display:block;height:100%;background:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--line)}th{font-size:.78rem;color:var(--muted);border-top:0}
footer{color:var(--muted);font-size:.82rem;text-align:center}@media print{body{background:#fff;padding:0}section{border-color:#ccc}.tile{background:#fff}}
</style></head><body><div class="page"><header class="top"><div><p class="muted" style="margin:0">Event report${orgName ? ' · ' + esc(orgName) : ''}</p><h1>${esc(s.event.name)}</h1><p class="muted" style="margin:0">${esc([when, s.event.venue].filter(Boolean).join(' · '))}</p></div><svg class="logo" viewBox="0 0 925.75 283.75" role="img" aria-label="bọyọ">${LOGO}</svg></header>
${sections.join('\n')}
<footer>Made by bọyọ on ${esc(new Intl.DateTimeFormat('en-GB', { timeZone: s.tz, dateStyle: 'long', timeStyle: 'short', hourCycle: 'h23' }).format(generatedAt))} (${esc(s.tz)}). Counts reflect check-ins recorded at the gate, including any scans synced later.</footer></div></body></html>`;
}

/** Short email body (tables and inline styles only, because email apps strip most CSS). */
function renderEmail(s, { link = '' } = {}) {
  const cell = (n, l) => `<td style="padding:10px 14px;border:1px solid #ddd5c4;border-radius:8px;background:#fbf8f2"><div style="font-size:24px;font-weight:700">${esc(n)}</div><div style="font-size:12px;color:#6a655a">${esc(l)}</div></td><td width="8"></td>`;
  const max = Math.max(...s.arrivals.map((a) => a.count), 1);
  const bars = s.arrivals.slice(0, 40).map((a) => `<tr><td style="font-size:12px;color:#6a655a;padding:1px 8px 1px 0;white-space:nowrap">${esc(a.label)}</td><td style="width:100%"><div style="background:#e8590c;height:10px;border-radius:5px;width:${Math.max(a.count ? 2 : 0, Math.round((100 * a.count) / max))}%"></div></td><td style="font-size:12px;padding-left:8px">${a.count}</td></tr>`).join('');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1b1a17;max-width:560px"><h2 style="margin:0 0 4px">${esc(s.event.name)}: how it went</h2><p style="color:#6a655a;margin:0 0 14px">${esc(headline(s))}</p>
<table cellspacing="0" cellpadding="0"><tr>${cell(s.registered, 'Registered')}${cell(s.checked_in, 'Checked in')}${cell(s.turnout + '%', 'Turnout')}${cell(s.no_shows, 'Did not come')}</tr></table>
${s.expected ? `<p style="margin:14px 0 0"><b>Guest list:</b> ${s.expected.arrived} of ${s.expected.total} expected guests came; ${s.expected.unlisted_arrivals} came who were not listed.</p>` : ''}
${bars ? `<h3 style="margin:18px 0 6px">Arrivals (per ${s.bucket_minutes} minutes)</h3><table cellspacing="0" cellpadding="0" width="100%">${bars}</table>` : ''}
<p style="margin:18px 0 0">The full report is attached. Open it in a browser, and print it to save as PDF.${link ? ` You can also open it from your dashboard: <a href="${esc(link)}">${esc(link)}</a>` : ''}</p></div>`;
  const text = `${s.event.name}: how it went\n\n${headline(s)}\n\nRegistered ${s.registered}, checked in ${s.checked_in}, turnout ${s.turnout}%, did not come ${s.no_shows}.\n` +
    (s.expected ? `Guest list: ${s.expected.arrived} of ${s.expected.total} expected guests came.\n` : '') + '\nThe full report is attached.';
  return { html, text };
}

module.exports = { summarize, renderHtml, renderEmail, safeZone, headline };
