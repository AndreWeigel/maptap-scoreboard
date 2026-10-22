# Live Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host runs a custom game live over a video call: players join by link, everyone taps the same round at once, the host reveals, every screen shows the truth plus everyone's pins and a ranking, and the session ends on a final scoreboard.

**Architecture:** Three new tables in the existing `data/game.db` hold sessions, players and guesses; a four-state machine (`lobby → open → revealed → … → finished`) is moved only by the host. A new `src/game/live.js` router owns the public join/guess/state endpoints, the admin create/next/end endpoints, a Server-Sent Events stream that pushes one full snapshot to every open page on each change, and a session-scoped photo route. One new page `views/game/live.html` renders players and host from that snapshot; the builder gains a "Go live" button.

**Tech Stack:** Node ≥ 20, Express 4, better-sqlite3, Server-Sent Events (no new dependency), MapLibre GL 6.6.0 globe (CDN ESM), `node --test`, headless Chrome screenshots.

**Spec:** `docs/superpowers/specs/2026-10-22-live-sessions-design.md`

## Global Constraints

- Work in a git worktree (`git worktree add .claude/worktrees/live-sessions -b live-sessions` from local HEAD, then `npm install` inside it — native better-sqlite3).
- Run tests as `node --test test/` (bare `node --test` picks up stray worktrees).
- The game module stays liftable: no imports from host code beyond `basicAuth`; the only new dep passed in is `uploadsDir`. One mount line in `src/web.js`.
- Session code: `crypto.randomBytes(5).toString('hex')` (10 chars). Player token: `crypto.randomBytes(16).toString('hex')`.
- Scoring: `haversineKm` + `points(km, radius)` from `src/game/scoring.js`, unchanged. Points computed when the guess lands, hidden until reveal.
- Names: trimmed, max 40 chars, unique per session case-insensitively.
- "Revealed rounds": `lobby` → none; `open` → ord < current_ord; `revealed` → ord ≤ current_ord; `finished` → all. One helper `revealedOrds(session, rounds)`.
- SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Ping comment every 25 s.
- Untrusted text (names, questions, answers, stories) goes into the DOM via `createElement` / `textContent` only.
- Screenshots: headless Chrome, no `--disable-gpu`, real-time wait via the `/slow` gif trick (handover lesson 3).
- Commit messages: plain subject, no attribution trailers.

---

### Task 1: Session store in `src/game/db.js`

**Files:**
- Modify: `src/game/db.js` (SCHEMA string at top; the returned store object; `module.exports`)
- Test: `test/game-db.test.js` (append)

**Interfaces:**
- Consumes: existing `openGameDb(dbPath)` store (`createGame`, `saveGame`, `getGame`).
- Produces, on the store object:
  - `createSession(gameId) → session` where `session = { id, game_id, code, state, current_ord, created_at, finished_at }`
  - `getSession(code) → session | null`
  - `listSessions(gameId) → [{ code, state, current_ord, players, created_at, finished_at }]` newest first
  - `advanceSession(code) → session | null`; throws `RangeError('session finished')` when already finished
  - `endSession(code) → session | null`
  - `joinSession(sessionId, name) → { id, name, token }`; throws `SQLITE_CONSTRAINT*` on a duplicate name
  - `playerByToken(token) → { id, session_id, name } | null`
  - `listPlayers(sessionId) → [{ id, name, joined_at }]` in join order
  - `upsertGuess(sessionId, playerId, ord, { lat, lng, km, points })`
  - `listGuesses(sessionId, ord) → [{ player_id, name, lat, lng, km, points }]` by km asc
  - `standings(sessionId, ords) → [{ player_id, name, total }]` total desc, then join order; players without guesses total 0
- Produces, as a module export: `revealedOrds(session, rounds) → number[]`

- [ ] **Step 1: Write the failing tests** — append to `test/game-db.test.js`:

```js
const { revealedOrds } = require('../src/game/db');

function seedGame(db) {
  const g = db.createGame('trains');
  db.saveGame(g.id, 'trains', [
    round('Highest station?', 33.0106, 91.6642, { radius: 20, answer: 'Tanggula' }),
    round('First railway?', 54.9, -1.6),
    round('Longest tunnel?', 46.5, 8.6),
  ]);
  return g;
}

test('createSession starts in lobby with a 10-char code; listSessions counts players', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  assert.match(s.code, /^[a-f0-9]{10}$/);
  assert.equal(s.state, 'lobby');
  assert.equal(s.current_ord, null);
  assert.deepEqual(db.getSession(s.code), s);
  assert.equal(db.getSession('nope'), null);
  db.joinSession(s.id, 'Fer');
  const list = db.listSessions(g.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].code, s.code);
  assert.equal(list[0].players, 1);
});

test('advanceSession walks lobby → open → revealed → … → finished; end jumps to finished', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const step = () => { const n = db.advanceSession(s.code); return [n.state, n.current_ord]; };
  assert.deepEqual(step(), ['open', 0]);
  assert.deepEqual(step(), ['revealed', 0]);
  assert.deepEqual(step(), ['open', 1]);
  assert.deepEqual(step(), ['revealed', 1]);
  assert.deepEqual(step(), ['open', 2]);
  assert.deepEqual(step(), ['revealed', 2]);
  assert.deepEqual(step(), ['finished', 2]);
  assert.ok(db.getSession(s.code).finished_at);
  assert.throws(() => db.advanceSession(s.code), RangeError);
  assert.equal(db.advanceSession('nope'), null);

  const s2 = db.createSession(g.id);
  db.advanceSession(s2.code);
  const ended = db.endSession(s2.code);
  assert.equal(ended.state, 'finished');
  assert.ok(ended.finished_at);
  assert.equal(db.endSession('nope'), null);
});

test('joinSession: token per player, names unique per session (case-insensitive), playerByToken', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer');
  assert.match(fer.token, /^[a-f0-9]{32}$/);
  assert.throws(() => db.joinSession(s.id, 'fer'), (e) => String(e.code).startsWith('SQLITE_CONSTRAINT'));
  const other = db.createSession(g.id);
  db.joinSession(other.id, 'Fer'); // same name in another session is fine
  assert.deepEqual(db.playerByToken(fer.token), { id: fer.id, session_id: s.id, name: 'Fer' });
  assert.equal(db.playerByToken('nope'), null);
  assert.deepEqual(db.listPlayers(s.id).map((p) => p.name), ['Fer']);
});

test('upsertGuess keeps the latest tap; listGuesses sorts by km; standings sum revealed rounds only', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer');
  const ana = db.joinSession(s.id, 'Ana');
  db.upsertGuess(s.id, fer.id, 0, { lat: 1, lng: 1, km: 900, points: 10 });
  db.upsertGuess(s.id, fer.id, 0, { lat: 33, lng: 91, km: 12, points: 100 });
  db.upsertGuess(s.id, ana.id, 0, { lat: 30, lng: 90, km: 300, points: 57 });
  db.upsertGuess(s.id, ana.id, 1, { lat: 54, lng: -1, km: 80, points: 90 });
  assert.deepEqual(db.listGuesses(s.id, 0).map((x) => [x.name, x.km, x.points]), [['Fer', 12, 100], ['Ana', 300, 57]]);
  assert.deepEqual(db.standings(s.id, [0]).map((x) => [x.name, x.total]), [['Fer', 100], ['Ana', 57]]);
  assert.deepEqual(db.standings(s.id, [0, 1]).map((x) => [x.name, x.total]), [['Ana', 147], ['Fer', 100]]);
  assert.deepEqual(db.standings(s.id, []).map((x) => [x.name, x.total]), [['Fer', 0], ['Ana', 0]]);
});

test('revealedOrds follows the state', () => {
  const rounds = [{ ord: 0 }, { ord: 1 }, { ord: 2 }];
  assert.deepEqual(revealedOrds({ state: 'lobby', current_ord: null }, rounds), []);
  assert.deepEqual(revealedOrds({ state: 'open', current_ord: 0 }, rounds), []);
  assert.deepEqual(revealedOrds({ state: 'revealed', current_ord: 0 }, rounds), [0]);
  assert.deepEqual(revealedOrds({ state: 'open', current_ord: 2 }, rounds), [0, 1]);
  assert.deepEqual(revealedOrds({ state: 'finished', current_ord: 2 }, rounds), [0, 1, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-db.test.js`
