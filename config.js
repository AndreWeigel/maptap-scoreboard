// All tunables in one place. The first four can be overridden by env vars so a
// container doesn't need a rebuild to change them (see .env.example).
module.exports = {
  GROUP_ID: process.env.GROUP_ID || '',   // WhatsApp group JID. Leave empty on first run: the
                                          // bot logs every group JID so you can copy it here.
  TZ: process.env.TZ || 'Europe/Berlin',  // daily-boundary timezone
  SEASON_START: process.env.SEASON_START || '2026-01-01', // change to reset seasons
  CRON_TIME: '59 23 * * *',     // daily winner computation (+ daily digest)
  DAILY_SUMMARY: process.env.DAILY_SUMMARY === 'true',   // post nightly digest to the group (default off)
  WEEKLY_SUMMARY: process.env.WEEKLY_SUMMARY === 'true', // post Monday weekly recap (default off)
  WEEKLY_CRON: process.env.WEEKLY_CRON || '5 0 * * 1',   // Mon 00:05, covers the prior week
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',            // if set, required to hit /admin/summary
  PORT: Number(process.env.PORT) || 3000,
  FIRE_THRESHOLD: 95,           // round >= this = 🔥 round
  PANIC_THRESHOLD: 40,          // round <= this = 😱 round
  ROUNDS_PER_GAME: 5,
  DB_PATH: 'data/scores.db',
  AUTH_DIR: 'data/auth',
};
