const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DB_FILE, UPLOAD_DIR } = require('./config');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function open() {
  const d = new Database(DB_FILE);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  return d;
}

let db = open();

// The first version of this project handled one event with a different schema. If a database from that
// version is found, move it aside (never delete it) and start fresh with the multi-organization schema.
const eventCols = db.prepare('PRAGMA table_info(events)').all();
if (eventCols.length && !eventCols.some((c) => c.name === 'org_id')) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const backup = DB_FILE.replace(/\.db$/, '') + `.single-event-${Date.now()}.db`;
  fs.renameSync(DB_FILE, backup);
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) {} }
  console.warn(`Found a database from the single-event version. Moved it to ${backup} and created a new one.`);
  db = open();
}

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 0,
  flyer TEXT NOT NULL DEFAULT '',
  theme_bg TEXT NOT NULL DEFAULT '#101614',
  theme_ink TEXT NOT NULL DEFAULT '#f2f5f1',
  theme_accent TEXT NOT NULL DEFAULT '#45bfb0',
  registration_open INTEGER NOT NULL DEFAULT 1,
  gate_key TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);

CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  interests TEXT NOT NULL DEFAULT '',
  consent_community INTEGER NOT NULL DEFAULT 0,
  consent_directory INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  checked_in_at TEXT,
  UNIQUE(event_id, email)
);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON attendees(event_id);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(org_id);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);
`);

// Columns added after the first release. Safe to run every start.
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('events', 'ends_at', "TEXT NOT NULL DEFAULT ''");
addColumn('events', 'listed', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orgs', 'google_refresh', "TEXT NOT NULL DEFAULT ''");
addColumn('orgs', 'google_email', "TEXT NOT NULL DEFAULT ''");

module.exports = db;