Expected: the five new tests FAIL (`revealedOrds is not a function` / `db.createSession is not a function`).

- [ ] **Step 3: Add the tables to `SCHEMA`** — append inside the template string, after the `guesses` table:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  state       TEXT NOT NULL,
  current_ord INTEGER,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS session_players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  joined_at  TEXT NOT NULL,
  UNIQUE(session_id, name COLLATE NOCASE)
);
CREATE TABLE IF NOT EXISTS session_guesses (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
  round_ord  INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  km REAL NOT NULL, points INTEGER NOT NULL,
  UNIQUE(session_id, player_id, round_ord)
);
```

- [ ] **Step 4: Add `revealedOrds` above `openGameDb`**

```js
// The rounds whose truth may be shown: see the spec's "Revealed rounds" rule.
function revealedOrds(session, rounds) {
  const ords = rounds.map((r) => r.ord).sort((a, b) => a - b);
  if (session.state === 'lobby') return [];
  if (session.state === 'finished') return ords;
  return ords.filter((o) => (session.state === 'revealed' ? o <= session.current_ord : o < session.current_ord));
}
```

- [ ] **Step 5: Add the session statements and store methods** — inside `openGameDb`, after `replaceRounds`, add:

```js
  const now = () => new Date().toISOString();
  const getSession = (code) => db.prepare('SELECT * FROM sessions WHERE code = ?').get(code) || null;
  const roundOrds = (gameId) =>
    db.prepare('SELECT ord FROM rounds WHERE game_id = ? ORDER BY ord').all(gameId).map((r) => r.ord);
  const setState = db.prepare('UPDATE sessions SET state = ?, current_ord = ?, finished_at = ? WHERE id = ?');

  // Host's "Next": lobby → open(first) → revealed → open(next) … → finished.
  const advance = db.transaction((code) => {
    const s = getSession(code);
    if (!s) return null;
    if (s.state === 'finished') throw new RangeError('session finished');
    const ords = roundOrds(s.game_id);
    let state = 'finished', ord = s.current_ord, finishedAt = null;
    if (s.state === 'lobby' && ords.length) { state = 'open'; ord = ords[0]; }
    else if (s.state === 'open') state = 'revealed';
    else if (s.state === 'revealed') {
      const i = ords.indexOf(s.current_ord);
      if (i + 1 < ords.length) { state = 'open'; ord = ords[i + 1]; }
    }
    if (state === 'finished') finishedAt = now();
    setState.run(state, ord, finishedAt, s.id);
    return getSession(code);
  });
  const upsertGuessStmt = db.prepare(`
    INSERT INTO session_guesses (session_id, player_id, round_ord, lat, lng, km, points)
    VALUES (@session_id, @player_id, @round_ord, @lat, @lng, @km, @points)
    ON CONFLICT(session_id, player_id, round_ord) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng, km = excluded.km, points = excluded.points
  `);
```

and these methods on the returned object (after `listPlays`):

```js
    // ---- Live sessions ----
    createSession(gameId) {
      const code = crypto.randomBytes(5).toString('hex'); // the join link IS the access control
      db.prepare('INSERT INTO sessions (game_id, code, state, created_at) VALUES (?, ?, ?, ?)')
        .run(gameId, code, 'lobby', now());
      return getSession(code);
    },
    getSession,
    listSessions(gameId) {
      return db.prepare(`
        SELECT s.code, s.state, s.current_ord, s.created_at, s.finished_at,
          (SELECT COUNT(*) FROM session_players p WHERE p.session_id = s.id) AS players
        FROM sessions s WHERE s.game_id = ? ORDER BY s.id DESC
      `).all(gameId);
    },
    advanceSession(code) { return advance(code); },
    endSession(code) {
      const s = getSession(code);
      if (!s) return null;
      setState.run('finished', s.current_ord, now(), s.id);
      return getSession(code);
    },
    joinSession(sessionId, name) {
      const token = crypto.randomBytes(16).toString('hex');
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO session_players (session_id, name, token, joined_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, name, token, now());
      return { id: Number(lastInsertRowid), name, token };
    },
    playerByToken(token) {
      return db.prepare('SELECT id, session_id, name FROM session_players WHERE token = ?').get(token) || null;
    },
    listPlayers(sessionId) {
      return db.prepare('SELECT id, name, joined_at FROM session_players WHERE session_id = ? ORDER BY id').all(sessionId);
    },
    upsertGuess(sessionId, playerId, ord, g) {
      upsertGuessStmt.run({ session_id: sessionId, player_id: playerId, round_ord: ord,
        lat: g.lat, lng: g.lng, km: g.km, points: g.points });
    },
    listGuesses(sessionId, ord) {
      return db.prepare(`
        SELECT g.player_id, p.name, g.lat, g.lng, g.km, g.points
        FROM session_guesses g JOIN session_players p ON p.id = g.player_id
        WHERE g.session_id = ? AND g.round_ord = ? ORDER BY g.km, p.id
      `).all(sessionId, ord);
    },
    // Cumulative points over the given round ords; everyone who joined appears (0 if no guess).
    standings(sessionId, ords) {
      const list = ords.length ? ords.map(() => '?').join(',') : 'NULL';
      return db.prepare(`
        SELECT p.id AS player_id, p.name, COALESCE(SUM(g.points), 0) AS total
        FROM session_players p
        LEFT JOIN session_guesses g ON g.player_id = p.id AND g.round_ord IN (${list})
        WHERE p.session_id = ? GROUP BY p.id ORDER BY total DESC, p.id
      `).all(...ords, sessionId);
    },
```

Change the export line to `module.exports = { openGameDb, revealedOrds };`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/game-db.test.js`
Expected: all PASS, including the pre-existing ones.

- [ ] **Step 7: Commit**

```bash
git add src/game/db.js test/game-db.test.js
git commit -m "feat(game): session store for live games (sessions, players, guesses, state machine)"
```

---

### Task 2: Live router — snapshot, join, guess, state, admin control, pages

**Files:**
- Create: `src/game/live.js`
- Create: `views/game/live.html` as a placeholder only (`<!doctype html><title>MapTap · Live</title><p>live page coming in Task 5</p>`) so the page routes resolve
- Test: `test/game-live.test.js`

**Interfaces:**
- Consumes: the store from Task 1 (`db.getGame`, `createSession`, `getSession`, `listSessions`, `advanceSession`, `endSession`, `joinSession`, `playerByToken`, `listPlayers`, `upsertGuess`, `listGuesses`, `standings`), `revealedOrds`, `haversineKm`/`points` from `src/game/scoring.js`.
- Produces: `liveRoutes({ basicAuth, db, uploadsDir }) → express.Router` (mounted at `/game` by Task 4). Paths it defines: `GET /live/:code`, `GET /host/:code`, `GET /live/api/:code`, `POST /live/api/:code/join`, `POST /live/api/:code/guess`, `GET /live/api/:code/state`, `POST /api/admin/games/:id/sessions`, `GET /api/admin/games/:id/sessions`, `POST /api/admin/sessions/:code/next`, `POST /api/admin/sessions/:code/end`. Internal: `snapshot(db, session, token)` and `broadcast(code)` (Task 3 fills `broadcast` in; here it is a no-op function hoisted so routes can call it).
- Snapshot shape (exact):
  `{ code, title, state, roundCount, round: { ord, question } | null, players: [{ id, name, answered }], reveal: { truth: { lat, lng, city, country, photo, story, answer }, guesses: [{ playerId, name, lat, lng, km, points }] } | null, standings: [{ playerId, name, total }], you: { playerId, name } | null }`

- [ ] **Step 1: Write the failing tests** — create `test/game-live.test.js`:

