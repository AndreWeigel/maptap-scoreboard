// All tunables in one place.
module.exports = {
  GROUP_ID: '',                 // WhatsApp group JID. Leave empty on first run: the bot
                                // logs the JID of every group message so you can copy it here.
  TZ: 'Europe/Madrid',          // daily-boundary timezone
  SEASON_START: '2026-01-01',   // all-time for now; change to reset seasons
  CRON_TIME: '59 23 * * *',     // daily winner computation
  PORT: 3000,
  FIRE_THRESHOLD: 95,           // round >= this = 🔥 round
  PANIC_THRESHOLD: 40,          // round <= this = 😱 round
  ROUNDS_PER_GAME: 5,
  DB_PATH: 'data/scores.db',
  AUTH_DIR: 'data/auth',
};
