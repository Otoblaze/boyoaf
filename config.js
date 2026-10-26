const path = require('path');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.TICKET_SECRET || 'dev-secret-change-me';
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const ALLOW_PUBLIC_SIGNUP = process.env.ALLOW_PUBLIC_SIGNUP === 'true';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'data.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads');

// Keys derived from one secret so there is only one thing to configure.
const derive = (label) => crypto.createHmac('sha256', SECRET).update(label).digest();
const TICKET_KEY = derive('ticket-v1');
const SESSION_KEY = derive('session-v1');

// Refuse to start in production with development defaults or open signups nobody chose.
if (IS_PROD) {
  const problems = [];
  if (SECRET === 'dev-secret-change-me' || SECRET.length < 24) {
    problems.push('TICKET_SECRET must be set to a random string of at least 24 characters');
  }
  if (!ALLOW_PUBLIC_SIGNUP && SIGNUP_CODE.length < 6) {
    problems.push('Set SIGNUP_CODE (6+ characters) to control who can create organizer accounts, or set ALLOW_PUBLIC_SIGNUP=true to let anyone sign up');
  }
  if (problems.length) {
    console.error('Refusing to start:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

module.exports = {
  IS_PROD, SECRET, TICKET_KEY, SESSION_KEY, SIGNUP_CODE, ALLOW_PUBLIC_SIGNUP,
  DATA_DIR, DB_FILE, UPLOAD_DIR,
  // Signups are open in development; in production they need a code unless explicitly opened.
  signupCodeRequired: IS_PROD && !ALLOW_PUBLIC_SIGNUP && !!SIGNUP_CODE
};