```js
process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { basicAuth } = require('../src/web');
const { openGameDb } = require('../src/game/db');
const liveRoutes = require('../src/game/live');

const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };
const json = { 'content-type': 'application/json' };
const adminJson = { ...auth, ...json };

async function withServer(fn) {
  const db = openGameDb(':memory:');
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-uploads-'));
  const app = express();
  app.use(express.json());
  app.use('/game', liveRoutes({ basicAuth, db, uploadsDir }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const g = db.createGame('Trains');
  db.saveGame(g.id, 'Trains', [
    { question: 'Highest station?', lat: 33.0106, lng: 91.6642, radius: 20, answer: 'Tanggula', photo: 'a1b2c3d4e5f60718.jpg' },
    { question: 'First railway?', lat: 54.9, lng: -1.6 },
  ]);
  fs.writeFileSync(path.join(uploadsDir, 'a1b2c3d4e5f60718.jpg'), 'notreallyajpeg');
  try { return await fn({ base, db, game: g, uploadsDir }); }
  finally { server.closeAllConnections(); server.close(); }
}
const post = (url, body, headers = json) =>
  fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
const next = (base, code) => post(`${base}/game/api/admin/sessions/${code}/next`, undefined, auth);

test('admin session endpoints require auth; create → lobby; list per game', async () => {
  await withServer(async ({ base, game }) => {
    assert.equal((await post(`${base}/game/api/admin/games/${game.id}/sessions`)).status, 401);
    const r = await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth);
    assert.equal(r.status, 200);
    const { code } = await r.json();
    assert.match(code, /^[a-f0-9]{10}$/);
    const list = await (await fetch(`${base}/game/api/admin/games/${game.id}/sessions`, { headers: auth })).json();
    assert.equal(list.sessions[0].code, code);
    assert.equal(list.sessions[0].state, 'lobby');
    assert.equal((await post(`${base}/game/api/admin/games/999/sessions`, undefined, auth)).status, 404);
    assert.equal((await fetch(`${base}/game/host/${code}`)).status, 401);
    assert.equal((await fetch(`${base}/game/host/${code}`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/game/live/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/game/live/nope`)).status, 404);
  });
});

test('a game with no rounds cannot go live', async () => {
  await withServer(async ({ base, db }) => {
    const empty = db.createGame('empty');
    assert.equal((await post(`${base}/game/api/admin/games/${empty.id}/sessions`, undefined, auth)).status, 400);
  });
});

test('join: token, duplicate name 409, bad name 400; state shows you', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const info = await (await fetch(`${base}/game/live/api/${code}`)).json();
    assert.deepEqual(info, { title: 'Trains', roundCount: 2, state: 'lobby' });
    const j = await post(`${base}/game/live/api/${code}/join`, { name: '  Fer ' });
    assert.equal(j.status, 200);
    const fer = await j.json();
    assert.equal(fer.name, 'Fer');
    assert.match(fer.token, /^[a-f0-9]{32}$/);
    assert.equal((await post(`${base}/game/live/api/${code}/join`, { name: 'fer' })).status, 409);
    assert.equal((await post(`${base}/game/live/api/${code}/join`, { name: '   ' })).status, 400);
    assert.equal((await post(`${base}/game/live/api/nope/join`, { name: 'x' })).status, 404);
    const snap = await (await fetch(`${base}/game/live/api/${code}/state?token=${fer.token}`)).json();
    assert.equal(snap.state, 'lobby');
    assert.equal(snap.round, null);
    assert.equal(snap.reveal, null);
    assert.deepEqual(snap.players, [{ id: fer.playerId, name: 'Fer', answered: false }]);
    assert.deepEqual(snap.you, { playerId: fer.playerId, name: 'Fer' });
    assert.deepEqual(snap.standings, [{ playerId: fer.playerId, name: 'Fer', total: 0 }]);
    const anon = await (await fetch(`${base}/game/live/api/${code}/state`)).json();
    assert.equal(anon.you, null);
  });
});

test('guess only while open and for the current round; upsert; hidden until reveal', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    const ana = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Ana' })).json();
    const guess = (token, ord, lat, lng) => post(`${base}/game/live/api/${code}/guess`, { token, ord, lat, lng });

    assert.equal((await guess(fer.token, 0, 33, 91)).status, 409); // lobby
    let snap = await (await next(base, code)).json();
    assert.equal(snap.state, 'open');
    assert.deepEqual(snap.round, { ord: 0, question: 'Highest station?' });
    assert.equal(snap.reveal, null);

    assert.equal((await guess('badtoken', 0, 33, 91)).status, 401);
    assert.equal((await guess(fer.token, 1, 33, 91)).status, 409); // wrong round
    assert.equal((await guess(fer.token, 0, 95, 91)).status, 400); // bad coords
    const ok = await guess(fer.token, 0, 10, 10);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true }); // no km/points/truth leak
    assert.equal((await guess(fer.token, 0, 33.0106, 91.6642)).status, 200); // re-tap replaces
    assert.equal((await guess(ana.token, 0, 30, 90)).status, 200);

    snap = await (await fetch(`${base}/game/live/api/${code}/state?token=${fer.token}`)).json();
    assert.deepEqual(snap.players.map((p) => [p.name, p.answered]), [['Fer', true], ['Ana', true]]);
    assert.equal(snap.reveal, null);
    assert.deepEqual(snap.standings.map((s) => s.total), [0, 0]);

    snap = await (await next(base, code)).json();
    assert.equal(snap.state, 'revealed');
    assert.equal(snap.reveal.truth.answer, 'Tanggula');
    assert.equal(snap.reveal.truth.lat, 33.0106);
    assert.equal(snap.reveal.truth.photo, 'a1b2c3d4e5f60718.jpg');
    assert.equal('question' in snap.reveal.truth, false);
    assert.deepEqual(snap.reveal.guesses.map((x) => [x.name, x.km, x.points]), [['Fer', 0, 100], ['Ana', snap.reveal.guesses[1].km, snap.reveal.guesses[1].points]]);
    assert.ok(snap.reveal.guesses[1].km > 100);
    assert.deepEqual(snap.standings.map((s) => [s.name, s.total]), [['Fer', 100], ['Ana', snap.reveal.guesses[1].points]]);
    assert.equal((await guess(fer.token, 0, 1, 1)).status, 409); // closed after reveal
  });
});

test('late joiner scores 0 on earlier rounds; finished → 400 on next; end from any state', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    await next(base, code); // open 0
    await post(`${base}/game/live/api/${code}/guess`, { token: fer.token, ord: 0, lat: 33.0106, lng: 91.6642 });
    await next(base, code); // revealed 0
    await next(base, code); // open 1
    const late = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Late' })).json();
    await post(`${base}/game/live/api/${code}/guess`, { token: late.token, ord: 1, lat: 54.9, lng: -1.6 });
    await next(base, code); // revealed 1
    let snap = await (await next(base, code)).json(); // finished
    assert.equal(snap.state, 'finished');
    assert.equal(snap.round, null);
    assert.deepEqual(snap.standings.map((s) => [s.name, s.total]), [['Fer', 100], ['Late', 100]]);
    assert.equal((await next(base, code)).status, 400);
    assert.equal((await next(base, 'nope')).status, 404);

    const s2 = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    await next(base, s2.code);
    const ended = await (await post(`${base}/game/api/admin/sessions/${s2.code}/end`, undefined, auth)).json();
    assert.equal(ended.state, 'finished');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-live.test.js`
Expected: FAIL with `Cannot find module '../src/game/live'`.

- [ ] **Step 3: Create `src/game/live.js`**

```js
// Live sessions: the host-driven, everyone-at-once way to play a custom game.
// Mounted inside the game router (before its /:slug catch-all). Depends on the
// host only for basicAuth and the uploads folder.
const path = require('node:path');
const express = require('express');
const { revealedOrds } = require('./db');
const { haversineKm, points } = require('./scoring');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/; // duplicated on purpose (module stays liftable)

const validCoords = (lat, lng) =>
  Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;

// The one payload every live page renders from. Truth + guesses only once revealed.
function snapshot(db, session, token) {
  const { game, rounds } = db.getGame(session.game_id);
  const inRound = session.state === 'open' || session.state === 'revealed';
  const round = inRound ? rounds.find((r) => r.ord === session.current_ord) || null : null;
  const guesses = round ? db.listGuesses(session.id, round.ord) : [];
  const answered = new Set(guesses.map((g) => g.player_id));
  const players = db.listPlayers(session.id).map((p) => ({ id: p.id, name: p.name, answered: answered.has(p.id) }));
  let reveal = null;
  if (session.state === 'revealed' && round) {
    const { lat, lng, city, country, photo, story, answer } = round;
    reveal = {
      truth: { lat, lng, city, country, photo, story, answer },
      guesses: guesses.map((g) => ({ playerId: g.player_id, name: g.name, lat: g.lat, lng: g.lng, km: g.km, points: g.points })),
    };
  }
  const standings = db.standings(session.id, revealedOrds(session, rounds))
    .map((s) => ({ playerId: s.player_id, name: s.name, total: s.total }));
  const me = token ? db.playerByToken(token) : null;
  const you = me && me.session_id === session.id ? { playerId: me.id, name: me.name } : null;
  return {
    code: session.code, title: game.title, state: session.state, roundCount: rounds.length,
    round: round ? { ord: round.ord, question: round.question } : null,
    players, reveal, standings, you,
  };
}

module.exports = function liveRoutes({ basicAuth, db, uploadsDir }) {
  const router = express.Router();
  const broadcast = (_code) => {}; // Task 3 replaces this with the SSE fan-out

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
    const km = Math.round(haversineKm(b.lat, b.lng, round.lat, round.lng) * 10) / 10;
    db.upsertGuess(s.id, me.id, round.ord, { lat: b.lat, lng: b.lng, km, points: points(km, round.radius ?? undefined) });
    broadcast(s.code);
    res.json({ ok: true }); // nothing about the truth leaves the server before reveal
  });
  router.get('/live/api/:code/state', (req, res) => {
    const s = load(req, res); if (!s) return;
    res.json(snapshot(db, s, tokenOf(req)));
  });

  return router;
};
module.exports.snapshot = snapshot;
```

- [ ] **Step 4: Create the placeholder `views/game/live.html`** (replaced in Task 5):

```html
<!doctype html><meta charset="utf-8"><title>MapTap · Live</title><p>Live page — built in Task 5.</p>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/game-live.test.js`
Expected: all 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/game/live.js views/game/live.html test/game-live.test.js
git commit -m "feat(game): live session routes — join, guess, state, host control"
```

