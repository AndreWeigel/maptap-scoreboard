const fs = require('node:fs');
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
const mail = require('./mail');

// HTTP Basic Auth. Any username; the password must equal one of the named
// config secrets (compared in constant time). None of them set => locked (503).
function passwordGate(realm, ...secretNames) {
  return function gate(req, res, next) {
    const secrets = secretNames.map((n) => config[n]).filter(Boolean);
    const deny = (msg, code = 401) => {
      if (code === 401) res.set('WWW-Authenticate', `Basic realm="maptap ${realm}"`);
      res.status(code).send(msg);
    };
    if (!secrets.length) return deny(`Locked — set ${secretNames[0]} to enable.`, 503);
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass);
    const ok = secrets.some((s) => {
      const b = Buffer.from(s);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!ok) return deny('Auth required.');
    next();
  };
}

const basicAuth = passwordGate('admin', 'ADMIN_TOKEN');
// Photos, the globe page and its API all expose friends' faces, real names and
// birth cities, so they sit behind FRIENDS_TOKEN (the admin password opens them
// too). FRIENDS_TOKEN unset => admin-only: the safe direction to fail.
const friendsAuth = passwordGate('friends', 'FRIENDS_TOKEN', 'ADMIN_TOKEN');

function buildSummary(db, kind) {
  if (kind === 'daily') {
    let d = toDateStr(new Date());
    let rows = resolveRows(db.getResults(d, d));
    if (!rows.length) {
      // Clicked after midnight but before anyone has played: post yesterday's game.
      const y = new Date(); y.setDate(y.getDate() - 1); d = toDateStr(y);
      rows = resolveRows(db.getResults(d, d));
    }
    return dailySummary(rows, d);
  }
  const { from, to } = priorWeek(new Date());
  return weeklySummary(resolveRows(db.getResults(from, to)), from, to, config);
}

const FEEDBACK_KINDS = new Set(['bug', 'feature', 'other']);
// Deliberately loose: one @, a dot in the domain, no spaces. The point is to
// catch a typo, not to adjudicate RFC 5322 — a wrong-but-valid address gets
// through either way, and the browser's type="email" already did a first pass.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ponytail: one global cap, not per-IP. Behind nginx every request arrives from
// 127.0.0.1 unless trust-proxy is wired up, so per-IP buys nothing here. Ceiling:
// a spammer can lock the form for an hour; add trust proxy + per-IP if that ever happens.
const recentFeedback = [];
function feedbackRateLimited() {
  const cutoff = Date.now() - 3600e3;
  while (recentFeedback.length && recentFeedback[0] < cutoff) recentFeedback.shift();
  return recentFeedback.length >= 30;
}

// Seasons are back-to-back date ranges over the same results: each runs to the
// day before the next one starts, and the newest started one runs to today. One
// that hasn't started is left out, so the next season can be added ahead of time.
function seasonsAsOf(list, today) {
  const started = list.filter((s) => s.from <= today);
  const dayBefore = (ymd) => new Date(Date.parse(ymd) - 864e5).toISOString().slice(0, 10); // UTC: no DST skew
  return started.map((s, i) => ({ id: i + 1, ...s, to: started[i + 1] ? dayBefore(started[i + 1].from) : today }));
}

