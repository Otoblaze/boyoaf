// End-to-end API tests. Run with: npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boyo-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.TICKET_SECRET = 'test-secret-test-secret-test-secret';
delete process.env.NODE_ENV;

const { app } = require('./server');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, p, { cookie, body, headers = {}, raw, ip } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (ip) h['X-Forwarded-For'] = ip;
    let payload;
    if (raw) payload = raw;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text, headers: res.headers };
  }
  const cookieOf = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');

  // ---------- organizer accounts ----------
  let r = await call('POST', '/api/org/signup', { body: { name: 'Org A', email: 'a@example.com', password: 'short' } });
  assert.strictEqual(r.status, 400); ok('signup rejects a short password');

  r = await call('POST', '/api/org/signup', { body: { name: 'Org A', email: 'a@example.com', password: 'password-a-1' } });
  assert.strictEqual(r.status, 200);
  const A = cookieOf(r);
  assert.ok(A.startsWith('sid='));
  r = await call('POST', '/api/org/signup', { body: { name: 'Org B', email: 'b@example.com', password: 'password-b-1' } });
  const B = cookieOf(r);
  ok('two organizations can sign up');

  r = await call('POST', '/api/org/signup', { body: { name: 'Dup', email: 'A@example.com', password: 'password-a-1' } });
  assert.strictEqual(r.status, 409); ok('duplicate organizer email is rejected');

  r = await call('POST', '/api/org/login', { body: { email: 'a@example.com', password: 'wrong-password' }, ip: '10.9.9.1' });
  assert.strictEqual(r.status, 401);
  r = await call('POST', '/api/org/login', { body: { email: 'a@example.com', password: 'password-a-1' } });
  assert.strictEqual(r.status, 200); ok('login works and a wrong password is refused');

  assert.strictEqual((await call('GET', '/api/org/events')).status, 401); ok('organizer API needs a session');

  // ---------- events ----------
  r = await call('POST', '/api/org/events', { cookie: A, body: { name: "Tech Ignite '26", tagline: 'Beyond the Hype', capacity: 3, theme: { bg: '#000000', ink: '#ffffff', accent: '#ffd62e' } } });
  assert.strictEqual(r.status, 200);
  const evA = r.json;
  assert.strictEqual(evA.slug, 'tech-ignite-26');
  assert.ok(evA.gate_key && evA.gate_key.length >= 8);
  r = await call('POST', '/api/org/events', { cookie: B, body: { name: "Tech Ignite '26" } });
  const evB = r.json;
  assert.notStrictEqual(evB.slug, evA.slug); ok('event links are unique across organizations');

  r = await call('PATCH', `/api/org/events/${evA.id}`, { cookie: A, body: { theme: { bg: 'red; background:url(x)', ink: '#fff', accent: '#ffd62e' } } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.theme.bg, '#000000'); ok('invalid theme colors are ignored, not stored');

  // ---------- tenant isolation ----------
  for (const [m, p] of [['GET', `/api/org/events/${evA.id}`], ['PATCH', `/api/org/events/${evA.id}`], ['GET', `/api/org/events/${evA.id}/attendees`],
    ['GET', `/api/org/events/${evA.id}/export.csv`], ['POST', `/api/org/events/${evA.id}/rotate-key`], ['GET', `/api/org/events/${evA.id}/stats`]]) {
    const x = await call(m, p, { cookie: B, body: m === 'PATCH' ? { name: 'hacked' } : undefined });
    assert.strictEqual(x.status, 404, `${m} ${p} should be 404 for another organization`);
  }
  r = await call('DELETE', `/api/org/events/${evA.id}`, { cookie: B, body: { confirm: evA.slug } });
  assert.strictEqual(r.status, 404);
  ok("another organization cannot read, edit, export or delete an event");
  assert.strictEqual((await call('GET', '/api/org/events', { cookie: B })).json.length, 1); ok('each organizer only lists their own events');

  // ---------- flyer upload ----------
  const up = (cookie, id, buf, type) => call('POST', `/api/org/events/${id}/flyer`, { cookie, raw: buf, headers: { 'Content-Type': type } });
  assert.strictEqual((await up(A, evA.id, Buffer.from('<script>alert(1)</script>'.repeat(5)), 'image/png')).status, 400);
  assert.strictEqual((await up(A, evA.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml')).status, 400);
  assert.strictEqual((await up(B, evA.id, PNG, 'image/png')).status, 404);
  ok('flyer upload rejects non-images, SVG, and other organizations');
  r = await up(A, evA.id, Buffer.concat([PNG, Buffer.alloc(50)]), 'image/png');
  assert.strictEqual(r.status, 200);
  assert.ok(/^\/uploads\/\d+-[a-f0-9]+\.png$/.test(r.json.flyer_url));
  const img = await fetch(base + r.json.flyer_url);
  assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff'); ok('a real flyer uploads and is served as an image');
  const big = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]);
  assert.strictEqual((await up(A, evA.id, big, 'image/png')).status, 413); ok('oversized flyer is rejected');

  // ---------- public page ----------
  r = await call('GET', `/e/${evA.slug}`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('property="og:image"') && r.text.includes(evA.slug === 'x' ? '' : '/uploads/'));
  assert.ok(r.text.includes("Tech Ignite &#39;26")); ok('event page carries share-preview tags with the name escaped');
  assert.strictEqual((await call('GET', '/e/nope-nope')).status, 404);

  // ---------- registration ----------
  const reg = (slug, b) => call('POST', `/api/e/${slug}/register`, { body: { consent_terms: true, ...b } });
  assert.strictEqual((await call('POST', `/api/e/${evA.slug}/register`, { body: { name: 'X', email: 'x@example.com' } })).status, 400); ok('registration needs consent');
  r = await reg(evA.slug, { name: 'Ada Obi', email: 'ADA@example.com', organization: '=HYPERLINK("http://evil")', consent_directory: true });
  assert.strictEqual(r.status, 200); assert.ok(r.json.token);
  const ada = r.json;
  r = await reg(evA.slug, { name: 'Impostor', email: 'ada@example.com' });
  assert.strictEqual(r.json.existing, true);
  assert.strictEqual(r.json.token, undefined); ok("registering again with someone's email does NOT reveal their ticket");
  const bayo = (await reg(evA.slug, { name: 'Bayo', email: 'bayo@example.com' })).json;
  await reg(evA.slug, { name: 'Chi', email: 'chi@example.com' });
  r = await reg(evA.slug, { name: 'Late', email: 'late@example.com' });
  assert.strictEqual(r.status, 409); ok('capacity is enforced');

  r = await call('GET', `/api/ticket/${ada.token}`);
  assert.ok(r.json.qr.startsWith('data:image/png') && r.json.event.slug === evA.slug);
  assert.strictEqual((await call('GET', `/api/ticket/${ada.id}.AAAAAAAAAAAAAAAA`)).status, 404); ok('tickets load; forged tickets do not');

  await call('PATCH', `/api/org/events/${evA.id}`, { cookie: A, body: { registration_open: false } });
  assert.strictEqual((await reg(evA.slug, { name: 'Z', email: 'z@example.com' })).status, 403); ok('closed registration is refused');

  const evB2 = (await reg(evB.slug, { name: 'Bee', email: 'bee@example.com' })).json;

  // ---------- gate ----------
  const gate = (slug, p, o = {}) => call(o.method || 'GET', `/api/gate/${slug}${p}`, o);
  assert.strictEqual((await gate(evA.slug, '/manifest')).status, 401);
  assert.strictEqual((await gate(evA.slug, '/manifest', { headers: { 'x-gate-key': evB.gate_key } })).status, 401); ok("another event's gate key does not open this gate");
  const KA = { 'x-gate-key': evA.gate_key };
  r = await gate(evA.slug, '/manifest', { headers: KA });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.attendees.length, 3);
  assert.ok(r.json.attendees.every((a) => a.token)); ok('gate key loads the attendee list');
  assert.strictEqual((await gate(evA.slug, '/manifest', { cookie: A })).status, 200); ok('the owning organizer can open the gate without the key');
  assert.strictEqual((await gate(evA.slug, '/manifest', { cookie: B })).status, 401);

  r = await gate(evA.slug, '/checkin', { method: 'POST', headers: KA, body: { token: ada.token } });
  assert.strictEqual(r.json.status, 'ok');
  r = await gate(evA.slug, '/checkin', { method: 'POST', headers: KA, body: { token: ada.token } });
  assert.strictEqual(r.json.status, 'duplicate'); ok('check-in works and a second scan is flagged');
  r = await gate(evA.slug, '/checkin', { method: 'POST', headers: KA, body: { token: evB2.token } });
  assert.strictEqual(r.json.status, 'wrong_event'); ok("a ticket for another event is refused at this gate");
  r = await gate(evA.slug, '/checkin', { method: 'POST', headers: KA, body: { token: ada.id + '.AAAAAAAAAAAAAAAA' } });
  assert.strictEqual(r.json.status, 'invalid');

  r = await gate(evA.slug, '/sync', { method: 'POST', headers: KA, body: { scans: [
    { token: bayo.token, scannedAt: '2999-01-01T00:00:00Z' }, { token: 'garbage' }, { token: evB2.token }] } });
  assert.deepStrictEqual(r.json.results.map((x) => x.status), ['ok', 'invalid', 'wrong_event']);
  const bayoRow = (await call('GET', `/api/org/events/${evA.id}/attendees`, { cookie: A })).json.find((a) => a.id === bayo.id);
  assert.ok(Date.parse(bayoRow.checked_in_at) <= Date.now() + 1000); ok('offline sync works and a future timestamp is clamped');

  // ---------- organizer tools ----------
  r = await call('GET', `/api/org/events/${evA.id}/stats`, { cookie: A });
  assert.deepStrictEqual([r.json.registered, r.json.checked_in], [3, 2]);
  r = await call('DELETE', `/api/org/events/${evA.id}/attendees/${bayo.id}/checkin`, { cookie: A });
  assert.strictEqual((await call('GET', `/api/org/events/${evA.id}/stats`, { cookie: A })).json.checked_in, 1); ok('organizer can undo a check-in');

  r = await call('GET', `/api/org/events/${evA.id}/export.csv`, { cookie: A });
  assert.ok(r.text.includes('Ada Obi') && r.text.includes(`"'=HYPERLINK`)); ok('CSV export neutralizes spreadsheet formulas');

  const dir = (await call('GET', `/api/e/${evA.slug}/community`)).json;
  assert.deepStrictEqual(dir.map((d) => d.name), ['Ada Obi']); assert.strictEqual(dir[0].email, undefined); ok('directory lists only opted-in people, without emails');

  const oldKey = evA.gate_key;
  const rot = (await call('POST', `/api/org/events/${evA.id}/rotate-key`, { cookie: A })).json.gate_key;
  assert.notStrictEqual(rot, oldKey);
  assert.strictEqual((await gate(evA.slug, '/manifest', { headers: KA })).status, 401); ok('changing the gate key locks out the old key');

  // ---------- lockout ----------
  for (let i = 0; i < 15; i++) await gate(evA.slug, '/manifest', { headers: { 'x-gate-key': 'wrong' }, ip: '10.7.7.7' });
  assert.strictEqual((await gate(evA.slug, '/manifest', { headers: { 'x-gate-key': rot }, ip: '10.7.7.7' })).status, 429); ok('repeated wrong gate keys lock that IP out, even for the right key');

  // ---------- delete ----------
  assert.strictEqual((await call('DELETE', `/api/org/events/${evA.id}`, { cookie: A, body: { confirm: 'nope' } })).status, 400);
  assert.strictEqual((await call('DELETE', `/api/org/events/${evA.id}`, { cookie: A, body: { confirm: evA.slug } })).status, 200);
  assert.strictEqual((await call('GET', `/api/e/${evA.slug}`)).status, 404);
  assert.strictEqual((await call('GET', '/api/org/events', { cookie: A })).json.length, 0);
  ok('deleting an event needs its name typed and removes it');

  // ---------- production guard ----------
  const guard = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, NODE_ENV: 'production', TICKET_SECRET: '', SIGNUP_CODE: '', ALLOW_PUBLIC_SIGNUP: '' }, encoding: 'utf8' });
  assert.strictEqual(guard.status, 1); assert.ok(/TICKET_SECRET/.test(guard.stderr) && /SIGNUP_CODE/.test(guard.stderr));
  ok('production refuses to start without a real secret and a signup policy');

  // ---------- expected guest list (CSV) ----------
  const csvUp = (cookie, id, text, type = 'text/csv') => call('POST', `/api/org/events/${id}/guests/import`, { cookie, raw: text, headers: { 'Content-Type': type } });
  const csv1 = '\uFEFFName,E-mail,Company,Title\r\n' +
    'Bee Okon,BEE@example.com,"Acme, Ltd",Lead\r\n' +
    '"Efe ""E"" Udo",efe@example.com,Uyo Tech,Speaker\r\n' +
    'Efe Duplicate,efe@example.com,,\r\n' +
    '=cmd|\'/c calc\'!A1,evil@example.com,,\r\n' +
    'Bad Email,not-an-email,,\r\n' +
    ',,,\r\n' +
    'No Email Person,,Hub,\r\n';
  r = await csvUp(B, evB.id, csv1);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.added, 4); assert.strictEqual(r.json.duplicates, 1); assert.strictEqual(r.json.invalid.length, 1);
  ok('CSV import reads quotes, a BOM and CRLF, skips duplicates and bad emails, and reports them');
  r = await csvUp(B, evB.id, 'Name,Email\nBee Again,bee@example.com\nNo  email   person,\nNew One,new@example.com');
  assert.strictEqual(r.json.added, 1); assert.strictEqual(r.json.duplicates, 2);
  ok('uploading again does not double up guests (matched by email, or by name when there is no email)');
  r = await csvUp(B, evB.id, 'Zed Name\nYa Name\n', 'text/plain');
  assert.strictEqual(r.json.added, 2); assert.strictEqual(r.json.has_header, false);
  ok('a plain column of names works without headings');
  assert.strictEqual((await csvUp(B, evB.id, '   ')).status, 400);
  assert.strictEqual((await csvUp(B, evB.id, 'Email\nfoo@example.com\n')).json.added, 1);
  assert.strictEqual((await call('POST', `/api/org/events/${evB.id}/guests/import`, { cookie: B, body: { name: 'x' } })).status, 400);
  assert.strictEqual((await csvUp(B, evB.id, 'x'.repeat(1100000))).status, 413);
  ok('empty, JSON and oversized uploads are refused');
  assert.strictEqual((await csvUp(A, evB.id, 'Name\nIntruder')).status, 404);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/guests`, { cookie: A })).status, 404);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/guests.csv`, { cookie: A })).status, 404);
  assert.strictEqual((await call('DELETE', `/api/org/events/${evB.id}/guests`, { cookie: A })).status, 404);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/guests`)).status, 401);
  ok("another organization cannot read or change this event's guest list");
  let st, gl = (await call('GET', `/api/org/events/${evB.id}/guests`, { cookie: B })).json;
  const gBee = gl.find((g) => g.email === 'bee@example.com'), gEfe = gl.find((g) => g.email === 'efe@example.com'), gNo = gl.find((g) => g.name === 'No Email Person');
  assert.strictEqual(gBee.status, 'registered'); assert.ok(gBee.token);
  assert.strictEqual(gEfe.status, 'not_registered'); assert.strictEqual(gNo.status, 'not_registered');
  assert.strictEqual(gBee.organization, 'Acme, Ltd');
  ok('a guest shows as registered when someone registers with the same email');
  assert.strictEqual((await reg(evB.slug, { name: 'Efe E Udo', email: 'Efe@Example.com' })).status, 200);
  await reg(evB.slug, { name: 'no email person', email: 'nep@example.com' });
  gl = (await call('GET', `/api/org/events/${evB.id}/guests`, { cookie: B })).json;
  assert.strictEqual(gl.find((g) => g.email === 'efe@example.com').status, 'registered');
  assert.strictEqual(gl.find((g) => g.name === 'No Email Person').status, 'registered');
  ok('registration links to the list by email, or by exact name when the guest has no email');
  r = await call('POST', `/api/org/events/${evB.id}/guests/${gl.find((g) => g.name === 'Zed Name').id}/register`, { cookie: B, body: {} });
  assert.strictEqual(r.status, 400);
  r = await call('POST', `/api/org/events/${evB.id}/guests/${gl.find((g) => g.name === 'Zed Name').id}/register`, { cookie: B, body: { email: 'zed@example.com', check_in: true } });
  assert.strictEqual(r.status, 200);
  gl = (await call('GET', `/api/org/events/${evB.id}/guests`, { cookie: B })).json;
  assert.strictEqual(gl.find((g) => g.name === 'Zed Name').status, 'checked_in');
  st = (await call('GET', `/api/org/events/${evB.id}/stats`, { cookie: B })).json;
  assert.ok(st.expected >= 6 && st.expected_arrived === 1);
  ok('an expected guest can be registered and checked in from the list (email required)');
  assert.ok(!JSON.stringify((await call('GET', `/api/e/${evB.slug}`)).json).includes('expected'));
  r = await call('GET', `/api/org/events/${evB.id}/guests.csv`, { cookie: B });
  assert.ok(r.text.includes('"\'=cmd') && r.text.split('\n')[0].includes('status'));
  ok('guest list export neutralizes spreadsheet formulas and the public page does not expose the list');
  const gid = gl.find((g) => g.name === 'Ya Name').id;
  assert.strictEqual((await call('DELETE', `/api/org/events/${evB.id}/guests/${gid}`, { cookie: B })).status, 200);
  assert.strictEqual((await call('DELETE', `/api/org/events/${evA.id}/guests/${gid}`, { cookie: A })).status, 404);
  const before = (await call('GET', `/api/org/events/${evB.id}/attendees`, { cookie: B })).json.length;
  r = await call('DELETE', `/api/org/events/${evB.id}/guests`, { cookie: B });
  assert.ok(r.json.removed >= 5);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/attendees`, { cookie: B })).json.length, before);
  ok('guests can be removed one by one or cleared without touching registrations');

  // ---------- front-desk logins ----------
  const mk = (cookie, body) => call('POST', '/api/org/staff', { cookie, body });
  assert.strictEqual((await mk(B, { name: 'Desk 1', username: 'x', password: 'desk-pass-1' })).status, 400);
  assert.strictEqual((await mk(B, { name: 'Desk 1', username: 'desk1', password: 'short' })).status, 400);
  assert.strictEqual((await mk(B, { name: '', username: 'desk1', password: 'desk-pass-1' })).status, 400);
  assert.strictEqual((await mk(B, { name: 'Desk', username: 'b@example.com', password: 'desk-pass-1' })).status, 409);
  for (let i = 1; i <= 4; i++) assert.strictEqual((await mk(B, { name: 'Desk ' + i, username: 'Desk' + i + '.B', password: 'desk-pass-' + i })).status, 200);
  assert.strictEqual((await mk(A, { name: 'Other', username: 'desk1.b', password: 'desk-pass-9' })).status, 409);
  ok('the owner can create several front-desk logins; bad or duplicate logins are refused');
  const list = (await call('GET', '/api/org/staff', { cookie: B })).json;
  assert.strictEqual(list.length, 4); assert.ok(!JSON.stringify(list).includes('pass'));
  assert.strictEqual((await call('GET', '/api/org/staff', { cookie: A })).json.length, 0);
  ok('each company sees only its own logins, and password hashes are never returned');

  const desks = [];
  for (let i = 1; i <= 4; i++) {
    const lr = await call('POST', '/api/org/login', { body: { email: 'DESK' + i + '.b', password: 'desk-pass-' + i } });
    assert.strictEqual(lr.status, 200); assert.strictEqual(lr.json.role, 'desk'); desks.push(cookieOf(lr));
  }
  assert.strictEqual((await call('POST', '/api/org/login', { body: { email: 'desk1.b', password: 'wrong-wrong' }, ip: '10.8.8.8' })).status, 401);
  for (const d of desks) assert.strictEqual((await call('GET', '/api/org/me', { cookie: d })).json.role, 'desk');
  ok('four front-desk staff can be signed in at the same time, each with their own login');

  const D = desks[0];
  let evs = (await call('GET', '/api/org/events', { cookie: D })).json;
  assert.ok(evs.some((e) => e.id === evB.id)); assert.ok(evs.every((e) => !('gate_key' in e)));
  assert.ok(!('gate_key' in (await call('GET', `/api/org/events/${evB.id}`, { cookie: D })).json));
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}`, { cookie: B })).json.gate_key, evB.gate_key);
  ok('desk logins see the company events but never the gate key');

  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/stats`, { cookie: D })).status, 200);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/attendees`, { cookie: D })).status, 200);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/guests`, { cookie: D })).status, 200);
  r = await call('POST', `/api/org/events/${evB.id}/attendees`, { cookie: D, body: { name: 'Walk In', email: 'walkin@example.com', check_in: true } });
  assert.strictEqual(r.status, 200);
  const walk = (await call('GET', `/api/org/events/${evB.id}/attendees`, { cookie: D })).json.find((a) => a.email === 'walkin@example.com');
  assert.ok(walk.checked_in_at);
  assert.strictEqual((await call('DELETE', `/api/org/events/${evB.id}/attendees/${walk.id}/checkin`, { cookie: D })).status, 200);
  assert.strictEqual((await call('POST', `/api/org/events/${evB.id}/attendees/${walk.id}/checkin`, { cookie: desks[1] })).status, 200);
  ok('desk staff can look people up, add walk-ins and check people in or undo');

  const forbidden = [
    ['POST', '/api/org/events', { name: 'Sneaky' }], ['PATCH', `/api/org/events/${evB.id}`, { name: 'Renamed' }], ['DELETE', `/api/org/events/${evB.id}`, { confirm: evB.slug }],
    ['POST', `/api/org/events/${evB.id}/rotate-key`], ['DELETE', `/api/org/events/${evB.id}/flyer`], ['GET', `/api/org/events/${evB.id}/export.csv`],
    ['DELETE', `/api/org/events/${evB.id}/attendees/${walk.id}`], ['DELETE', `/api/org/events/${evB.id}/guests`], ['GET', `/api/org/events/${evB.id}/guests.csv`],
    ['GET', '/api/org/staff'], ['POST', '/api/org/staff', { name: 'Me', username: 'mine.b', password: 'desk-pass-x' }], ['DELETE', `/api/org/staff/${list[1].id}`], ['PATCH', `/api/org/staff/${list[1].id}`, { password: 'new-pass-123' }]
  ];
  for (const [m, p, body] of forbidden) assert.strictEqual((await call(m, p, { cookie: D, body })).status, 403, m + ' ' + p);
  assert.strictEqual((await csvUp(D, evB.id, 'Name\nSneaky')).status, 403);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}`, { cookie: B })).json.name, evB.name);
  ok('desk staff cannot edit or delete events, see or change the key, export data, remove people or manage logins');

  const evA2 = (await call('POST', '/api/org/events', { cookie: A, body: { name: 'Org A Second Event' } })).json;
  assert.strictEqual((await call('GET', `/api/org/events/${evA2.id}`, { cookie: D })).status, 404);
  assert.strictEqual((await call('GET', `/api/org/events/${evA2.id}/attendees`, { cookie: D })).status, 404);
  assert.strictEqual((await call('POST', `/api/org/events/${evA2.id}/attendees`, { cookie: D, body: { name: 'X', email: 'x@y.com' } })).status, 404);
  assert.strictEqual((await call('GET', `/api/org/events/${evA2.id}/guests`, { cookie: D })).status, 404);
  assert.strictEqual((await call('GET', `/api/gate/${evA2.slug}/manifest`, { cookie: D })).status, 401);
  ok("a desk login can only reach its own company's events");

  r = await call('GET', `/api/gate/${evB.slug}/manifest`, { cookie: D });
  assert.strictEqual(r.status, 200); assert.ok(r.json.attendees.length > 0);
  r = await call('POST', `/api/gate/${evB.slug}/checkin`, { cookie: D, body: { token: evB2.token } });
  assert.strictEqual(r.status, 200);
  ok('desk staff can open and use the gate scanner without the gate key');

  assert.strictEqual((await call('PATCH', `/api/org/staff/${list[0].id}`, { cookie: B, body: { password: 'brand-new-pass' } })).status, 200);
  assert.strictEqual((await call('POST', '/api/org/login', { body: { email: 'desk1.b', password: 'desk-pass-1' }, ip: '10.8.8.9' })).status, 401);
  assert.strictEqual((await call('POST', '/api/org/login', { body: { email: 'desk1.b', password: 'brand-new-pass' } })).status, 200);
  ok('the owner can reset a desk password');

  assert.strictEqual((await call('DELETE', `/api/org/staff/${list[1].id}`, { cookie: A })).status, 404);
  assert.strictEqual((await call('DELETE', `/api/org/staff/${list[1].id}`, { cookie: B })).status, 200);
  assert.strictEqual((await call('GET', '/api/org/me', { cookie: desks[1] })).status, 401);
  assert.strictEqual((await call('GET', `/api/org/events/${evB.id}/attendees`, { cookie: desks[1] })).status, 401);
  assert.strictEqual((await call('GET', '/api/org/me', { cookie: desks[2] })).status, 200);
  ok('removing a desk login signs that person out immediately and leaves the others working');

  // ---------- event report ----------
  const R = `/api/org/events/${evB.id}`;
  r = await call('GET', `${R}/report?tz=Africa/Lagos`, { cookie: B });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.registered >= 3 && r.json.checked_in >= 1 && r.json.turnout >= 0 && r.json.tz === 'Africa/Lagos');
  assert.strictEqual(r.json.checked_in + r.json.no_shows, r.json.registered);
  assert.ok(Array.isArray(r.json.arrivals) && r.json.arrivals.length >= 1 && r.json.email === 'b@example.com' && r.json.mail_enabled === false);
  assert.strictEqual((await call('GET', `${R}/report?tz=Not/AZone`, { cookie: B })).json.tz, 'UTC');
  ok('report numbers add up, use the requested time zone and fall back to UTC for a bad one');
  await reg(evB.slug, { name: '<img src=x onerror=alert(1)>', email: 'xss@example.com', organization: '<script>boom()</script>', interests: 'AI, <b>design</b>', consent_community: true });
  await call('POST', `${R}/attendees`, { cookie: B, body: { name: 'Late Comer', email: 'late2@example.com', check_in: true } });
  r = await call('GET', `${R}/report.html?tz=Africa/Lagos`, { cookie: B });
  assert.strictEqual(r.status, 200); assert.ok(/text\/html/.test(r.headers.get('content-type')));
  assert.ok(r.text.includes(evB.name.replace("'", '&#39;')) && r.text.includes('Arrivals through the day') && r.text.includes('bọyọ'));
  assert.ok(!r.text.includes('<script>boom') && !r.text.includes('<img src=x'));
  assert.ok(!/content-disposition/i.test([...r.headers.keys()].join()));
  r = await call('GET', `${R}/report.html?download=1`, { cookie: B });
  assert.ok(/attachment; filename=".*-report\.html"/.test(r.headers.get('content-disposition')));
  ok('the HTML report renders, escapes attendee text, and can be downloaded');
  for (const [m, p] of [['GET', `${R}/report`], ['GET', `${R}/report.html`], ['POST', `${R}/report/email`]]) {
    assert.strictEqual((await call(m, p)).status, 401, p);
    assert.strictEqual((await call(m, p, { cookie: D })).status, 403, p);
    assert.strictEqual((await call(m, p, { cookie: A })).status, 404, p);
  }
  ok('only the owner of the event can open or send its report');
  r = await call('POST', `${R}/report/email`, { cookie: B, body: {} });
  assert.strictEqual(r.status, 503); assert.ok(/not set up/.test(r.json.error));
  ok('emailing says plainly when the server has no mail settings');
  const sent = [];
  require('./lib/mail').setTransport({ sendMail: async (m) => { sent.push(m); return {}; } });
  r = await call('POST', `${R}/report/email`, { cookie: B, body: { tz: 'Africa/Lagos', to: 'attacker@evil.example' } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].to, 'b@example.com');
  assert.ok(sent[0].attachments[0].filename.endsWith('-report.html') && sent[0].attachments[0].content.includes('Arrivals through the day'));
  assert.ok(sent[0].html.includes('how it went') && !sent[0].html.includes('<script>boom') && sent[0].text.includes('turnout'));
  ok("the report is emailed to the owner's own address only, with the full report attached");
  for (let i = 0; i < 4; i++) await call('POST', `${R}/report/email`, { cookie: B, body: {} });
  assert.strictEqual((await call('POST', `${R}/report/email`, { cookie: B, body: {} })).status, 429);
  require('./lib/mail').setTransport({ sendMail: async () => { throw new Error('smtp down'); } });
  const evB3 = (await call('POST', '/api/org/events', { cookie: B, body: { name: 'Empty Event' } })).json;
  r = await call('POST', `/api/org/events/${evB3.id}/report/email`, { cookie: B, body: {} });
  assert.strictEqual(r.status, 502); assert.ok(!/smtp down/.test(r.text));
  r = await call('GET', `/api/org/events/${evB3.id}/report.html`, { cookie: B });
  assert.strictEqual(r.status, 200); assert.ok(r.text.includes('Empty Event'));
  require('./lib/mail').setTransport(null);
  ok('sending is rate limited, mail errors are not leaked, and an event with no one still gets a report');

  // ---------- calendar: .ics files and Google Calendar ----------
  const google = require('./lib/google'), dbx = require('./lib/db');
  const E = `/api/org/events/${evB.id}`;
  assert.strictEqual((await call('GET', `/api/e/${evB.slug}/calendar.ics`)).status, 404); // no date yet
  r = await call('PATCH', E, { cookie: B, body: { starts_at: '2026-11-04T09:00:00.000Z', ends_at: '2026-11-04T08:00:00.000Z' } });
  assert.strictEqual(r.status, 400); assert.ok(/after the start/.test(r.json.error));
  r = await call('PATCH', E, { cookie: B, body: { name: 'Tech, Ignite; "Day"', venue: 'Hall A, Uyo', starts_at: '2026-11-04T09:00:00.000Z', ends_at: '2026-11-04T13:30:00.000Z' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ends_at, '2026-11-04T13:30:00.000Z');
  r = await call('GET', `/api/e/${evB.slug}/calendar.ics`);
  assert.strictEqual(r.status, 200); assert.ok(/text\/calendar/.test(r.headers.get('content-type')));
  assert.ok(r.text.includes('DTSTART:20261104T090000Z') && r.text.includes('DTEND:20261104T133000Z') && r.text.includes('SUMMARY:Tech\\, Ignite\\; "Day"') && r.text.includes('LOCATION:Hall A\\, Uyo'));
  assert.ok(r.text.startsWith('BEGIN:VCALENDAR\r\n') && r.text.endsWith('END:VCALENDAR\r\n') && r.text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  const ics1 = (await call('GET', `/api/ticket/${evB2.token}/calendar.ics`)).text, ics2 = (await call('GET', `/api/ticket/${evB2.token}/calendar.ics`)).text;
  const uid = (t) => t.match(/UID:(\S+)/)[1];
  assert.strictEqual(uid(ics1), uid(ics2)); assert.notStrictEqual(uid(ics1), uid(r.text));
  assert.strictEqual((await call('GET', '/api/ticket/AAAA.bad/calendar.ics')).status, 404);
  r = await call('PATCH', E, { cookie: B, body: { starts_at: '' } });
  assert.strictEqual(r.status, 400); // an end time without a start is refused
  await call('PATCH', E, { cookie: B, body: { ends_at: '', starts_at: '2026-11-04T09:00:00.000Z' } });
  assert.strictEqual((await call('GET', `/api/e/${evB.slug}/calendar.ics`)).text.includes('DTEND:20261104T110000Z'), true); // default 2 hours
  ok('calendar files are valid, escaped, per-ticket, default to 2 hours, and bad end times are refused');

  // Google not configured: everything says so plainly and nothing breaks
  google.setCredentials(null);
  assert.strictEqual((await call('GET', `/api/e/${evB.slug}`)).json.calendar_auto, false);
  assert.deepStrictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json, { enabled: false, connected: false, email: '' });
  assert.strictEqual((await call('GET', '/api/org/google/events', { cookie: B })).status, 503);
  r = await call('GET', `/api/google/attendee/start?token=${evB2.token}`);
  assert.strictEqual(r.status, 302); assert.ok(r.headers.get('location').includes('calendar=unavailable'));
  ok('without Google credentials the picker and one-tap add are off and say so');

  // Google configured, with Google itself replaced by a stand-in
  const calls = [];
  let tokenReply = { ok: true, status: 200, body: { access_token: 'at-1', refresh_token: 'refresh-secret-123' } };
  let eventsReply = { items: [
    { id: 'e1', status: 'confirmed', summary: 'Tech Ignite planning', location: 'Uyo Conference Hall', description: 'Theme reveal', start: { dateTime: '2026-12-02T10:00:00+01:00' }, end: { dateTime: '2026-12-02T16:00:00+01:00' } },
    { id: 'e2', status: 'confirmed', summary: 'All day workshop', start: { date: '2026-12-05' }, end: { date: '2026-12-06' } },
    { id: 'e3', status: 'cancelled', summary: 'Cancelled thing', start: { dateTime: '2026-12-09T10:00:00+01:00' } }
  ] };
  let insertReply = { ok: true, status: 200, body: {} };
  google.setCredentials({ id: 'client-id-123', secret: 'client-secret-456' });
  google.setFetch(async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url), res = (x) => ({ ok: x.ok !== false, status: x.status || 200, json: async () => x.body });
    if (u === 'https://oauth2.googleapis.com/token') return opts.body.includes('refresh_token=') && tokenReply.refreshFail ? res({ ok: false, status: 400, body: { error: 'invalid_grant' } }) : res(opts.body.includes('grant_type=refresh_token') ? { body: { access_token: 'at-2' } } : tokenReply);
    if (u.startsWith('https://openidconnect.googleapis.com')) return res({ body: { email: 'boss@company.example' } });
    if (u.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?')) return res({ body: eventsReply });
    if (u === 'https://www.googleapis.com/calendar/v3/calendars/primary/events') return res(insertReply);
    if (u === 'https://oauth2.googleapis.com/revoke') return res({ body: {} });
    return res({ ok: false, status: 404, body: {} });
  });
  assert.strictEqual((await call('GET', `/api/e/${evB.slug}`)).json.calendar_auto, true);
  assert.strictEqual((await call('GET', '/api/org/google/connect', { cookie: D })).status, 403);
  assert.strictEqual((await call('GET', '/api/org/google/connect')).status, 401);
  r = await call('GET', `/api/org/google/connect?return=${encodeURIComponent('/dashboard/events/' + evB.id)}`, { cookie: B });
  assert.strictEqual(r.status, 302);
  const gu = new URL(r.headers.get('location'));
  assert.strictEqual(gu.origin + gu.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(gu.searchParams.get('client_id'), 'client-id-123'); assert.strictEqual(gu.searchParams.get('access_type'), 'offline');
  assert.ok(gu.searchParams.get('scope').includes('calendar.readonly') && !gu.searchParams.get('scope').includes('calendar.events'));
  assert.ok(gu.searchParams.get('redirect_uri').endsWith('/api/google/callback'));
  const orgState = gu.searchParams.get('state');
  r = await call('GET', `/api/org/google/connect?return=${encodeURIComponent('https://evil.example/x')}`, { cookie: B });
  assert.ok(google.readState(new URL(r.headers.get('location')).searchParams.get('state')).r === '/dashboard');
  ok('organizer connect sends read-only calendar access to Google, and a return address outside the dashboard is ignored');

  assert.strictEqual((await call('GET', '/api/google/callback?code=x&state=forged.state')).status, 400);
  r = await call('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(orgState)}`, { cookie: A });
  assert.ok(r.headers.get('location') === '/login'); // another organization cannot finish someone else's connection
  assert.strictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json.connected, false);
  r = await call('GET', `/api/google/callback?error=access_denied&state=${encodeURIComponent(orgState)}`, { cookie: B });
  assert.ok(r.headers.get('location').endsWith('?google=declined'));
  r = await call('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(orgState)}`, { cookie: B });
  assert.strictEqual(r.headers.get('location'), `/dashboard/events/${evB.id}?google=connected`);
  const stored = dbx.prepare('SELECT google_refresh, google_email FROM orgs WHERE email=?').get('b@example.com');
  assert.ok(stored.google_refresh && !stored.google_refresh.includes('refresh-secret-123') && stored.google_email === 'boss@company.example');
  assert.strictEqual(google.unseal(stored.google_refresh), 'refresh-secret-123');
  assert.deepStrictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json, { enabled: true, connected: true, email: 'boss@company.example' });
  assert.strictEqual((await call('GET', '/api/org/google/status', { cookie: D })).status, 403);
  ok('connecting stores the refresh token encrypted, only for the organization that asked');

  r = await call('GET', '/api/org/google/events', { cookie: B });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.length, 2);
  assert.deepStrictEqual(r.json[0], { id: 'e1', title: 'Tech Ignite planning', location: 'Uyo Conference Hall', description: 'Theme reveal', all_day: false, start: '2026-12-02T10:00:00+01:00', end: '2026-12-02T16:00:00+01:00' });
  assert.strictEqual(r.json[1].all_day, true);
  const lc = calls.filter((x) => x.url.includes('/calendars/primary/events?')).pop();
  assert.strictEqual(lc.opts.headers.Authorization, 'Bearer at-2'); assert.ok(lc.url.includes('singleEvents=true') && lc.url.includes('orderBy=startTime'));
  assert.strictEqual((await call('GET', '/api/org/google/events', { cookie: A })).status, 409); // org A never connected
  assert.strictEqual((await call('GET', '/api/org/google/events', { cookie: D })).status, 403);
  ok('the dropdown list comes from the organizer\'s own calendar: cancelled events are left out and all-day events are marked');

  tokenReply = { ...tokenReply, refreshFail: true };
  r = await call('GET', '/api/org/google/events', { cookie: B });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'not_connected');
  assert.strictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json.connected, false);
  tokenReply = { ok: true, status: 200, body: { access_token: 'at-1', refresh_token: 'refresh-secret-123' } };
  r = await call('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(orgState)}`, { cookie: B });
  assert.ok(r.headers.get('location').endsWith('?google=connected'));
  r = await call('DELETE', '/api/org/google', { cookie: B });
  assert.strictEqual(r.status, 200); assert.ok(calls.some((x) => x.url === 'https://oauth2.googleapis.com/revoke'));
  assert.strictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json.connected, false);
  ok('withdrawn access asks the organizer to reconnect, and disconnecting revokes the token');

  // Attendee: one-tap add to their own calendar
  r = await call('GET', `/api/google/attendee/start?token=${evB2.token}`);
  const au = new URL(r.headers.get('location'));
  assert.strictEqual(au.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events'); assert.ok(!au.searchParams.get('access_type'));
  const attState = au.searchParams.get('state');
  assert.ok((await call('GET', '/api/google/attendee/start?token=bad.token')).headers.get('location') === '/');
  r = await call('GET', `/api/google/callback?code=zzz&state=${encodeURIComponent(attState)}`);
  assert.ok(r.headers.get('location').endsWith('?calendar=added'), r.headers.get('location'));
  const ins = calls.filter((x) => x.url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events').pop();
  const body = JSON.parse(ins.opts.body);
  assert.strictEqual(ins.opts.headers.Authorization, 'Bearer at-1');
  assert.strictEqual(body.summary, 'Tech, Ignite; "Day"'); assert.strictEqual(body.start.dateTime, '2026-11-04T09:00:00.000Z'); assert.strictEqual(body.end.dateTime, '2026-11-04T11:00:00.000Z');
  assert.ok(/^ev[0-9a-v]{5,}$/.test(body.id) && body.location === 'Hall A, Uyo');
  insertReply = { ok: false, status: 409, body: { error: { message: 'exists' } } };
  r = await call('GET', `/api/google/callback?code=zzz&state=${encodeURIComponent(attState)}`);
  assert.ok(r.headers.get('location').endsWith('?calendar=already'));
  insertReply = { ok: false, status: 500, body: { error: { message: 'boom' } } };
  r = await call('GET', `/api/google/callback?code=zzz&state=${encodeURIComponent(attState)}`);
  assert.ok(r.headers.get('location').endsWith('?calendar=failed'));
  r = await call('GET', `/api/google/callback?error=access_denied&state=${encodeURIComponent(attState)}`);
  assert.ok(r.headers.get('location').endsWith('?calendar=declined'));
  assert.ok(!dbx.prepare('SELECT * FROM orgs').all().some((o) => JSON.stringify(o).includes('at-1')));
  ok('an attendee can add the event to their own Google Calendar once; a repeat, a refusal and a Google error are handled');

  // expired or tampered state is refused
  const realNow = Date.now; Date.now = () => realNow() + 11 * 60000;
  assert.strictEqual((await call('GET', `/api/google/callback?code=zzz&state=${encodeURIComponent(attState)}`)).status, 400);
  Date.now = realNow;
  assert.strictEqual((await call('GET', `/api/google/callback?code=zzz&state=${encodeURIComponent(attState.slice(0, -2) + 'xx')}`)).status, 400);
  process.env.GOOGLE_ATTENDEE_ADD = 'false';
  assert.strictEqual((await call('GET', `/api/e/${evB.slug}`)).json.calendar_auto, false);
  assert.ok((await call('GET', `/api/google/attendee/start?token=${evB2.token}`)).headers.get('location').includes('calendar=unavailable'));
  assert.strictEqual((await call('GET', '/api/org/google/status', { cookie: B })).json.enabled, true); // the organizer picker is unaffected
  delete process.env.GOOGLE_ATTENDEE_ADD;
  google.setFetch(null); google.setCredentials(null);
  ok('a sign-in link older than 10 minutes, or changed in any way, is refused');

  // ---------- other upcoming events shown after registering ----------
  const soon = (d) => new Date(Date.now() + d * 86400e3).toISOString();
  const mkEv = async (cookie, body) => { const e = (await call('POST', '/api/org/events', { cookie, body })).json; return e; };
  assert.strictEqual(evA2.listed, false); // events are not listed unless the organizer chooses to
  const L = {};
  L.later = await mkEv(A, { name: 'Later Summit', starts_at: soon(30), listed: true, venue: 'Lagos' });
  L.sooner = await mkEv(A, { name: 'Sooner Meetup', starts_at: soon(10), listed: true, tagline: 'Come along', capacity: 100 });
  L.full = await mkEv(A, { name: 'Full House', starts_at: soon(12), listed: true, capacity: 1 });
  L.closed = await mkEv(A, { name: 'Closed Event', starts_at: soon(13), listed: true });
  L.hidden = await mkEv(A, { name: 'Unlisted Event', starts_at: soon(14) });
  L.past = await mkEv(A, { name: 'Past Event', starts_at: soon(-3), listed: true });
  L.nodate = await mkEv(A, { name: 'No Date Event', listed: true });
  L.joined = await mkEv(A, { name: 'Already Registered', starts_at: soon(15), listed: true });
  L.mine = await mkEv(B, { name: 'My Other Event', starts_at: soon(20), listed: true });
  assert.strictEqual((await reg(L.full.slug, { name: 'Only One', email: 'one@example.com' })).status, 200);
  assert.strictEqual((await reg(L.joined.slug, { name: 'Bee', email: 'bee@example.com' })).status, 200);
  await call('PATCH', `/api/org/events/${L.closed.id}`, { cookie: A, body: { registration_open: false } });
  r = await call('GET', `/api/ticket/${evB2.token}/upcoming`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.map((x) => x.name), ['Sooner Meetup', 'My Other Event', 'Later Summit']);
  assert.strictEqual(r.json[0].org_name, 'Org A'); assert.strictEqual(r.json[0].spots_left, 100); assert.strictEqual(r.json[2].spots_left, null);
  ok('after registering, a person sees other listed events that are open and upcoming, soonest first');
  const flat = JSON.stringify(r.json);
  assert.ok(!flat.includes('gate_key') && !flat.includes('@example.com') && !flat.includes(L.later.gate_key) && !/"id"/.test(flat));
  assert.strictEqual((await call('GET', '/api/ticket/AAAA.bad/upcoming')).status, 404);
  ok('unlisted, past, undated, closed, full and already-registered events are left out, and no private details are exposed');
  await call('PATCH', `/api/org/events/${L.later.id}`, { cookie: A, body: { listed: false } });
  assert.ok(!(await call('GET', `/api/ticket/${evB2.token}/upcoming`)).json.some((x) => x.name === 'Later Summit'));
  assert.strictEqual((await call('PATCH', `/api/org/events/${L.later.id}`, { cookie: B, body: { listed: true } })).status, 404);
  assert.strictEqual((await call('PATCH', `/api/org/events/${L.later.id}`, { cookie: D, body: { listed: true } })).status, 403);
  ok('only the owning organizer can list or unlist an event');
  assert.ok(!(await call('GET', '/')).text.includes('Sooner Meetup'));

  // ---------- phone numbers ----------
  {
    const pe = await mkEv(A, { name: 'Phone Test', starts_at: soon(40) });
    let pr = await reg(pe.slug, { name: 'Pho One', email: 'pho1@example.com', phone: '+234 801 234 5678' });
    assert.strictEqual(pr.status, 200);
    assert.strictEqual((await reg(pe.slug, { name: 'Pho Two', email: 'pho2@example.com' })).status, 200); // optional
    assert.strictEqual((await reg(pe.slug, { name: 'Pho Bad', email: 'pho3@example.com', phone: 'call me' })).status, 400);
    assert.strictEqual((await reg(pe.slug, { name: 'Pho Short', email: 'pho4@example.com', phone: '123' })).status, 400);
    assert.strictEqual((await reg(pe.slug, { name: 'Pho Html', email: 'pho5@example.com', phone: '<b>0801234567</b>' })).status, 400);
    const list = (await call('GET', `/api/org/events/${pe.id}/attendees`, { cookie: A })).json;
    assert.strictEqual(list.find((x) => x.email === 'pho1@example.com').phone, '+234 801 234 5678');
    assert.strictEqual(list.length, 2);
    assert.ok(!JSON.stringify((await call('GET', `/api/e/${pe.slug}/directory`)).json || '').includes('234 801'));
    assert.ok((await call('GET', `/api/org/events/${pe.id}/export.csv`, { cookie: A })).text.includes('+234 801 234 5678'));
    ok('phone number is optional, validated, shown to the organizer, exported, and never in the public directory');
  }

  // ---------- pages ----------
  for (const p of ['/', '/login', '/signup', '/dashboard', '/dashboard/events/new', `/e/${evB.slug}`, `/e/${evB.slug}/community`, `/scan/${evB.slug}`, `/t/${evB2.token}`, '/vendor/jsqr.js', '/sw.js', '/healthz']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
  ok('every page is served');

  // ---------- brand ----------
  for (const [p, type] of [['/fonts/bricolage-latin.woff2', /font\/woff2|octet/], ['/fonts/bricolage-latin-ext.woff2', /./], ['/brand/sprite.svg', /svg/], ['/brand/favicon.svg', /svg/], ['/brand/og.png', /png/], ['/brand/apple-touch-icon.png', /png/], ['/favicon.ico', /./]]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p); assert.ok(type.test(r.headers.get('content-type') || ''), p + ' type');
  }
  const home = await (await fetch(base + '/')).text();
  assert.ok(/bọyọ/.test(home) && !/Gate Pass/.test(home));
  for (const p of ['/login', '/dashboard', `/e/${evB.slug}`, `/t/${evB2.token}`, `/scan/${evB.slug}`]) {
    const h = await (await fetch(base + p)).text();
    assert.ok(!/Gate Pass/.test(h), p + ' still says Gate Pass');
  }
  const evPage = await (await fetch(base + `/e/${evB.slug}`)).text();
  assert.ok(/og:site_name" content="bọyọ"/.test(evPage) && /og:image/.test(evPage));
  assert.ok(/Powered by/.test(evPage));
  ok('bọyọ fonts, icons and share image are served; pages carry the new brand');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
