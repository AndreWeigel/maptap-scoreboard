const cron = require('node-cron');
const config = require('../config');
const { rankDay } = require('./scoring');
const { toDateStr } = require('./parser');

// Cache today's ranks into daily_results. Convenience only — standings are
// always computed from `results` directly, so a missed run loses nothing.
function scoreDay(db, playDate) {
  const rows = db.getResults(playDate, playDate);
  db.replaceDailyResults(playDate, rankDay(rows));
  console.log(`[cron] scored ${playDate}: ${rows.length} result(s)`);
  return rows.length;
}

function startCron(db) {
  cron.schedule(config.CRON_TIME, () => scoreDay(db, toDateStr(new Date())), {
    timezone: config.TZ,
  });
}

module.exports = { scoreDay, startCron };
