const cron = require('node-cron');
const config = require('../config');
const { toDateStr } = require('./parser');
const { dailySummary, weeklySummary } = require('./summary');
const { resolveRows } = require('./users');
const settings = require('./settings');

function send(status, text) {
  if (!text) return;
  if (!config.GROUP_ID || !status.sock) {
    console.log(`[cron] not sending (no group/socket):\n${text}`);
    return;
  }
  status.sock.sendMessage(config.GROUP_ID, { text })
    .catch((e) => console.error('[cron] send failed:', e));
}

// prior 7 days ending yesterday (weekly runs just after midnight Monday)
function priorWeek(now) {
  const to = new Date(now); to.setDate(to.getDate() - 1);
  const from = new Date(to); from.setDate(from.getDate() - 6);
  return { from: toDateStr(from), to: toDateStr(to) };
}

// Both jobs are always scheduled; the runtime setting (toggled from /summary)
// decides whether each one actually posts. That's what lets the toggle take
// effect without a restart.
function startCron(db, status) {
  cron.schedule(config.CRON_TIME, () => {
    if (!settings.get().dailySummary) return;
    const playDate = toDateStr(new Date());
    send(status, dailySummary(resolveRows(db.getResults(playDate, playDate)), playDate));
  }, { timezone: config.TZ });

  cron.schedule(config.WEEKLY_CRON, () => {
    if (!settings.get().weeklySummary) return;
    const { from, to } = priorWeek(new Date());
    send(status, weeklySummary(resolveRows(db.getResults(from, to)), from, to, config));
  }, { timezone: config.TZ });
}

module.exports = { startCron, priorWeek };
