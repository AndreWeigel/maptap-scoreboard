// Live sessions: the host-driven, everyone-at-once way to play a custom game.
// Mounted inside the game router (before its /:slug catch-all). Depends on the
// host only for basicAuth and the uploads folder.
const path = require('node:path');
const express = require('express');
const { revealedOrds } = require('./db');
const { points, distanceToRound } = require('./scoring');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/; // duplicated on purpose (module stays liftable)

const validCoords = (lat, lng) =>
  Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;

// The one payload every live page renders from. Truth + guesses only once revealed.
function baseSnapshot(db, session) {
  const { game, rounds } = db.getGame(session.game_id);
  const inRound = session.state === 'open' || session.state === 'revealed';
  const round = inRound ? rounds.find((r) => r.ord === session.current_ord) || null : null;
  const guesses = round ? db.listGuesses(session.id, round.ord) : [];
  const answered = new Set(guesses.map((g) => g.player_id));
  const players = db.listPlayers(session.id).map((p) => ({ id: p.id, name: p.name, answered: answered.has(p.id) }));
  let reveal = null;
  if (session.state === 'revealed' && round) {
    const { lat, lng, city, country, photo, story, answer, geometry } = round;
    reveal = {
      truth: { lat, lng, city, country, photo, story, answer, geometry: geometry || null },
      guesses: guesses.map((g) => ({
        playerId: g.player_id, name: g.name, lat: g.lat, lng: g.lng, km: g.km, points: g.points,
        nearest: distanceToRound(g.lat, g.lng, round).nearest, // computed at reveal time, not stored
      })),
    };
  }
  const standings = db.standings(session.id, revealedOrds(session, rounds))
    .map((s) => ({ playerId: s.player_id, name: s.name, total: s.total }));
  return {
    code: session.code, title: game.title, state: session.state, roundCount: rounds.length,
    round: round ? { ord: round.ord, question: round.question } : null,
    players, reveal, standings, you: null,
  };
}

// Stamp the per-connection `you` onto a token-independent base snapshot.
function withYou(db, session, base, token) {
  const me = token ? db.playerByToken(token) : null;
  const you = me && me.session_id === session.id ? { playerId: me.id, name: me.name } : null;
  return { ...base, you };
}

const snapshot = (db, session, token) => withYou(db, session, baseSnapshot(db, session), token);

