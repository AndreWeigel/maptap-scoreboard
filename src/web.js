const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { computeStandings, dailyHistory } = require('./scoring');
const { toDateStr } = require('./parser');
const { dailySummary, weeklySummary } = require('./summary');
const { priorWeek } = require('./cron');
const users = require('./users');
const { resolveRows } = users;
const settings = require('./settings');
const importer = require('./import');

// HTTP Basic Auth for admin routes. Any username; the password must equal
// ADMIN_TOKEN (compared in constant time). Unset ADMIN_TOKEN => admin locked.
function basicAuth(req, res, next) {
  const secret = config.ADMIN_TOKEN;
  const deny = (msg, code = 401) => {
    if (code === 401) res.set('WWW-Authenticate', 'Basic realm="maptap admin"');
    res.status(code).send(msg);
  };
  if (!secret) return deny('Admin disabled — set ADMIN_TOKEN to enable.', 503);
  const [, b64 = ''] = (req.headers.authorization || '').split(' ');
  const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return deny('Auth required.');
  next();
}

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
  app.use(express.json({ limit: '12mb' })); // WhatsApp exports run ~1MB of text

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'scoreboard.html'));
  });

  // ---- Admin (Basic Auth). ----
  app.get('/admin', basicAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
  });

  app.get('/summary', basicAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'summary.html'));
  });

  app.get('/api/settings', basicAuth, (_req, res) => res.json(settings.get()));

  app.post('/api/settings', basicAuth, (req, res) => res.json(settings.set(req.body || {})));

  // ---- Admin: player registry (Basic Auth). ----
  app.get('/users', basicAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'users.html'));
  });

  app.get('/api/users', basicAuth, (_req, res) => {
    // Every distinct id seen in results, with its latest display name, day count,
    // and last-played date — so the admin UI can label draggable id chips.
    const info = db.raw.prepare(`
      SELECT r.player_id AS id, r.player_name AS name, c.days, c.last
      FROM results r
      JOIN (SELECT player_id, COUNT(*) days, MAX(play_date) last FROM results GROUP BY player_id) c
        ON c.player_id = r.player_id AND c.last = r.play_date
    `).all();
    const assigned = new Set(users.get().users.flatMap((u) => u.ids));
    res.json({
      users: users.get().users,
      orphans: info.filter((x) => !assigned.has(x.id)),
      idInfo: Object.fromEntries(info.map((x) => [x.id, x])),
    });
  });

  app.post('/api/users', basicAuth, (req, res) => res.json(users.save(req.body || {})));

  // ---- Admin: import results from a WhatsApp .txt export. ----
  app.get('/import', basicAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'import.html'));
  });

  app.post('/api/import/preview', basicAuth, (req, res) => {
    res.json({ senders: importer.preview((req.body && req.body.text) || '') });
  });

  app.post('/api/import', basicAuth, (req, res) => {
    const b = req.body || {};
    res.json(importer.run(db, b.text || '', Array.isArray(b.senders) ? b.senders : []));
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
  // Behind Basic Auth (password = ADMIN_TOKEN).
  app.get('/admin/summary', basicAuth, (req, res) => {
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
