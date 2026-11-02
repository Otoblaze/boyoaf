/* Shared helpers for every page. */
(function (w) {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  async function api(path, opts) {
    opts = opts || {};
    var o = { credentials: 'same-origin', method: opts.method || 'GET', headers: Object.assign({}, opts.headers || {}) };
    if (opts.body !== undefined) {
      if (typeof Blob !== 'undefined' && opts.body instanceof Blob) o.body = opts.body;
      else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
    }
    var res = await fetch(path, o), data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { var e = new Error((data && data.error) || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }

  /* ---- color helpers ---- */
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function toHex(r, g, b) { return '#' + [r, g, b].map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join(''); }
  function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function luminance(hex) { var c = rgb(hex); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function readable(hex) { return luminance(hex) > 0.4 ? '#000000' : '#ffffff'; }       // text color for a given background
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return toHex(x[0] * (1 - t) + y[0] * t, x[1] * (1 - t) + y[1] * t, x[2] * (1 - t) + y[2] * t); }

  function contrast(a, b) { var x = luminance(a) + 0.05, y = luminance(b) + 0.05; return x > y ? x / y : y / x; }
  /** Link color: the accent, pulled toward the text color until it reads on the background (4.5:1). */
  function linkColor(accent, bg, ink) {
    var c = accent;
    for (var t = 0.1; t <= 1 && contrast(c, bg) < 4.5; t += 0.1) c = mix(accent, ink, t);
    return c;
  }

  /** Apply an event theme {bg, ink, accent} as CSS variables on an element (default: the whole page). */
  function applyTheme(t, el) {
    el = el || document.documentElement;
    var bg = t.bg, ink = t.ink, accent = t.accent, s = el.style;
    s.setProperty('--bg', bg); s.setProperty('--ink', ink);
    s.setProperty('--surface', mix(bg, ink, 0.07));
    s.setProperty('--soft', mix(bg, ink, 0.12));
    s.setProperty('--line', mix(bg, ink, 0.2));
    s.setProperty('--muted', mix(ink, bg, 0.38));
    s.setProperty('--accent', accent); s.setProperty('--link', linkColor(accent, bg, ink)); s.setProperty('--accent-ink', readable(accent));
    if (el === document.documentElement) { el.setAttribute('data-fixed', ''); el.style.colorScheme = luminance(bg) > 0.4 ? 'light' : 'dark'; }
  }

  /** Pick background, text and accent colors from an <img> (used when an organizer uploads a flyer). */
  function extractPalette(img) {
    var S = 56, c = document.createElement('canvas'); c.width = S; c.height = S;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, S, S);
    var d = x.getImageData(0, 0, S, S).data, buckets = {};
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      var k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
      var b = buckets[k] || (buckets[k] = { n: 0, r: 0, g: 0, b: 0 });
      b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    }
    var list = Object.keys(buckets).map(function (k) {
      var b = buckets[k], r = b.r / b.n, g = b.g / b.n, bl = b.b / b.n, mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      return { n: b.n, r: r, g: g, b: bl, sat: mx ? (mx - mn) / mx : 0, val: mx / 255 };
    }).sort(function (a, b) { return b.n - a.n; });
    if (!list.length) return { bg: '#101614', ink: '#f2f5f1', accent: '#45bfb0' };
    var bgc = list[0], bg = toHex(bgc.r, bgc.g, bgc.b);
    var best = null, bestScore = 0;
    list.forEach(function (c2) {
      var dist = Math.abs(c2.r - bgc.r) + Math.abs(c2.g - bgc.g) + Math.abs(c2.b - bgc.b);
      if (c2.sat < 0.35 || c2.val < 0.4 || dist < 150) return;
      var score = c2.n * c2.sat * c2.sat;
      if (score > bestScore) { bestScore = score; best = c2; }
    });
    var ink = luminance(bg) > 0.4 ? '#111111' : '#ffffff';
    var accent = best ? toHex(best.r, best.g, best.b) : (luminance(bg) > 0.4 ? '#0b6b63' : '#45bfb0');
    return { bg: bg, ink: ink, accent: accent };
  }

  /** Plain "add to Google Calendar" link. Works for anyone, with no sign-in. Returns '' when the event has no date. */
  function gcalLink(ev, pageUrl) {
    var s = Date.parse(ev.starts_at || ''); if (!isFinite(s)) return '';
    var e = Date.parse(ev.ends_at || ''); if (!isFinite(e) || e <= s) e = s + 2 * 3600e3;
    var f = function (ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var q = new URLSearchParams({ action: 'TEMPLATE', text: ev.name, dates: f(s) + '/' + f(e), location: ev.venue || '', details: [ev.tagline, pageUrl ? 'Event page: ' + pageUrl : ''].filter(Boolean).join('\n\n') });
    return 'https://calendar.google.com/calendar/render?' + q.toString();
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }); } catch (_) { return ''; }
  }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function copyText(text, done, fail) {
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail && fail(); }
  }
  /** Two-step button: first click arms it, second click within 3s runs fn. */
  function armed(btn, armedLabel, fn) {
    var label = btn.textContent, on = false, t;
    btn.addEventListener('click', function () {
      if (!on) { on = true; btn.textContent = armedLabel; t = setTimeout(function () { on = false; btn.textContent = label; }, 3000); return; }
      clearTimeout(t); on = false; btn.textContent = label; fn();
    });
  }

  w.BY = { esc: esc, api: api, readable: readable, mix: mix, luminance: luminance, applyTheme: applyTheme,
    extractPalette: extractPalette, gcalLink: gcalLink, fmtDateTime: fmtDateTime, fmtTime: fmtTime, copyText: copyText, armed: armed };
})(window);
