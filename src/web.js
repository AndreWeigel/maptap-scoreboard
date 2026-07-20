const path = require('node:path');
const express = require('express');
const config = require('../config');
const { computeStandings } = require('./scoring');
const { toDateStr } = require('./parser');

function createApp(db, status) {
  const app = express();

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'scoreboard.html'));
  });

  app.get('/api/standings', (req, res) => {
    const from = req.query.from || config.SEASON_START;
    const to = req.query.to || toDateStr(new Date());
    const rows = db.getResults(from, to);
    res.json({
      range: { from, to },
      seasonStart: config.SEASON_START,
      ...computeStandings(rows, config),
      updatedAt: new Date().toISOString(),
    });
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