---

### Task 3: Server-Sent Events stream and the session-scoped photo route

**Files:**
- Modify: `src/game/live.js` (replace the no-op `broadcast`, add two routes)
- Test: `test/game-live.test.js` (append)

**Interfaces:**
- Consumes: `snapshot(db, session, token)` from Task 2.
- Produces: `GET /live/api/:code/events?token=` (SSE; `event: state`, `data: <snapshot JSON>`), `GET /live/api/:code/photo/:file`. `broadcast(code)` now pushes a fresh snapshot to every open stream of that session.

- [ ] **Step 1: Write the failing tests** — append to `test/game-live.test.js`:

```js
// Read one SSE event ("event: …\ndata: …\n\n") from a streaming fetch body.
async function readEvent(reader, buf) {
  for (;;) {
    const i = buf.text.indexOf('\n\n');
    if (i !== -1) {
      const block = buf.text.slice(0, i); buf.text = buf.text.slice(i + 2);
      if (block.startsWith(':')) continue; // ping
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      return { event: block.match(/^event: (.*)$/m)[1], data: JSON.parse(data.slice(6)) };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended');
    buf.text += new TextDecoder().decode(value);
  }
}

test('events: snapshot on connect, again on every change; headers tell nginx not to buffer', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    const ac = new AbortController();
    const resp = await fetch(`${base}/game/live/api/${code}/events?token=${fer.token}`, { signal: ac.signal });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(resp.headers.get('x-accel-buffering'), 'no');
    assert.equal(resp.headers.get('cache-control'), 'no-cache');
    const reader = resp.body.getReader(); const buf = { text: '' };
    let ev = await readEvent(reader, buf);
    assert.equal(ev.event, 'state');
    assert.equal(ev.data.state, 'lobby');
    assert.deepEqual(ev.data.you, { playerId: fer.playerId, name: 'Fer' });

    await post(`${base}/game/live/api/${code}/join`, { name: 'Ana' });
    ev = await readEvent(reader, buf);
    assert.deepEqual(ev.data.players.map((p) => p.name), ['Fer', 'Ana']);

    await next(base, code);
    ev = await readEvent(reader, buf);
    assert.equal(ev.data.state, 'open');
    await post(`${base}/game/live/api/${code}/guess`, { token: fer.token, ord: 0, lat: 1, lng: 1 });
    ev = await readEvent(reader, buf);
    assert.deepEqual(ev.data.players.map((p) => p.answered), [true, false]);
    ac.abort();
    assert.equal((await fetch(`${base}/game/live/api/nope/events`)).status, 404);
  });
});

test('photo route serves a round photo only once that round is revealed', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const url = `${base}/game/live/api/${code}/photo/a1b2c3d4e5f60718.jpg`;
    assert.equal((await fetch(url)).status, 404); // lobby
    await next(base, code); // open 0
    assert.equal((await fetch(url)).status, 404);
    await next(base, code); // revealed 0
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'notreallyajpeg');
    assert.equal((await fetch(`${base}/game/live/api/${code}/photo/ffffffffffffffff.jpg`)).status, 404); // not a round photo
    assert.equal((await fetch(`${base}/game/live/api/${code}/photo/..%2Fsecret.jpg`)).status, 404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-live.test.js`
Expected: the two new tests FAIL (events route returns 404; photo route 404 after reveal).

- [ ] **Step 3: Implement the stream and photo route** — in `src/game/live.js`, replace `const broadcast = (_code) => {};` with:

```js
  // code → Set<{ res, token }>. The only in-memory state; rebuilds itself as clients reconnect.
  const streams = new Map();
  const send = (res, snap) => res.write(`event: state\ndata: ${JSON.stringify(snap)}\n\n`);
  const broadcast = (code) => {
    const set = streams.get(code);
    const s = set && set.size ? db.getSession(code) : null;
    if (!s) return;
    for (const c of set) send(c.res, snapshot(db, s, c.token));
  };
```

and add these two routes before `return router;`:

```js
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
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
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
    res.sendFile(path.join(uploadsDir, file), { maxAge: '1h' }, (err) => { if (err) res.status(404).end(); });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/game-live.test.js`
