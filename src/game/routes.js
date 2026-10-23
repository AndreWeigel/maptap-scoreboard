// The game's whole HTTP surface, mounted at /game from src/web.js with one
// line. Depends on the host only for basicAuth (and /api/upload for photos).
const path = require('node:path');
const express = require('express');
const { openGameDb } = require('./db');
const { points, distanceToRound } = require('./scoring');
const { normalizeGeometry, bboxCenter } = require('./geo');
const liveRoutes = require('./live');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
// Same pattern the host's upload endpoint generates; duplicated on purpose
// (no imports from host code — the module must stay liftable).
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/;

const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const validCoords = (lat, lng) =>
  Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;

// Round from the builder → { round } with a clean row, or { error } with the message to show.
function cleanRound(r) {
  if (!r || typeof r !== 'object') return { error: 'invalid round' };
  const question = optStr(r.question);
  if (!question) return { error: 'invalid round' };
  let geometry = normalizeGeometry(r.geometry);
  if (geometry && geometry.error) return geometry;
  let { lat, lng } = r;
  if (geometry && geometry.type === 'Point') { [lng, lat] = geometry.coordinates; geometry = null; } // a point is a point round
  else if (geometry) ({ lat, lng } = bboxCenter(geometry)); // the anchor can never disagree with the shape
  if (!validCoords(lat, lng)) return { error: 'invalid round' };
  if (r.photo != null && !PHOTO_FILE.test(r.photo)) return { error: 'invalid round' };
  // radius: optional "full points within this many km" tolerance (trivia rounds)
  if (r.radius != null && !(Number.isFinite(r.radius) && r.radius > 0 && r.radius <= 10000)) return { error: 'invalid round' };
  return { round: {
    question, lat, lng,
    city: optStr(r.city), country: optStr(r.country),
    photo: r.photo || undefined, story: optStr(r.story),
    answer: optStr(r.answer), radius: r.radius ?? undefined,
    geometry: geometry || undefined,
  } };
}

module.exports = function gameRoutes({ basicAuth, dbPath = 'data/game.db', uploadsDir = 'data/uploads' }) {
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
    if (!title || !Array.isArray(b.rounds)) return res.status(400).json({ error: 'invalid title or rounds' });
    const cleaned = b.rounds.map(cleanRound);
    const bad = cleaned.findIndex((c) => c.error);
    if (bad !== -1) {
      const error = cleaned[bad].error === 'invalid round' ? 'invalid title or rounds' : cleaned[bad].error;
      return res.status(400).json({ error, round: bad });
    }
    res.json(db.saveGame(+req.params.id, title, cleaned.map((c) => c.round)));
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
    const { km, nearest } = distanceToRound(b.lat, b.lng, round);
    const { question, ord, game_id, id, ...truth } = round;
    res.json({ km, nearest, points: points(km, round.radius ?? undefined), truth });
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
      const { km } = distanceToRound(x.lat, x.lng, r);
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

  // Live sessions (src/game/live.js) — before the /:slug catch-all so /live/… and /host/… resolve.
  router.use(liveRoutes({ basicAuth, db, uploadsDir }));

  // The share link: the play page itself (fetches its data from /game/api/:slug).
  router.get('/:slug', (req, res) => {
    if (!db.getGameBySlug(req.params.slug)) return res.status(404).send('No such game.');
    res.sendFile(path.join(VIEWS, 'play.html'));
  });

  return router;
};
