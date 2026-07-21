const config = require('../config');
process.env.TZ = config.TZ; // before any Date use, so daily boundaries are consistent

const { openDb } = require('./db');
const { startWhatsApp } = require('./whatsapp');
const { startCron } = require('./cron');
const { createApp } = require('./web');

const db = openDb(config.DB_PATH);
const status = { whatsappConnected: false, lastMessageAt: null };

startWhatsApp(db, status).catch((err) => {
  console.error('[whatsapp] fatal:', err);
  process.exit(1); // let pm2/systemd restart us
});
startCron(db, status);
createApp(db, status).listen(config.PORT, () => {
  console.log(`[web] scoreboard at http://localhost:${config.PORT}`);
});
