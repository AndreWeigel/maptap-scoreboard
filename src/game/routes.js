// The game's whole HTTP surface, mounted at /game from src/web.js with one
// line. Depends on the host only for basicAuth (and /api/upload for photos).
const path = require('node:path');
const express = require('express');
const { openGameDb } = require('./db');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
// Same pattern the host's upload endpoint generates; duplicated on purpose
// (no imports from host code — the module must stay liftable).
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// Round from the builder → clean row, or null if invalid.
function cleanRound(r) {
  if (!r || typeof r !== 'object') return null;
  const question = optStr(r.question);
  if (!question) return null;
  if (!Number.isFinite(r.lat) || Math.abs(r.lat) > 90) return null;
  if (!Number.isFinite(r.lng) || Math.abs(r.lng) > 180) return null;
  if (r.photo != null && !PHOTO_FILE.test(r.photo)) return null;
  // radius: optional "full points within this many km" tolerance (trivia rounds)
  if (r.radius != null && !(Number.isFinite(r.radius) && r.radius > 0 && r.radius <= 10000)) return null;
  return {
    question, lat: r.lat, lng: r.lng,
    city: optStr(r.city), country: optStr(r.country),
    photo: r.photo || undefined, story: optStr(r.story),
    answer: optStr(r.answer), radius: r.radius ?? undefined,
  };
}

module.exports = function gameRoutes({ basicAuth, dbPath = 'data/game.db' }) {
  const db = openGameDb(dbPath);
  const router = express.Router();

  router.get('/admin', basicAuth, (_req, res) => res.sendFile(path.join(VIEWS, 'builder.html')));

  router.get('/api/admin/games', basicAuth, (_req, res) => res.json({ games: db.listGames() }));

  router.post('/api/admin/games', basicAuth, (req, res) => {
    const title = optStr(req.body && req.body.title);
    if (!title) return res.status(400).json({ error: 'title required' });
    res.json(db.createGame(title));
  });

  router.get('/api/admin/games/:id', basicAuth, (req, res) => {
    const g = db.getGame(+req.params.id);
    if (!g) return res.status(404).json({ error: 'no such game' });
    res.json(g);
  });

  router.put('/api/admin/games/:id', basicAuth, (req, res) => {
    if (!db.getGame(+req.params.id)) return res.status(404).json({ error: 'no such game' });
    const b = req.body || {};
    const title = optStr(b.title);
    const rounds = Array.isArray(b.rounds) ? b.rounds.map(cleanRound) : null;
    if (!title || !rounds || rounds.includes(null)) {
      return res.status(400).json({ error: 'invalid title or rounds' });
    }
    res.json(db.saveGame(+req.params.id, title, rounds));
  });

  router.delete('/api/admin/games/:id', basicAuth, (req, res) => {
    if (!db.deleteGame(+req.params.id).deleted) return res.status(404).json({ error: 'no such game' });
    res.json({ deleted: true });
  });

  // Share link. Slice 3 replaces this placeholder with the real play page.
  router.get('/:slug', (req, res) => {
    const game = db.raw.prepare('SELECT title FROM games WHERE slug = ?').get(req.params.slug);
    if (!game) return res.status(404).send('No such game.');
    res.send(`<!doctype html><meta charset="utf-8"><title>${esc(game.title)}</title>
      <body style="font:16px system-ui;background:#070b1c;color:#eaf0ff;display:grid;place-items:center;min-height:100vh;margin:0">
      <p>${esc(game.title)} — play page coming soon.</p></body>`);
  });

  return router;
};
