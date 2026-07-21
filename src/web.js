const path = require('node:path');
const express = require('express');
const config = require('../config');
const { computeStandings, dailyHistory } = require('./scoring');
const { toDateStr } = require('./parser');
const { dailySummary, weeklySummary } = require('./summary');
const { priorWeek } = require('./cron');
const { resolveRows } = require('./users');

function buildSummary(db, kind) {
  if (kind === 'daily') {
    const d = toDateStr(new Date());
    return dailySummary(resolveRows(db.getResults(d, d)), d);
  }
  const { from, to } = priorWeek(new Date());
  return weeklySummary(resolveRows(db.getResults(from, to)), from, to, config);
}

function createApp(db, status) {
  const app = express();

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'scoreboard.html'));
  });

  app.get('/api/standings', (req, res) => {
    const from = req.query.from || config.SEASON_START;
    const to = req.query.to || toDateStr(new Date());
    const rows = resolveRows(db.getResults(from, to));
    res.json({
      range: { from, to },
      seasonStart: config.SEASON_START,
      ...computeStandings(rows, config),
      history: dailyHistory(rows),
      updatedAt: new Date().toISOString(),
    });
  });

  // Manual trigger. GET previews the text; add &send=1 to actually post to the group.
  //   /admin/summary?kind=weekly            -> returns the text, sends nothing
  //   /admin/summary?kind=daily&send=1      -> posts it now
  // Guarded by ADMIN_TOKEN (?token=) when that env var is set.
  app.get('/admin/summary', (req, res) => {
    if (config.ADMIN_TOKEN && req.query.token !== config.ADMIN_TOKEN) {
      return res.status(403).json({ error: 'bad or missing token' });
    }
    const kind = req.query.kind === 'daily' ? 'daily' : 'weekly';
    const text = buildSummary(db, kind);
    if (!text) return res.type('text/plain').send('(nothing to post — no results in range)');
    if (req.query.send !== '1') return res.type('text/plain').send(text);
    if (!config.GROUP_ID || !status.sock) {
      return res.status(503).json({ error: 'WhatsApp not connected / GROUP_ID unset' });
    }
    status.sock.sendMessage(config.GROUP_ID, { text })
      .then(() => res.type('text/plain').send(`sent:\n${text}`))
      .catch((e) => res.status(500).json({ error: String(e) }));
  });

  // 503 when WhatsApp is down. The web server being up says nothing about whether
  // we're still recording results, and a monitor shouldn't have to know to grep the
  // body to find that out. The page reads the body either way (fetch ignores 5xx).
  app.get('/healthz', (_req, res) => {
    const ok = status.whatsappConnected;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      whatsappConnected: ok,
      lastMessageAt: status.lastMessageAt,
    });
  });

  return app;
}

module.exports = { createApp };