Expected: all 7 PASS, process exits promptly (the ping timer is unref'd and the test aborts its stream).

- [ ] **Step 5: Commit**

```bash
git add src/game/live.js test/game-live.test.js
git commit -m "feat(game): SSE state stream and revealed-only photo route for live sessions"
```

---

### Task 4: Mount the live router inside the game module and pass `uploadsDir`

**Files:**
- Modify: `src/game/routes.js` (signature line `module.exports = function gameRoutes({ basicAuth, dbPath = 'data/game.db' })` and the block just before `router.get('/:slug', …)`)
- Modify: `src/web.js:115` (the mount line)
- Test: `test/game-routes.test.js` (append)

**Interfaces:**
- Consumes: `liveRoutes({ basicAuth, db, uploadsDir })` from Task 2.
- Produces: `gameRoutes({ basicAuth, dbPath, uploadsDir })`. Every live path from Task 2/3 is reachable under `/game` in the real app.

- [ ] **Step 1: Write the failing test** — append to `test/game-routes.test.js`:

```js
test('live routes are mounted before the /:slug catch-all', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 'live' }),
    })).json();
    await fetch(`${base}/game/api/admin/games/${g.id}`, { method: 'PUT', headers: json,
      body: JSON.stringify({ title: 'live', rounds: [{ question: 'q', lat: 1, lng: 2 }] }) });
    const { code } = await (await fetch(`${base}/game/api/admin/games/${g.id}/sessions`, { method: 'POST', headers: auth })).json();
    assert.equal((await fetch(`${base}/game/live/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/game/live/api/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/game/host/${code}`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/game/live/nope`)).status, 404);
    assert.equal((await fetch(`${base}/game/${g.slug}`)).status, 200); // the old play page still resolves
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/game-routes.test.js`
Expected: the new test FAILS (`/game/live/<code>` is swallowed by `/:slug` → 404, and the sessions POST is 404).

- [ ] **Step 3: Mount it** — in `src/game/routes.js`:

Change the signature to:

```js
module.exports = function gameRoutes({ basicAuth, dbPath = 'data/game.db', uploadsDir = 'data/uploads' }) {
```

Add the require at the top, next to the others:

```js
const liveRoutes = require('./live');
```

Insert this just above the comment `// The share link: the play page itself …`:

```js
  // Live sessions (src/game/live.js) — before the /:slug catch-all so /live/… and /host/… resolve.
  router.use(liveRoutes({ basicAuth, db, uploadsDir }));
```

In `src/web.js`, change line 115 to:

```js
  app.use('/game', require('./game/routes')({ basicAuth, uploadsDir: UPLOADS }));
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test test/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/routes.js src/web.js test/game-routes.test.js
git commit -m "feat(game): mount live session routes; pass the uploads folder to the game module"
```

---

### Task 5: The live page `views/game/live.html`

**Files:**
- Replace: `views/game/live.html`
- Scratch (not committed): `/tmp/live-sessions/stub.js` and `/tmp/live-sessions/drive.html` for screenshots

**Interfaces:**
- Consumes: `GET /game/live/api/:code` (title/roundCount/state), `POST …/join`, `POST …/guess`, `GET …/state?token=`, `GET …/events?token=`, `GET …/photo/:file`, `POST /game/api/admin/sessions/:code/next|end` (host). Snapshot shape from Task 2.
- Produces: the page at `/game/live/:code` (player) and `/game/host/:code` (host). `window.map` and `window.liveState = { place, confirm }` as debug handles for the screenshot driver.

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapTap · Live</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.css">
<style>
  :root {
    color-scheme: dark;
    --bg: #070b1c; --bg-2: #0a1030; --panel: rgba(16,22,52,.92); --border: rgba(130,155,255,.16);
    --text: #eaf0ff; --muted: #98a4d4; --cyan: #22d3ee; --gold: #ffd15c; --red: #ff6b6b;
    --body: "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; overflow: hidden; color: var(--text); font: 16px/1.5 var(--body);
    background: radial-gradient(1200px 800px at 50% -5%, var(--bg-2), var(--bg) 70%); }
  #map { position: fixed; inset: 0; }
  .credit { position: fixed; right: 8px; bottom: 6px; z-index: 3; color: rgba(152,164,212,.8);
    font: .7rem var(--mono); pointer-events: none; }
  [hidden] { display: none !important; }

  .top { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 4;
    width: min(560px, calc(100vw - 24px)); background: var(--panel); border: 1px solid var(--border);
    border-radius: 14px; padding: 10px 16px; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
  .top .t { font: .7rem var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cyan); }
  .top .q { font: 600 1.02rem/1.4 var(--body); }
  .top .q .rno { color: var(--muted); font: .8rem var(--mono); margin-right: 8px; }
  .top .hint { font: .75rem var(--mono); color: var(--muted); }

  #action { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 5;
    font: 700 1rem var(--body); cursor: pointer; border-radius: 999px; padding: 12px 30px;
    border: 1px solid rgba(34,211,238,.5); background: rgba(11,50,64,.92); color: var(--cyan);
    box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #action:hover { background: rgba(34,211,238,.25); }

  #panel { position: fixed; top: 86px; right: 14px; z-index: 4; width: min(320px, calc(100vw - 28px));
    max-height: calc(100vh - 170px); overflow-y: auto; background: var(--panel);
    border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #panel h2 { font: .7rem var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cyan); margin: 0 0 8px; }
  #panel .ans { font-weight: 700; margin-bottom: 8px; }
  #panel img { width: 100%; border-radius: 10px; border: 1px solid var(--border); display: block; margin: 8px 0 4px; }
  #panel .story { font-size: .88rem; white-space: pre-wrap; margin-top: 6px; }
  #panel table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  #panel td { padding: 5px 4px; border-top: 1px solid var(--border); }
  #panel td.n { text-align: right; font-family: var(--mono); color: var(--muted); white-space: nowrap; }
  #panel td.pts { text-align: right; font-family: var(--mono); color: var(--gold); white-space: nowrap; }
  #panel tr.me td { color: var(--gold); font-weight: 700; }
  #panel .names { display: flex; flex-wrap: wrap; gap: 6px; }
  #panel .names span { font: .8rem var(--mono); padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); }

  .ov { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center;
    background: rgba(7,11,28,.7); backdrop-filter: blur(3px); padding: 16px; }
  .ov .card { background: var(--panel); border: 1px solid var(--border); border-radius: 18px;
    padding: 26px 28px; width: min(420px, 100%); max-height: 86vh; overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,.6); text-align: center; }
  .ov h1 { font: 1.15rem var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--cyan); margin: 0 0 8px; }
  .ov p { color: var(--muted); font-size: .9rem; margin: 0 0 16px; }
  .ov .err { color: var(--red); }
  .ov input { width: 100%; background: rgba(10,14,34,.72); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text); font: 1rem var(--body); padding: 10px 12px; text-align: center; margin-bottom: 14px; }
  .ov input:focus { outline: none; border-color: rgba(34,211,238,.4); }
  .ov button { font: 700 .95rem var(--body); cursor: pointer; border-radius: 999px; padding: 10px 28px;
    border: 1px solid rgba(34,211,238,.5); background: rgba(34,211,238,.15); color: var(--cyan); }
  .ov table { width: 100%; border-collapse: collapse; font-size: .95rem; text-align: left; }
  .ov td { padding: 6px 4px; border-top: 1px solid var(--border); }
  .ov td.pts { text-align: right; font-family: var(--mono); }
  .ov tr.me td { color: var(--gold); font-weight: 700; }

  /* pins on the reveal: a dot plus the player's name, as DOM markers (no glyph source needed) */
  .pin { display: flex; align-items: center; gap: 5px; pointer-events: none; } /* MapLibre owns the inline transform; the dot is centred via the marker's offset */
  .pin .dot { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid var(--bg); box-shadow: 0 0 0 1px rgba(255,255,255,.4); }
  .pin.mine .dot { background: var(--cyan); }
  .pin .name { font: 700 .72rem var(--mono); color: #fff; text-shadow: 0 1px 3px #000, 0 0 6px #000; white-space: nowrap; }
  .pin.mine .name { color: var(--cyan); }

  /* host control bar */
  #host { position: fixed; left: 14px; bottom: 14px; z-index: 6; width: min(340px, calc(100vw - 28px));
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #host h2 { font: .7rem var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--gold); margin: 0 0 8px; }
  #host .link { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  #host .link input { flex: 1; min-width: 0; background: rgba(10,14,34,.72); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font: .8rem var(--mono); padding: 6px 8px; }
  #host button { font: 700 .85rem var(--body); cursor: pointer; border-radius: 999px; padding: 7px 14px;
    border: 1px solid rgba(34,211,238,.5); background: rgba(34,211,238,.15); color: var(--cyan); }
  #host #next { width: 100%; font-size: 1rem; padding: 11px 16px; margin: 6px 0; background: rgba(34,211,238,.25); }
  #host #end { border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.12); color: var(--red); }
  #host .count { font: .8rem var(--mono); color: var(--muted); }
  #host .plist { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
  #host .plist span { font: .75rem var(--mono); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  #host .plist span.ok { color: var(--text); border-color: rgba(34,211,238,.5); }
</style>
</head>
<body>
<div id="map"></div>
<div class="top">
  <div class="t" id="gtitle">MapTap · Live</div>
  <div class="q"><span class="rno" id="rno"></span><span id="question">Loading…</span></div>
  <div class="hint" id="hint"></div>
</div>
<button id="action" hidden></button>
<div id="panel" hidden></div>
<div id="host" hidden>
  <h2>Host</h2>
  <div class="link"><input id="joinlink" readonly aria-label="Join link"><button id="copy">Copy</button></div>
  <div class="count" id="count"></div>
  <div class="plist" id="plist"></div>
  <button id="next"></button>
  <button id="end">End session</button>
</div>
<div class="ov" id="nameov" hidden><div class="card">
  <h1 id="wtitle">MapTap</h1>
  <p>Type your name to join. When the host opens a round, tap the globe where you think the answer is.</p>
  <p class="err" id="nameerr" hidden></p>
  <input id="pname" maxlength="40" placeholder="Your name" aria-label="Your name" autocomplete="off">
  <button id="join">Join</button>
</div></div>
<div class="ov" id="endov" hidden><div class="card">
  <h1 id="endtitle"></h1>
  <p>Final scoreboard</p>
  <table id="board"></table>
