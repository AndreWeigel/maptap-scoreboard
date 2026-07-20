// All tunables in one place. The first four can be overridden by env vars so a
// container doesn't need a rebuild to change them (see .env.example).
module.exports = {
  GROUP_ID: process.env.GROUP_ID || '',   // WhatsApp group JID. Leave empty on first run: the
                                          // bot logs every group JID so you can copy it here.
  TZ: process.env.TZ || 'Europe/Madrid',  // daily-boundary timezone
  SEASON_START: process.env.SEASON_START || '2026-01-01', // change to reset seasons
  CRON_TIME: '59 23 * * *',     // daily winner computation
  PORT: Number(process.env.PORT) || 3000,
  FIRE_THRESHOLD: 95,           // round >= this = 🔥 round
  PANIC_THRESHOLD: 40,          // round <= this = 😱 round
  ROUNDS_PER_GAME: 5,
  DB_PATH: 'data/scores.db',
  AUTH_DIR: 'data/auth',
};
