// Outbound notification mail over SMTP (Gandi by default). Optional: with no
// SMTP_USER/SMTP_PASS the app runs exactly as before and send() is a no-op,
// same as ADMIN_TOKEN gating the admin pages.
const nodemailer = require('nodemailer');
const config = require('../config');

let transport;
function getTransport() {
  if (!config.SMTP_USER || !config.SMTP_PASS) return null;
  // Built once and reused — nodemailer pools connections per transport, and a
  // fresh one per email would re-do the TLS handshake every time.
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
  }
  return transport;
}

const enabled = () => !!(config.SMTP_USER && config.SMTP_PASS && config.FEEDBACK_TO);

// Fire-and-forget by design: the caller has already stored the feedback, so a
// dead mail server must never turn a saved report into an error for the person
// who sent it. Resolves either way; failures are logged, not thrown.
async function sendFeedbackMail(row) {
  const t = getTransport();
  if (!t || !config.FEEDBACK_TO) return { sent: false, reason: 'smtp not configured' };
  const subject = `[MapTap ${row.kind}] from ${row.sender}`;
  const text = [
    `${row.kind} report from ${row.sender} <${row.email}>`,
    `at ${row.created_at}`,
    '',
    row.message,
    '',
    '— reply straight to this mail to answer them.',
  ].join('\n');
  try {
    await t.sendMail({
      from: `MapTap <${config.SMTP_USER}>`, // must be the authenticated mailbox; Gandi rejects other senders
      to: config.FEEDBACK_TO,
      replyTo: `${row.sender} <${row.email}>`, // so "reply" reaches the reporter, not yourself
      subject,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mail] feedback notification failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendFeedbackMail, enabled };