</div></div>
<div class="credit">Imagery © Esri &amp; contributors · MapLibre</div>
<script type="module">
import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.mjs';

const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const code = location.pathname.split('/').filter(Boolean).pop();
const HOST = location.pathname.startsWith('/game/host/');
const KEY = `maptap:live:${code}`;
let token = null;
try { token = localStorage.getItem(KEY); } catch {}
const api = (p, opts) => fetch(`/game/live/api/${code}${p}`, opts);
const postJson = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false, // the .credit line carries the Esri notice
  minZoom: 1, maxZoom: 17, center: [10, 25], zoom: 1.6,
  style: { version: 8,
    projection: { type: 'globe' },
    sources: { sat: { type: 'raster', tileSize: 256, maxzoom: 17,
      attribution: 'Imagery © Esri & contributors',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] } },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    sky: { 'sky-color': '#02040f', 'horizon-color': '#0e5d7a', 'fog-color': '#070b1c',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 1, 8, 0.1] } },
});
window.map = map; // console/debug handle

const EMPTY = { type: 'FeatureCollection', features: [] };
map.on('load', () => {
  map.addSource('truth', { type: 'geojson', data: EMPTY });
  map.addSource('lines', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines',
    paint: { 'line-color': '#ffffff', 'line-opacity': .7, 'line-width': 1.5, 'line-dasharray': [1.5, 1.5] } });
  map.addLayer({ id: 'truth', type: 'circle', source: 'truth',
    paint: { 'circle-radius': 7, 'circle-color': '#ffd15c', 'circle-stroke-color': '#070b1c', 'circle-stroke-width': 2 } });
});
const whenLoaded = (fn) => (map.loaded() ? fn() : map.once('load', fn));

let snap = null;           // latest server snapshot
let shown = { state: null, ord: null }; // what the globe currently reflects, to know when to reset
let marker = null;         // my draggable pin while a round is open
let sent = false;          // my current pin has been accepted by the server
let pins = [];             // DOM markers on the reveal

function setBanner(question, hint, rno) {
  $('rno').textContent = rno || '';
  $('question').textContent = question;
  $('hint').textContent = hint || '';
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const isMe = (playerId) => !!(snap.you && snap.you.playerId === playerId);
const photoUrl = (file) => `/game/live/api/${code}/photo/${file}`;

function clearGlobe() {
  if (marker) { marker.remove(); marker = null; }
  for (const p of pins) p.remove();
  pins = [];
  whenLoaded(() => { map.getSource('truth').setData(EMPTY); map.getSource('lines').setData(EMPTY); });
}

function renderLobby() {
  setBanner('Waiting for the host to start…', `${snap.players.length} joined`);
  const panel = $('panel');
  panel.replaceChildren(el('h2', null, 'Players'));
  const names = el('div', 'names');
  for (const p of snap.players) names.appendChild(el('span', null, p.name));
  if (!snap.players.length) names.appendChild(el('span', null, 'nobody yet'));
  panel.appendChild(names);
  panel.hidden = false;
  $('action').hidden = true;
}

function renderOpen() {
  const me = snap.players.find((p) => isMe(p.id));
  const answered = !!(me && me.answered);
  let hint = 'tap the globe to drop your pin';
  if (HOST) hint = `${snap.players.filter((p) => p.answered).length} of ${snap.players.length} answered`;
  else if (marker && !sent) hint = 'drag the pin to adjust, then confirm';
  else if (answered) hint = 'answer sent · tap again to change';
  setBanner(snap.round.question, hint, `${snap.round.ord + 1}/${snap.roundCount}`);
  $('panel').hidden = true;
  $('action').textContent = 'Confirm guess';
  $('action').hidden = HOST || !marker || sent;
}

function renderReveal() {
  const { truth, guesses } = snap.reveal;
  setBanner(snap.round.question, '', `${snap.round.ord + 1}/${snap.roundCount}`);
  $('action').hidden = true;
  if (marker) { marker.remove(); marker = null; }
  for (const p of pins) p.remove();
  pins = guesses.map((g) => {
    const node = el('div', 'pin' + (isMe(g.playerId) ? ' mine' : ''));
    node.appendChild(el('span', 'dot'));
    node.appendChild(el('span', 'name', g.name));
    // anchor left + offset −6 px puts the 12 px dot's centre on the point; the name trails to the right
    return new maplibregl.Marker({ element: node, anchor: 'left', offset: [-6, 0] }).setLngLat([g.lng, g.lat]).addTo(map);
  });
  whenLoaded(() => {
    map.getSource('truth').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [truth.lng, truth.lat] } });
    map.getSource('lines').setData({ type: 'FeatureCollection', features: guesses.map((g) => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[g.lng, g.lat], [truth.lng, truth.lat]] } })) });
    const b = new maplibregl.LngLatBounds([truth.lng, truth.lat], [truth.lng, truth.lat]);
    for (const g of guesses) b.extend([g.lng, g.lat]);
    map.fitBounds(b, { padding: { top: 110, bottom: 80, left: 60, right: 360 }, maxZoom: 9, duration: RM ? 0 : 1200 });
  });

  const panel = $('panel');
  panel.replaceChildren(el('h2', null, `Round ${snap.round.ord + 1}`));
  const label = truth.answer || [truth.city, truth.country].filter(Boolean).join(' · ');
  if (label) panel.appendChild(el('div', 'ans', `📍 ${label}`));
  const table = el('table');
  guesses.forEach((g, i) => {
    const tr = el('tr', isMe(g.playerId) ? 'me' : '');
    tr.appendChild(el('td', null, `${i + 1}.`));
    tr.appendChild(el('td', null, g.name));
    tr.appendChild(el('td', 'n', `${g.km} km`));
    tr.appendChild(el('td', 'pts', `+${g.points}`));
    table.appendChild(tr);
  });
  const missed = snap.players.filter((p) => !guesses.some((g) => g.playerId === p.id));
  for (const p of missed) {
    const tr = el('tr', isMe(p.id) ? 'me' : '');
    tr.appendChild(el('td', null, '–')); tr.appendChild(el('td', null, p.name));
    tr.appendChild(el('td', 'n', 'no pin')); tr.appendChild(el('td', 'pts', '+0'));
    table.appendChild(tr);
  }
  panel.appendChild(table);
  if (truth.photo) { const img = el('img'); img.src = photoUrl(truth.photo); img.alt = label || 'photo'; panel.appendChild(img); }
  if (truth.story) panel.appendChild(el('div', 'story', truth.story));
  panel.hidden = false;
}

function renderFinished() {
  setBanner('Thanks for playing!', '');
  $('panel').hidden = true;
  $('action').hidden = true;
  $('endtitle').textContent = snap.title;
  const rows = snap.standings.map((s, i) => {
    const tr = el('tr', isMe(s.playerId) ? 'me' : '');
    tr.appendChild(el('td', null, `${i + 1}.`)); tr.appendChild(el('td', null, s.name)); tr.appendChild(el('td', 'pts', `${s.total} pts`));
    return tr;
  });
  $('board').replaceChildren(...rows);
  $('endov').hidden = false;
}

function renderHost() {
  if (!HOST) return;
  $('host').hidden = false;
  $('joinlink').value = `${location.origin}/game/live/${code}`;
  const done = snap.players.filter((p) => p.answered).length;
  $('count').textContent = snap.state === 'open' ? `${done} of ${snap.players.length} answered`
    : `${snap.players.length} player${snap.players.length === 1 ? '' : 's'}`;
  $('plist').replaceChildren(...snap.players.map((p) => el('span', p.answered && snap.state === 'open' ? 'ok' : '', p.name)));
  const labels = { lobby: 'Start round 1', open: 'Reveal' };
  let label = labels[snap.state];
  if (snap.state === 'revealed') label = snap.round.ord + 1 < snap.roundCount ? `Next round (${snap.round.ord + 2}/${snap.roundCount})` : 'Show final scoreboard';
  $('next').hidden = !label;
  $('next').textContent = label || '';
  $('end').hidden = snap.state === 'finished';
}

