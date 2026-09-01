// The game's whole HTTP surface, mounted at /game from src/web.js with one
// line. Depends on the host only for basicAuth (and /api/upload for photos).
const path = require('node:path');
const express = require('express');
const { openGameDb } = require('./db');
const { haversineKm, points } = require('./scoring');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
// Same pattern the host's upload endpoint generates; duplicated on purpose
// (no imports from host code — the module must stay liftable).
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/;

const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const validCoords = (lat, lng) =>
  Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;

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

  // ---- Public play API (the slug is the access control; scoring is server-side only). ----
  router.get('/api/:slug', (req, res) => {
    const g = db.getGameBySlug(req.params.slug);
    if (!g) return res.status(404).json({ error: 'no such game' });
    res.json({ title: g.game.title, rounds: g.rounds.map((r) => ({ ord: r.ord, question: r.question })) });
  });

  // Stateless per-round reveal: the client sends a guess, gets truth + score.
  // Fetching truths without guessing is possible — honor system by design.
  router.post('/api/:slug/guess', (req, res) => {
    const g = db.getGameBySlug(req.params.slug);
    if (!g) return res.status(404).json({ error: 'no such game' });
    const b = req.body || {};
    const round = g.rounds.find((r) => r.ord === b.ord);
    if (!round) return res.status(404).json({ error: 'no such round' });
    if (!validCoords(b.lat, b.lng)) return res.status(400).json({ error: 'bad coords' });
    const km = Math.round(haversineKm(b.lat, b.lng, round.lat, round.lng) * 10) / 10;
    const { question, ord, game_id, id, ...truth } = round;
    res.json({ km, points: points(km, round.radius ?? undefined), truth });
  });

  // Final submit: every point is recomputed here — client totals are never trusted.
  router.post('/api/:slug/plays', (req, res) => {
    const g = db.getGameBySlug(req.params.slug);
    if (!g) return res.status(404).json({ error: 'no such game' });
    const b = req.body || {};
    const name = typeof b.player_name === 'string' ? b.player_name.trim().slice(0, 40) : '';
    const guesses = Array.isArray(b.guesses) ? b.guesses : [];
    const byOrd = new Map(guesses.filter((x) => x && validCoords(x.lat, x.lng)).map((x) => [x.ord, x]));
    if (!name || g.rounds.some((r) => !byOrd.has(r.ord)) || byOrd.size !== g.rounds.length) {
      return res.status(400).json({ error: 'name and one valid guess per round required' });
    }
    const scored = g.rounds.map((r) => {
      const x = byOrd.get(r.ord);
      const km = Math.round(haversineKm(x.lat, x.lng, r.lat, r.lng) * 10) / 10;
      return { round_ord: r.ord, lat: x.lat, lng: x.lng, km, points: points(km, r.radius ?? undefined) };
    });
    const total = scored.reduce((s, x) => s + x.points, 0);
    try {
      db.recordPlay(g.game.id, name, total, scored);
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'already played', leaderboard: db.listPlays(g.game.id) });
      }
      throw e;
    }
    res.json({ total, rounds: scored, leaderboard: db.listPlays(g.game.id) });
  });

  router.get('/api/:slug/leaderboard', (req, res) => {
    const g = db.getGameBySlug(req.params.slug);
    if (!g) return res.status(404).json({ error: 'no such game' });
    res.json({ leaderboard: db.listPlays(g.game.id) });
  });

  // The share link: the play page itself (fetches its data from /game/api/:slug).
  router.get('/:slug', (req, res) => {
    if (!db.getGameBySlug(req.params.slug)) return res.status(404).send('No such game.');
    res.sendFile(path.join(VIEWS, 'play.html'));
  });

  return router;
};