module.exports = function liveRoutes({ basicAuth, db, uploadsDir }) {
  const router = express.Router();
  const UPLOADS = path.resolve(uploadsDir); // res.sendFile needs an absolute path; production passes a relative one
  // code → Set<{ res, token }>. The only in-memory state; rebuilds itself as clients reconnect.
  const streams = new Map();
  const send = (res, snap) => res.write(`event: state\ndata: ${JSON.stringify(snap)}\n\n`);
  const broadcast = (code) => {
    const set = streams.get(code);
    const s = set && set.size ? db.getSession(code) : null;
    if (!s) return;
    const base = baseSnapshot(db, s); // once per broadcast; only `you` differs per client
    for (const c of set) {
      try { send(c.res, withYou(db, s, base, c.token)); }
      catch { set.delete(c); } // dead stream: drop it, keep fanning out to the rest
    }
  };

  const load = (req, res) => {
    const s = db.getSession(req.params.code);
    if (!s) res.status(404).json({ error: 'no such session' });
    return s;
  };
  const tokenOf = (req) => (typeof req.query.token === 'string' ? req.query.token : null);

  // ---- Admin: create / list / drive ----
  router.post('/api/admin/games/:id/sessions', basicAuth, (req, res) => {
    const g = db.getGame(+req.params.id);
    if (!g) return res.status(404).json({ error: 'no such game' });
    if (!g.rounds.length) return res.status(400).json({ error: 'game has no rounds' });
    res.json({ code: db.createSession(g.game.id).code });
  });
  router.get('/api/admin/games/:id/sessions', basicAuth, (req, res) => {
    if (!db.getGame(+req.params.id)) return res.status(404).json({ error: 'no such game' });
    res.json({ sessions: db.listSessions(+req.params.id) });
  });
  router.post('/api/admin/sessions/:code/next', basicAuth, (req, res) => {
    let s;
    try { s = db.advanceSession(req.params.code); }
    catch (e) { if (e instanceof RangeError) return res.status(400).json({ error: 'session finished' }); throw e; }
    if (!s) return res.status(404).json({ error: 'no such session' });
    broadcast(s.code);
    res.json(snapshot(db, s, null));
  });
  router.post('/api/admin/sessions/:code/end', basicAuth, (req, res) => {
    const s = db.endSession(req.params.code);
    if (!s) return res.status(404).json({ error: 'no such session' });
    broadcast(s.code);
    res.json(snapshot(db, s, null));
  });
  router.get('/host/:code', basicAuth, (req, res) => {
    if (!db.getSession(req.params.code)) return res.status(404).send('No such session.');
    res.sendFile(path.join(VIEWS, 'live.html'));
  });

  // ---- Public: the code is the access control ----
  router.get('/live/:code', (req, res) => {
    if (!db.getSession(req.params.code)) return res.status(404).send('No such session.');
    res.sendFile(path.join(VIEWS, 'live.html'));
  });
  router.get('/live/api/:code', (req, res) => {
    const s = load(req, res); if (!s) return;
    const { game, rounds } = db.getGame(s.game_id);
    res.json({ title: game.title, roundCount: rounds.length, state: s.state });
  });
  router.post('/live/api/:code/join', (req, res) => {
    const s = load(req, res); if (!s) return;
    const name = typeof (req.body || {}).name === 'string' ? req.body.name.trim().slice(0, 40) : '';
    if (!name) return res.status(400).json({ error: 'name required' });
    let p;
    try { p = db.joinSession(s.id, name); }
    catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'name taken' });
      throw e;
    }
    broadcast(s.code);
    res.json({ token: p.token, playerId: p.id, name: p.name });
  });
  router.post('/live/api/:code/guess', (req, res) => {
    const s = load(req, res); if (!s) return;
    const b = req.body || {};
    const me = typeof b.token === 'string' ? db.playerByToken(b.token) : null;
    if (!me || me.session_id !== s.id) return res.status(401).json({ error: 'bad token' });
    if (s.state !== 'open' || b.ord !== s.current_ord) return res.status(409).json({ error: 'round not open' });
    if (!validCoords(b.lat, b.lng)) return res.status(400).json({ error: 'bad coords' });
    const round = db.getGame(s.game_id).rounds.find((r) => r.ord === s.current_ord);
    const { km } = distanceToRound(b.lat, b.lng, round);
    db.upsertGuess(s.id, me.id, round.ord, { lat: b.lat, lng: b.lng, km, points: points(km, round.radius ?? undefined) });
    broadcast(s.code);
    res.json({ ok: true }); // nothing about the truth leaves the server before reveal
  });
  router.get('/live/api/:code/state', (req, res) => {
    const s = load(req, res); if (!s) return;
    res.json(snapshot(db, s, tokenOf(req)));
  });
  router.get('/live/api/:code/events', (req, res) => {
    const s = load(req, res); if (!s) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no', // nginx: don't buffer this response
    });
    const client = { res, token: tokenOf(req) };
    if (!streams.has(s.code)) streams.set(s.code, new Set());
    streams.get(s.code).add(client);
    send(res, snapshot(db, s, client.token));
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(ping); streams.get(s.code)?.delete(client); }
    }, 25000);
    ping.unref();
    req.on('close', () => { clearInterval(ping); streams.get(s.code)?.delete(client); });
  });

  // Round photos live behind the friends password at /uploads; a live session
  // may show a photo once its round is revealed, and only that photo.
  router.get('/live/api/:code/photo/:file', (req, res) => {
    const s = db.getSession(req.params.code);
    const file = req.params.file;
    if (!s || !PHOTO_FILE.test(file)) return res.status(404).end();
    const { rounds } = db.getGame(s.game_id);
    const shown = new Set(revealedOrds(s, rounds));
    if (!rounds.some((r) => shown.has(r.ord) && r.photo === file)) return res.status(404).end();
    res.sendFile(path.join(UPLOADS, file), { maxAge: '1h' }, (err) => { if (err) res.status(404).end(); });
  });

  return router;
};
module.exports.snapshot = snapshot;