function render() {
  document.title = `MapTap · ${snap.title}`;
  $('gtitle').textContent = snap.title;
  const roundChanged = snap.state !== shown.state || (snap.round && snap.round.ord !== shown.ord);
  if (roundChanged && (snap.state === 'open' || snap.state === 'lobby' || snap.state === 'finished')) { clearGlobe(); sent = false; }
  shown = { state: snap.state, ord: snap.round ? snap.round.ord : null };
  $('endov').hidden = snap.state !== 'finished';
  ({ lobby: renderLobby, open: renderOpen, revealed: renderReveal, finished: renderFinished })[snap.state]();
  renderHost();
}

// ---- guessing ----
function place(lat, lng) {
  if (HOST || !snap || snap.state !== 'open') return;
  if (!marker) {
    marker = new maplibregl.Marker({ draggable: true, color: '#22d3ee' }).setLngLat([lng, lat]).addTo(map);
    marker.on('dragend', () => { sent = false; renderOpen(); });
  } else marker.setLngLat([lng, lat]);
  sent = false;
  renderOpen();
}
map.on('click', (e) => place(e.lngLat.lat, e.lngLat.wrap().lng));

async function confirmGuess() {
  if (!marker || !snap || snap.state !== 'open') return;
  const { lat, lng } = marker.getLngLat().wrap();
  $('action').hidden = true;
  try {
    const resp = await postJson('/guess', { token, ord: snap.round.ord, lat, lng });
    if (resp.status === 409) { $('hint').textContent = 'round closed — waiting for the host'; return; }
    if (!resp.ok) throw new Error(resp.status);
    sent = true;
    renderOpen();
  } catch { $('action').hidden = false; $('hint').textContent = 'network hiccup — try confirm again'; }
}
$('action').addEventListener('click', confirmGuess);

// ---- host controls ----
$('next').addEventListener('click', async () => {
  $('next').disabled = true;
  try { await fetch(`/game/api/admin/sessions/${code}/next`, { method: 'POST' }); }
  finally { $('next').disabled = false; }
});
$('end').addEventListener('click', async () => {
  if (!confirm('End this session for everyone? The scoreboard shows what has been revealed so far.')) return;
  await fetch(`/game/api/admin/sessions/${code}/end`, { method: 'POST' });
});
$('copy').addEventListener('click', () => {
  const url = $('joinlink').value;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500); });
  else { $('joinlink').select(); document.execCommand('copy'); }
});