function createApp(db, status) {
  const app = express();
  app.use(express.json({ limit: '12mb' })); // WhatsApp exports run ~1MB of text

  // ---- Photo uploads (people stories). Random server-side names; client names never used.
  const UPLOADS = path.join(path.dirname(config.DB_PATH), 'uploads');
  const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  // Random names never change content, so cache forever.
  // ponytail: photos served at original size; add resizing if page weight ever hurts.
  app.use('/uploads', friendsAuth, express.static(UPLOADS, { maxAge: '365d', immutable: true }));

  app.post('/api/upload', basicAuth, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
    const ext = IMG_EXT[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'jpeg/png/webp/gif only' });
    }
    const file = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, file), req.body);
    res.json({ file });
  });

  // ---- Custom games (isolated module: src/game/, data/game.db). ----
  app.use('/game', require('./game/routes')({ basicAuth }));

  // The live season's theme goes on <html> server-side, so the page never flashes the
  // default look while it waits for /api/standings.
  app.get('/', (_req, res) => {
    const { theme } = seasonsAsOf(config.SEASONS, toDateStr(new Date())).at(-1);
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'scoreboard.html'), 'utf8');
    res.type('html').send(theme ? html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`) : html);
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
    const seasons = seasonsAsOf(config.SEASONS, toDateStr(new Date()));
    const season = seasons.find((s) => String(s.id) === req.query.season) || seasons.at(-1);
    const from = req.query.from || season.from;
    const to = req.query.to || season.to;
    const rows = resolveRows(db.getResults(from, to));
    res.json({
      range: { from, to },
      season,
      seasons,
      ...computeStandings(rows, config),
      history: dailyHistory(rows),
      updatedAt: new Date().toISOString(),
    });
  });

  // ---- Feedback (public form; admin reads it at /admin/feedback). ----
  app.get('/feedback', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'feedback.html'));
  });

  app.post('/api/feedback', (req, res) => {
    const b = req.body || {};
    const kind = FEEDBACK_KINDS.has(b.kind) ? b.kind : null;
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 4000) : '';
    const sender = typeof b.sender === 'string' ? b.sender.trim().slice(0, 80) : '';
    const email = typeof b.email === 'string' ? b.email.trim().slice(0, 120) : '';
    if (!kind || !message || !sender) return res.status(400).json({ error: 'name, kind and message required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'a valid email is required' });
    if (feedbackRateLimited()) return res.status(429).json({ error: 'too many just now — try later' });
    recentFeedback.push(Date.now());
    const row = { kind, message, sender, email, created_at: new Date().toISOString() };
    db.addFeedback(row);
    // Stored first, mailed after, and never awaited: the report is safe in the DB
    // whatever SMTP does, and the sender shouldn't wait on a handshake to see
    // "thanks". Failures are logged inside sendFeedbackMail.
    // .catch is not belt-and-braces: an unhandled rejection takes the process
    // down, so a throw anywhere in the mail path would kill the bot over a
    // notification. sendFeedbackMail swallows SMTP errors; this covers the rest.
    Promise.resolve()
      .then(() => mail.sendFeedbackMail(row))
      .catch((err) => console.error('[feedback] notification failed:', err.message));
    res.json({ ok: true });
  });

  app.get('/admin/feedback', basicAuth, (_req, res) => {
    const rows = db.listFeedback();
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // ponytail: rendered here rather than another fetch-and-render view file —
    // it's a read-only list. Give it its own page if it ever needs filters.
    const items = rows.map((r) => `<li><b>${esc(r.kind)}</b> · <time>${esc(r.created_at.slice(0, 16).replace('T', ' '))}</time>`
      + `${r.sender ? ` · ${esc(r.sender)}` : ''}`
      + `${r.email ? ` · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}`
      + `<p>${esc(r.message)}</p></li>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapTap · Feedback</title><style>
:root{color-scheme:dark}body{margin:0;padding:48px 20px;background:radial-gradient(1200px 800px at 50% -5%,#0a1030,#070b1c 70%);color:#eaf0ff;font:15px/1.55 "Inter",-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:680px;margin:0 auto}a{color:#98a4d4;text-decoration:none;font-family:ui-monospace,Menlo,monospace}a:hover{color:#22d3ee}
h1{font-family:ui-monospace,Menlo,monospace;font-size:1.15rem;letter-spacing:.12em;text-transform:uppercase;color:#22d3ee;margin:12px 0 20px}
ul{list-style:none;padding:0;display:grid;gap:14px}li{background:rgba(16,22,52,.9);border:1px solid rgba(130,155,255,.16);border-radius:16px;padding:16px 20px}
b{color:#22d3ee;text-transform:uppercase;font-size:.78rem;letter-spacing:.08em}time{color:#98a4d4;font-size:.8rem}p{margin:8px 0 0;white-space:pre-wrap}
.empty{color:#98a4d4;text-align:center;padding:40px 0}</style>
<div class="wrap"><a href="/admin">← Admin</a><h1>Feedback (${rows.length})</h1>
${items ? `<ul>${items}</ul>` : '<p class="empty">Nothing yet.</p>'}</div>`);
  });

  // ---- Globe easter egg (FRIENDS_TOKEN: names, birth coords, stories and faces). ----
  app.get('/globe', friendsAuth, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'globe.html'));
  });

  // Point layers for the globe page. One layer today; future point sets
  // (custom places, visited cities, …) are just more entries in `layers` —
  // the page renders whatever arrives.
  app.get('/api/globe', friendsAuth, (_req, res) => {
    const points = users.get().users
      .filter((u) => u.active && Number.isFinite(u.lat))
      .map((u) => ({
        label: u.name,
        ...(u.city ? { city: u.city } : {}),
        ...(u.country ? { country: u.country } : {}),
        lat: u.lat,
        lng: u.lng,
        ...(u.story ? { story: u.story } : {}),
        ...(u.photos ? { photos: u.photos } : {}),
      }));
    res.json({ layers: [{ id: 'birthplaces', label: 'Born in', points }] });
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

module.exports = { createApp, basicAuth, seasonsAsOf };
