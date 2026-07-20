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

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      whatsappConnected: status.whatsappConnected,
      lastMessageAt: status.lastMessageAt,
    });
  });

  return app;
}

module.exports = { createApp };