// ---- joining + the stream ----
function connect() {
  const es = new EventSource(`/game/live/api/${code}/events?token=${encodeURIComponent(token || '')}`);
  es.addEventListener('state', (e) => { snap = JSON.parse(e.data); render(); });
  es.onerror = () => { $('hint').textContent = 'reconnecting…'; };
}
$('join').addEventListener('click', async () => {
  const name = $('pname').value.trim();
  if (!name) return $('pname').focus();
  $('nameerr').hidden = true;
  const resp = await postJson('/join', { name });
  if (resp.status === 409) { $('nameerr').textContent = 'That name is taken — pick another.'; $('nameerr').hidden = false; return; }
  if (!resp.ok) { $('nameerr').textContent = 'Could not join — try again.'; $('nameerr').hidden = false; return; }
  const p = await resp.json();
  token = p.token;
  try { localStorage.setItem(KEY, token); } catch {}
  $('nameov').hidden = true;
  connect();
});
$('pname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });

window.liveState = { place, confirm: confirmGuess, render: (s) => { snap = s; render(); } }; // debug/driver handle

(async () => {
  let first;
  try {
    const resp = await api(`/state?token=${encodeURIComponent(token || '')}`);
    if (!resp.ok) throw new Error(resp.status);
    first = await resp.json();
  } catch { setBanner('Could not load this session.', 'check the link'); return; }
  $('gtitle').textContent = first.title;
  $('wtitle').textContent = first.title;
  if (!HOST && !first.you) {
    token = null;
    setBanner('Join the game', '');
    $('nameov').hidden = false;
    $('pname').focus();
    return;
  }
  connect();
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Run the suite** (the page routes still resolve)

Run: `node --test test/`
Expected: all PASS.

- [ ] **Step 3: Write the screenshot stub** — `/tmp/live-sessions/stub.js` (uses the worktree's modules; run with `node /tmp/live-sessions/stub.js` from the worktree root):

```js
// Stub server for screenshots: real live router, in-memory db, no auth, seeded states.
const path = require('node:path');
const express = require('express');
const { openGameDb } = require(path.resolve('src/game/db'));
const liveRoutes = require(path.resolve('src/game/live'));

const db = openGameDb(':memory:');
const noauth = (_req, _res, next) => next();
const app = express();
app.use(express.json());
app.use('/game', liveRoutes({ basicAuth: noauth, db, uploadsDir: '/tmp/live-sessions' }));

const g = db.createGame('Trains of the world');
db.saveGame(g.id, 'Trains of the world', [
  { question: 'Where is the highest railway station in the world?', lat: 33.0106, lng: 91.6642, radius: 20,
    answer: 'Tanggula, Qinghai–Tibet Railway, China', story: '5,068 m above sea level. Unstaffed; trains do not stop.' },
  { question: 'Where did the first public steam railway run?', lat: 54.52, lng: -1.55, answer: 'Stockton & Darlington, England' },
]);
const mk = (state) => {
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer'), ana = db.joinSession(s.id, 'Ana'), tom = db.joinSession(s.id, 'Tom');
  if (state === 'lobby') return { s, fer };
  db.advanceSession(s.code); // open 0
  db.upsertGuess(s.id, fer.id, 0, { lat: 31.2, lng: 90.1, km: 240.3, points: 65 });
  db.upsertGuess(s.id, ana.id, 0, { lat: 27.7, lng: 85.3, km: 880, points: 18 });
  if (state === 'open') return { s, fer };
  db.upsertGuess(s.id, tom.id, 0, { lat: 46.5, lng: 8.6, km: 7100, points: 0 });
  db.advanceSession(s.code); // revealed 0
  if (state === 'revealed') return { s, fer };
  db.advanceSession(s.code); db.advanceSession(s.code); db.advanceSession(s.code); // finished
  return { s, fer };
};
const states = Object.fromEntries(['lobby', 'open', 'revealed', 'finished'].map((st) => [st, mk(st)]));

// Driver: sets the player token in localStorage, then iframes the target page; the
// /slow gif makes headless Chrome's screenshot wait in real time for tiles.
app.get('/drive', (req, res) => {
  const { s, fer } = states[req.query.state];
  const target = req.query.host ? `/game/host/${s.code}` : `/game/live/${s.code}`;
  res.type('html').send(`<!doctype html><body style="margin:0">
    <script>localStorage.setItem('maptap:live:${s.code}', '${fer.token}');</script>
    <iframe id="f" src="${target}" style="border:0;width:${req.query.w || 1200}px;height:${req.query.h || 900}px"></iframe>
    <img src="/slow?ms=${req.query.ms || 12000}" width="1" height="1">
  </body>`);
});
app.get('/slow', (req, res) => setTimeout(() => {
  res.type('gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
}, +req.query.ms || 10000));

app.listen(3101, () => {
  console.log('stub on :3101');
  for (const [st, { s }] of Object.entries(states)) console.log(st, s.code);
});
```

- [ ] **Step 4: Take the screenshots** — start the stub in the background (`node /tmp/live-sessions/stub.js`, run_in_background), then one headless Chrome call per view (no `--disable-gpu`):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/live-sessions/lobby.png "http://localhost:3101/drive?state=lobby"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/live-sessions/open.png "http://localhost:3101/drive?state=open"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/live-sessions/revealed.png "http://localhost:3101/drive?state=revealed"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/live-sessions/finished.png "http://localhost:3101/drive?state=finished"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/live-sessions/host-open.png "http://localhost:3101/drive?state=open&host=1"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=420,900 --screenshot=/tmp/live-sessions/revealed-phone.png "http://localhost:3101/drive?state=revealed&w=390&h=844"
```

Read each PNG with the Read tool and check: lobby shows three name chips and "3 joined"; open shows the question, `1/2`, and (for Fer, who has answered) the hint "answer sent · tap again to change"; revealed shows a gold truth dot, three named pins with dashed lines, the ranking Fer / Ana / Tom with km and points and Fer's row gold, the answer label and story; finished shows the scoreboard overlay with Fer highlighted; host-open shows the control bar with "2 of 3 answered", Fer and Ana chips lit, the Reveal button, End session, and the join link; the phone-width reveal keeps the panel inside the viewport. Fix and re-shoot until all six look right. Stop the stub afterwards.

- [ ] **Step 5: Commit**

```bash
git add views/game/live.html
git commit -m "feat(game): live page — lobby, tap-to-guess, everyone's pins on reveal, final scoreboard, host bar"
```

---

### Task 6: Builder — "Go live", session list, mid-session save warning

**Files:**
- Modify: `views/game/builder.html` (`renderList` ~line 122, `loadList` ~line 173, `openEditor` ~line 179, the `main` click handler ~line 237, the Save handler ~line 362, CSS near line 37)

**Interfaces:**
- Consumes: `POST /game/api/admin/games/:id/sessions → { code }`, `GET /game/api/admin/games/:id/sessions → { sessions: [{ code, state, players, created_at }] }` (Task 2).
- Produces: nothing programmatic.

- [ ] **Step 1: CSS** — after the `.game .meta` rule add:

```css
  .game .sessions { flex-basis: 100%; font: .75rem var(--mono); color: var(--muted); }
  .game .sessions a { color: var(--cyan); text-decoration: none; }
  .game .sessions .fin { opacity: .6; }
```

(`.game` is already `display: flex; flex-wrap: wrap`, so the full-width sessions line drops under the buttons by itself.)

- [ ] **Step 2: Fetch sessions with the list** — replace `loadList`:

```js
async function loadList() {
  games = (await (await fetch('/game/api/admin/games')).json()).games;
  await Promise.all(games.map(async (g) => {
    g.sessions = (await (await fetch(`/game/api/admin/games/${g.id}/sessions`)).json()).sessions;
  }));
  editing = null;
  render();
}
```

- [ ] **Step 3: Render the button and the sessions line** — in `renderList`, replace the game template with:

```js
    <div class="game">
      <span class="t">${esc(g.title)}</span>
      <span class="meta">${g.rounds} rounds · ${g.plays} plays · ${g.created_at.slice(0, 10)}</span>
      <button class="sm" data-copy="${esc(g.slug)}">Copy link</button>
      <button class="sm" data-live="${g.id}" ${g.rounds ? '' : 'disabled title="Add rounds first"'}>Go live</button>
      <button class="sm" data-edit="${g.id}">Edit</button>
      <button class="del" data-del="${g.id}" title="Delete game" aria-label="Delete game">✕</button>
      ${(g.sessions || []).length ? `<div class="sessions">${g.sessions.map((s) => `
        <span class="${s.state === 'finished' ? 'fin' : ''}">${s.state === 'finished' ? 'finished' : 'LIVE · ' + esc(s.state)} ·
        ${s.players} player${s.players === 1 ? '' : 's'} · ${esc(s.created_at.slice(0, 10))} ·
        <a href="/game/host/${esc(s.code)}" target="_blank" rel="noopener">host page</a></span>`).join('<br>')}</div>` : ''}
    </div>
```

- [ ] **Step 4: Handle the click** — in the `main` click handler, after `if (edit) return openEditor(edit);` add:

```js
  const live = btn('live');
  if (live) {
    const resp = await fetch(`/game/api/admin/games/${live}/sessions`, { method: 'POST' });
    if (!resp.ok) return setStatus('Could not start a session');
    const { code } = await resp.json();
    window.open(`/game/host/${code}`, '_blank', 'noopener');
    return loadList();
  }
```

- [ ] **Step 5: Warn on save while a session runs** — in `openEditor`, after fetching `d`, also load sessions:

```js
async function openEditor(id) {
  const d = await (await fetch(`/game/api/admin/games/${id}`)).json();
  const { sessions } = await (await fetch(`/game/api/admin/games/${id}/sessions`)).json();
  editing = { game: d.game, rounds: d.rounds, sessions, dirty: false };
  render();
}
```

and in the Save handler, right after the `bad` check and before `$('save').disabled = true;`:

```js
  if ((editing.sessions || []).some((s) => s.state !== 'finished')
    && !confirm('A live session is running on this game. Saving changes the rounds under it. Continue?')) return;
```

Also keep `sessions` when Save replaces `editing`: change that line to
`editing = { game: d.game, rounds: d.rounds, sessions: editing.sessions, dirty: false };`.

- [ ] **Step 6: Verify with a screenshot** — write `/tmp/live-sessions/builder-stub.js` (the full game router, no auth, a temp db file, on its own port so the builder's absolute `/game/...` fetches resolve):

```js
const path = require('node:path');
const express = require('express');
const gameRoutes = require(path.resolve('src/game/routes'));
const app = express();
app.use(express.json());
app.use('/game', gameRoutes({ basicAuth: (_req, _res, next) => next(),
  dbPath: '/tmp/live-sessions/builder.db', uploadsDir: '/tmp/live-sessions' }));
app.listen(3102, () => console.log('builder stub on :3102'));
```

Run it in the background from the worktree root (`node /tmp/live-sessions/builder-stub.js`), then seed it with three plain curl calls (read the `id` from the first response and put it in the next two):

```bash
curl -s -X POST localhost:3102/game/api/admin/games -H 'content-type: application/json' -d '{"title":"Trains"}'
curl -s -X PUT localhost:3102/game/api/admin/games/1 -H 'content-type: application/json' -d '{"title":"Trains","rounds":[{"question":"Highest station?","lat":33.0106,"lng":91.6642}]}'
curl -s -X POST localhost:3102/game/api/admin/games/1/sessions
```

Screenshot `http://localhost:3102/game/admin` with the same headless Chrome command as Task 5 (window 1200×900, output `/tmp/live-sessions/builder.png`). Check: the "Go live" button is present and enabled, and the session line under the game reads "LIVE · lobby · 0 players · <today> · host page". Stop the stub and delete `/tmp/live-sessions/builder.db` afterwards.

- [ ] **Step 7: Run the suite and commit**

Run: `node --test test/`
Expected: all PASS.

```bash
git add views/game/builder.html
git commit -m "feat(game): Go live button, session list and mid-session save warning in the builder"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md` (Endpoints section, after the Friends-only block), `docs/HANDOVER-globe.md` (the "Where the globe appears" table)

- [ ] **Step 1: README** — add after the Friends-only list:

```markdown
Live sessions (everyone plays a custom game at once, host reveals; no login, the
code in the link is the access control):

- `GET /game/live/:code` — player page; `GET /game/host/:code` — host page (admin password)
- `GET /game/live/api/:code` — title, round count, state; `POST …/join` `{ name }` → `{ token }`
- `POST /game/live/api/:code/guess` `{ token, ord, lat, lng }` — accepted only while that round is open
- `GET /game/live/api/:code/state?token=` — one snapshot; `GET …/events?token=` — the same as a Server-Sent Events stream
- `GET /game/live/api/:code/photo/:file` — a round's photo, only once that round is revealed
- Admin: `POST`/`GET /game/api/admin/games/:id/sessions`, `POST /game/api/admin/sessions/:code/next`, `POST …/end`

Start one from "Go live" on `/game/admin`; the host page has the join link.
Behind nginx the stream relies on the `X-Accel-Buffering: no` header the app
sends, so no proxy config is needed.
```

- [ ] **Step 2: Handover table** — add a row:

```markdown
| Live session (player + host) | `views/game/live.html` | `GET /game/live/:code`, `GET /game/host/:code` ([live.js](src/game/live.js)) | globe | static namespace import |
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/HANDOVER-globe.md
git commit -m "docs: live sessions endpoints and globe page table"
```

---

### Task 8: Finish the branch

- [ ] **Step 1:** `node --test test/` in the worktree — all PASS.
- [ ] **Step 2:** Use `superpowers:finishing-a-development-branch`: merge `live-sessions` into local `main`, run the suite again on `main`, push.
- [ ] **Step 3:** Deploy by hand per the handover: `ssh root@46.224.233.5`, `cd /root/maptap-scoreboard`, `git pull --ff-only && docker compose up -d --build`, then `curl localhost:3000/healthz`. Open `/game/admin`, press Go live on a test game, open the join link in a private window, and run one round end to end.
