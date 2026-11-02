#!/usr/bin/env node
// Creates a demo organization with one event built from the sample flyer, so you can see the whole
// flow without typing anything. Run the server first, then:
//
//   node scripts/seed-demo.js [http://localhost:3000]
//
// Optional env: DEMO_EMAIL, DEMO_PASSWORD, SIGNUP_CODE (if your server requires one).
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const email = process.env.DEMO_EMAIL || 'demo@example.com';
const password = process.env.DEMO_PASSWORD || 'demo-password-1';
const flyerPath = path.join(__dirname, '..', 'samples', 'tech-ignite-flyer.jpg');

let cookie = '';
async function call(method, p, body, headers = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  let json = null; try { json = await res.json(); } catch (_) {}
  if (!res.ok) { const e = new Error((json && json.error) || `${method} ${p} failed (${res.status})`); e.status = res.status; throw e; }
  return json;
}

(async () => {
  try {
    await call('POST', '/api/org/signup', { name: 'GDG University of Uyo', email, password, code: process.env.SIGNUP_CODE || '' });
  } catch (e) {
    if (e.status !== 409) throw e;
    await call('POST', '/api/org/login', { email, password });
  }

  const ev = await call('POST', '/api/org/events', {
    name: "Tech Ignite '26",
    tagline: 'Beyond the Hype: Are You Actually Building?',
    description: 'Theme reveal for Tech Ignite \'26.\n\nDate and venue to be announced. Register now and we will keep you posted.',
    capacity: 300,
    theme: { bg: '#000000', ink: '#ffffff', accent: '#ffd62e' }
  });
  await call('POST', `/api/org/events/${ev.id}/flyer`, fs.readFileSync(flyerPath), { 'Content-Type': 'image/jpeg' });

  const people = [
    ['Ngozi Adeyemi', 'ngozi@example.com', 'Delta Fintech', 'Product lead', 'payments, AI', true],
    ['Tunde Bakare', 'tunde@example.com', 'Rivers Digital Hub', 'Community manager', 'events, startups', true],
    ['Amaka Eze', 'amaka@example.com', 'Port Harcourt Labs', 'Data engineer', 'machine learning, data', true],
    ['Chidi Okoro', 'chidi@example.com', 'Niger Delta Energy', 'Operations analyst', 'automation', false],
    ['Fatima Bello', 'fatima@example.com', 'Kano Health Tech', 'Founder', 'health, logistics', true]
  ];
  const tokens = [];
  for (const [name, em, organization, role, interests, dir] of people) {
    const r = await call('POST', `/api/e/${ev.slug}/register`, { name, email: em, organization, role, interests, consent_terms: true, consent_community: true, consent_directory: dir });
    tokens.push(r.token);
  }
  await call('POST', `/api/gate/${ev.slug}/checkin`, { token: tokens[4] }, { 'x-gate-key': ev.gate_key });

  console.log('\nDemo ready.\n');
  console.log(`  Event page     ${base}/e/${ev.slug}`);
  console.log(`  Sign in at     ${base}/login   (${email} / ${password})`);
  console.log(`  Manage         ${base}/dashboard/events/${ev.id}`);
  console.log(`  Gate scanner   ${base}/scan/${ev.slug}   key: ${ev.gate_key}`);
  console.log(`  A sample ticket ${base}/t/${tokens[0]}\n`);
})().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
