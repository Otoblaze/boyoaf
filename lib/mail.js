/* Outgoing email. Off until SMTP_URL is set (for example smtps://user:password@smtp.example.com:465). */
let transport = null, forced = false;

function configured() { return forced || !!process.env.SMTP_URL; }
function from() { return process.env.MAIL_FROM || 'bọyọ <no-reply@localhost>'; }
function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_URL) return null;
  transport = require('nodemailer').createTransport(process.env.SMTP_URL);
  return transport;
}
/** Tests plug in a fake transport here. */
function setTransport(t) { transport = t; forced = !!t; }

async function send({ to, subject, text, html, attachments }) {
  const t = getTransport();
  if (!t) { const e = new Error('Email is not set up on this server.'); e.code = 'NO_MAIL'; throw e; }
  return t.sendMail({ from: from(), to, subject, text, html, attachments });
}

module.exports = { configured, send, setTransport };
