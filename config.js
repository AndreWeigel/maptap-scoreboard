// All tunables in one place. The first four can be overridden by env vars so a
// container doesn't need a rebuild to change them (see .env.example).
module.exports = {
  GROUP_ID: process.env.GROUP_ID || '',   // WhatsApp group JID. Leave empty on first run: the
                                          // bot logs every group JID so you can copy it here.
  TZ: process.env.TZ || 'Europe/Berlin',  // daily-boundary timezone
  // Seasons, in date order. Each runs until the day before the next one starts;
  // the newest one that has started is live. Add the next one ahead of time and
  // it takes over on its day.
  SEASONS: [
    { name: 'Season 1', from: '2026-01-01' },
    { name: 'Season 2', from: '2026-09-23' },  // autumn equinox
  ],
  CRON_TIME: '59 23 * * *',     // daily winner computation (+ daily digest)
  DAILY_SUMMARY: process.env.DAILY_SUMMARY === 'true',   // post nightly digest to the group (default off)
  WEEKLY_SUMMARY: process.env.WEEKLY_SUMMARY === 'true', // post Monday weekly recap (default off)
  WEEKLY_CRON: process.env.WEEKLY_CRON || '5 0 * * 1',   // Mon 00:05, covers the prior week
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',            // if set, required to hit /admin/summary
  FRIENDS_TOKEN: process.env.FRIENDS_TOKEN || '',        // password for /globe + /uploads (friends' photos)
  PORT: Number(process.env.PORT) || 3000,
  // Feedback notification mail. Unset SMTP_USER/SMTP_PASS = no mail is sent and
  // the form still works; reports are always readable at /admin/feedback.
  SMTP_HOST: process.env.SMTP_HOST || 'mail.gandi.net',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 465,
  SMTP_USER: process.env.SMTP_USER || '',   // full mailbox address
  SMTP_PASS: process.env.SMTP_PASS || '',
  FEEDBACK_TO: process.env.FEEDBACK_TO || '',  // where feedback notifications land
  FIRE_THRESHOLD: 95,           // round >= this = 🔥 round
  PANIC_THRESHOLD: 40,          // round <= this = 😱 round
  DB_PATH: 'data/scores.db',
  AUTH_DIR: 'data/auth',
};
