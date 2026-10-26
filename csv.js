/* Small CSV reader for guest lists: quotes, BOM, CRLF, and comma / semicolon / tab separators. */

function parseRows(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const HEADS = {
  name: ['name', 'full name', 'fullname', 'guest', 'guest name', 'names', 'participant', 'attendee'],
  first: ['first name', 'firstname', 'first', 'given name', 'surname first'],
  last: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  organization: ['organization', 'organisation', 'company', 'institution', 'school', 'org', 'affiliation'],
  role: ['role', 'title', 'job title', 'position', 'designation'],
  phone: ['phone', 'phone number', 'mobile', 'tel', 'telephone', 'whatsapp']
};

/** Turn CSV text into guests. Returns {guests:[{name,email,organization,role,phone,row}], invalid:[{row,reason}], hasHeader}. */
function parseGuests(text, { emailOk, str, maxRows = 5000 }) {
  const rows = parseRows(text);
  if (!rows.length) return { guests: [], invalid: [], hasHeader: false };
  const norm = (s) => s.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  const head = rows[0].map(norm);
  const idx = {};
  for (const [k, names] of Object.entries(HEADS)) { const i = head.findIndex((h) => names.includes(h)); if (i !== -1) idx[k] = i; }
  const hasHeader = idx.name !== undefined || (idx.first !== undefined) || idx.email !== undefined;
  let body = rows, map = idx;
  if (hasHeader) body = rows.slice(1);
  else map = { name: 0, email: rows[0].length > 1 ? 1 : undefined, organization: 2, role: 3, phone: 4 }; // no header: name, email, organization, role, phone
  const guests = [], invalid = [];
  body.slice(0, maxRows).forEach((r, n) => {
    const rowNo = n + (hasHeader ? 2 : 1);
    const get = (k, max) => (map[k] === undefined ? '' : str(r[map[k]], max));
    let name = get('name', 120);
    if (!name && map.first !== undefined) name = str(`${get('first', 60)} ${get('last', 60)}`, 120);
    const email = get('email', 200).toLowerCase();
    if (!name && email) name = email.split('@')[0];
    if (!name) { invalid.push({ row: rowNo, reason: 'No name' }); return; }
    if (email && !emailOk(email)) { invalid.push({ row: rowNo, reason: `"${email.slice(0, 40)}" is not a valid email` }); return; }
    guests.push({ row: rowNo, name, email, organization: get('organization', 120), role: get('role', 120), phone: get('phone', 40) });
  });
  if (body.length > maxRows) invalid.push({ row: maxRows + 2, reason: `Only the first ${maxRows} rows were read` });
  return { guests, invalid, hasHeader };
}

module.exports = { parseRows, parseGuests };
