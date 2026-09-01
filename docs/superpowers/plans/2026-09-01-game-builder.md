# Game Builder (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin can create a game with ordered rounds (question, location, photo, story) at `/game/admin`, and its share link `/game/<slug>` resolves.

**Architecture:** Isolated module: `src/game/db.js` (own `data/game.db`) + `src/game/routes.js` (Express router taking `{ basicAuth, dbPath }`), mounted with one line in `src/web.js`. One admin page `views/game/builder.html`. Photos reuse slice 1's `/api/upload`.

**Tech Stack:** better-sqlite3 (installed), Express router, node:test, vanilla JS page, Nominatim picker pattern from `views/users.html`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-01-game-builder.md`. Handover directives in `docs/HANDOVER-globe-game.md` apply (isolation, own DB file, never touch `scores.db`).
- Run tests as `node --test test/`.
- Slug: `crypto.randomBytes(8).toString('hex')`.
- Photo filename regex (duplicated into game module on purpose): `/^[a-f0-9]{16}\.(jpg|png|webp|gif)$/`.
- Round validation at the PUT boundary; `ord` assigned server-side from array order.
- Mount line is the ONLY `src/web.js` change: `app.use('/game', require('./game/routes')({ basicAuth }));`

---

### Task 1: `src/game/db.js` — schema + game CRUD

**Files:**
- Create: `src/game/db.js`
- Test: `test/game-db.test.js`

**Interfaces:**
- Produces: `openGameDb(dbPath)` → `{ raw, createGame(title), listGames(), getGame(id), saveGame(id, title, rounds), deleteGame(id) }`.
  - `createGame(title)` → full game row `{ id, slug, title, created_at }`.
  - `listGames()` → `[{ id, slug, title, created_at, rounds, plays }]` (counts, newest first).
  - `getGame(id)` → `{ game, rounds }` or `null`; rounds ordered by `ord`.
  - `saveGame(id, title, rounds)` → same shape as `getGame`; replaces all rounds in one transaction; rounds arrive pre-validated as `{ question, lat, lng, city?, country?, photo?, story? }`.
  - `deleteGame(id)` → `{ deleted: true|false }`.

- [ ] **Step 1: Write the failing test** — create `test/game-db.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openGameDb } = require('../src/game/db');

const round = (q, lat, lng, extra = {}) => ({ question: q, lat, lng, ...extra });

test('createGame: random 16-hex slug, listed with zero counts', () => {
  const db = openGameDb(':memory:');
  const g = db.createGame("Daniel's 30th");
  assert.match(g.slug, /^[a-f0-9]{16}$/);
  assert.equal(g.title, "Daniel's 30th");
  const list = db.listGames();
  assert.equal(list.length, 1);
  assert.deepEqual({ rounds: list[0].rounds, plays: list[0].plays }, { rounds: 0, plays: 0 });
});

test('saveGame replaces rounds wholesale, ord follows array order', () => {
  const db = openGameDb(':memory:');
  const g = db.createGame('t');
  db.saveGame(g.id, 't', [round('Born?', 38.57, -7.9, { city: 'Évora', photo: 'a1b2c3d4e5f60718.jpg', story: 's' })]);
  db.saveGame(g.id, 'Renamed', [round('Studied?', 41.15, -8.61), round('Born?', 38.57, -7.9)]);
  const { game, rounds } = db.getGame(g.id);
  assert.equal(game.title, 'Renamed');
  assert.deepEqual(rounds.map((r) => [r.ord, r.question]), [[0, 'Studied?'], [1, 'Born?']]);
  assert.equal(rounds[0].photo, null);
});

test('deleteGame cascades rounds; getGame of missing id is null', () => {
  const db = openGameDb(':memory:');
  const g = db.createGame('t');
  db.saveGame(g.id, 't', [round('q', 1, 2)]);
  assert.deepEqual(db.deleteGame(g.id), { deleted: true });
  assert.equal(db.getGame(g.id), null);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM rounds').get().n, 0);
  assert.deepEqual(db.deleteGame(999), { deleted: false });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test test/game-db.test.js` → cannot find module `../src/game/db`.

- [ ] **Step 3: Implement** — create `src/game/db.js`:

```js
// Game storage — its OWN SQLite file (data/game.db), never scores.db, so the
// whole game module can be lifted out of this repo later (handover directive).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  question TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  city     TEXT, country TEXT, photo TEXT, story TEXT,
  UNIQUE(game_id, ord)
);
CREATE TABLE IF NOT EXISTS plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(game_id, player_name COLLATE NOCASE)
);
CREATE TABLE IF NOT EXISTS guesses (
  play_id   INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  round_ord INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  km        REAL NOT NULL,
  points    INTEGER NOT NULL,
  UNIQUE(play_id, round_ord)
);
`;

function openGameDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insertRound = db.prepare(`
    INSERT INTO rounds (game_id, ord, question, lat, lng, city, country, photo, story)
    VALUES (@game_id, @ord, @question, @lat, @lng, @city, @country, @photo, @story)
  `);
  const replaceRounds = db.transaction((id, title, rounds) => {
    db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, id);
    db.prepare('DELETE FROM rounds WHERE game_id = ?').run(id);
    rounds.forEach((r, ord) => insertRound.run({
      game_id: id, ord, question: r.question, lat: r.lat, lng: r.lng,
      city: r.city ?? null, country: r.country ?? null, photo: r.photo ?? null, story: r.story ?? null,
    }));
  });

  return {
    raw: db,

    createGame(title) {
      const slug = crypto.randomBytes(8).toString('hex'); // the link IS the access control
      db.prepare('INSERT INTO games (slug, title, created_at) VALUES (?, ?, ?)')
        .run(slug, title, new Date().toISOString());
      return db.prepare('SELECT * FROM games WHERE slug = ?').get(slug);
    },

    listGames() {
      return db.prepare(`
        SELECT g.*,
          (SELECT COUNT(*) FROM rounds r WHERE r.game_id = g.id) AS rounds,
          (SELECT COUNT(*) FROM plays p WHERE p.game_id = g.id) AS plays
        FROM games g ORDER BY g.id DESC
      `).all();
    },

    getGame(id) {
      const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
      if (!game) return null;
      const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY ord').all(id);
      return { game, rounds };
    },

    saveGame(id, title, rounds) {
      replaceRounds(id, title, rounds);
      return this.getGame(id);
    },

    deleteGame(id) {
      return { deleted: db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0 };
    },
  };
}

module.exports = { openGameDb };
```

- [ ] **Step 4: Run tests, expect PASS** — `node --test test/game-db.test.js`, then `node --test test/`.

- [ ] **Step 5: Commit**

```bash
git add src/game/db.js test/game-db.test.js
git commit -m "feat: game module storage — games/rounds/plays/guesses in data/game.db"
```

---

### Task 2: `src/game/routes.js` + one-line mount

**Files:**
- Create: `src/game/routes.js`
- Modify: `src/web.js` (one mount line, after the upload routes)
- Test: `test/game-routes.test.js`

**Interfaces:**
- Consumes: `openGameDb` (Task 1); `basicAuth` export from `src/web.js` (slice 1).
- Produces: `require('./game/routes')({ basicAuth, dbPath? })` → Express router with the routes from the spec. Task 3's page calls `/game/api/admin/*`; slice 3 replaces the `GET /:slug` placeholder.

- [ ] **Step 1: Write the failing test** — create `test/game-routes.test.js`:

```js
process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { basicAuth } = require('../src/web');
const gameRoutes = require('../src/game/routes');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/game', gameRoutes({ basicAuth, dbPath: ':memory:' }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}
const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };
const json = { ...auth, 'content-type': 'application/json' };

test('admin API requires auth', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/game/api/admin/games`)).status, 401);
    assert.equal((await fetch(`${base}/game/admin`)).status, 401);
  });
});

test('create → update rounds → fetch round-trip; share slug resolves', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: "Daniel's 30th" }),
    })).json();
    assert.match(g.slug, /^[a-f0-9]{16}$/);

    const put = await fetch(`${base}/game/api/admin/games/${g.id}`, {
      method: 'PUT', headers: json,
      body: JSON.stringify({ title: g.title, rounds: [
        { question: ' Born? ', lat: 38.57, lng: -7.9, city: 'Évora', story: ' s ', photo: 'a1b2c3d4e5f60718.jpg' },
        { question: 'Studied?', lat: 41.15, lng: -8.61 },
      ] }),
    });
    assert.equal(put.status, 200);
    const { rounds } = await (await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).json();
    assert.deepEqual(rounds.map((r) => [r.ord, r.question]), [[0, 'Born?'], [1, 'Studied?']]);

    const play = await fetch(`${base}/game/${g.slug}`);
    assert.equal(play.status, 200);
    assert.match(await play.text(), /Daniel's 30th/);
    assert.equal((await fetch(`${base}/game/deadbeefdeadbeef`)).status, 404);
  });
});

test('PUT rejects invalid rounds with 400', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 't' }),
    })).json();
    for (const bad of [
      { question: '', lat: 1, lng: 2 },                       // empty question
      { question: 'q', lat: 91, lng: 2 },                     // lat out of range
      { question: 'q', lat: 1, lng: '2' },                    // non-numeric lng
      { question: 'q', lat: 1, lng: 2, photo: '../etc/pwd' }, // bad photo name
    ]) {
      const r = await fetch(`${base}/game/api/admin/games/${g.id}`, {
        method: 'PUT', headers: json, body: JSON.stringify({ title: 't', rounds: [bad] }),
      });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({}),
    })).status, 400); // missing title
  });
});

test('delete removes the game and its share page', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 't' }),
    })).json();
    assert.equal((await fetch(`${base}/game/api/admin/games/${g.id}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/game/${g.slug}`)).status, 404);
    assert.equal((await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).status, 404);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test test/game-routes.test.js` → cannot find module `../src/game/routes`.

- [ ] **Step 3: Implement** — create `src/game/routes.js`:

```js
// The game's whole HTTP surface, mounted at /game from src/web.js with one
// line. Depends on the host only for basicAuth (and /api/upload for photos).
const path = require('node:path');
const express = require('express');
const { openGameDb } = require('./db');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');
// Same pattern the host's upload endpoint generates; duplicated on purpose
// (no imports from host code — the module must stay liftable).
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/;

const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
// Round from the builder → clean row, or null if invalid.
function cleanRound(r) {
  if (!r || typeof r !== 'object') return null;
  const question = optStr(r.question);
  if (!question) return null;
  if (!Number.isFinite(r.lat) || Math.abs(r.lat) > 90) return null;
  if (!Number.isFinite(r.lng) || Math.abs(r.lng) > 180) return null;
  if (r.photo != null && !PHOTO_FILE.test(r.photo)) return null;
  return {
    question, lat: r.lat, lng: r.lng,
    city: optStr(r.city), country: optStr(r.country),
    photo: r.photo || undefined, story: optStr(r.story),
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
    res.send(`<!doctype html><meta charset="utf-8"><title>${game.title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</title>
      <body style="font:16px system-ui;background:#070b1c;color:#eaf0ff;display:grid;place-items:center;min-height:100vh;margin:0">
      <p>${game.title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))} — play page coming soon.</p></body>`);
  });

  return router;
};
```

- [ ] **Step 4: Mount in `src/web.js`** — after the `/api/upload` route block, add:

```js
  // ---- Custom games (isolated module: src/game/, data/game.db). ----
  app.use('/game', require('./game/routes')({ basicAuth }));
```

- [ ] **Step 5: Run tests, expect PASS** — `node --test test/game-routes.test.js`, then `node --test test/`.

- [ ] **Step 6: Commit**

```bash
git add src/game/routes.js src/web.js test/game-routes.test.js
git commit -m "feat: game routes — admin CRUD API, builder mount, share-link placeholder"
```

---

### Task 3: `views/game/builder.html`

**Files:**
- Create: `views/game/builder.html`

**Interfaces:**
- Consumes: `/game/api/admin/*` (Task 2), `POST /api/upload` → `{ file }` (slice 1), Nominatim (same query shape as `views/users.html`).

- [ ] **Step 1: Build the page.** Visual language copied from `views/users.html` (same `:root` tokens, `.bar`, `button`, `.card`, `.sug` picker styles). Structure:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapTap · Game builder</title>
<style>/* :root tokens, body, .bar, button, .sug, .cityrow — copied from users.html; plus: */
  .game { display: flex; gap: 10px; align-items: center; background: var(--panel);
    border: 1px solid var(--border); border-radius: 14px; padding: 12px 16px; margin-bottom: 10px; }
  .game .t { font-weight: 700; flex: 1; }
  .game .meta { font: .75rem var(--mono); color: var(--muted); }
  .round { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    padding: 12px 14px; margin-bottom: 12px; }
  .round .head { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  .round .head .n { font: .75rem var(--mono); color: var(--cyan); flex: none; }
  .round input[type=text], .round textarea { width: 100%; background: rgba(10,14,34,.72);
    border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 6px 8px; }
  .round .q { font: 600 .95rem var(--body); flex: 1; }
  .locrow { display: flex; gap: 6px; margin: 8px 0; position: relative; }
  .locrow input { font: .82rem var(--mono); }
  .ph { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .ph img { width: 96px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
  .sharerow { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/admin">← Admin</a>
  <h1>Game builder</h1>
  <p class="hint" id="hint">Create a game, add rounds, share the link on WhatsApp. The link is the invitation —
    anyone with it can play.</p>
  <div class="bar">
    <button id="new">+ New game</button>
    <button id="back" hidden>← Games</button>
    <button id="save" class="primary" hidden disabled>Save</button>
    <span id="status"></span>
  </div>
  <div id="main"></div>
</div>
<script> /* see behavior spec below */ </script>
</body>
</html>
```

Behavior (single `state = { games, editing: null|{game, rounds}, dirty }`):
- List view: render `.game` rows (title, `N rounds · M plays · created`), buttons: Copy link (`navigator.clipboard.writeText(location.origin + '/game/' + slug)` → status "Link copied"), Edit, Delete (`confirm()` then DELETE, reload list). `+ New game` → `prompt('Game title?')` → POST → open editor.
- Editor view: title as click-to-rename (like users page). Rounds rendered as `.round` cards: header `#N` + question input + ↑ ↓ ✕ buttons; `.locrow` with city-picker input (Nominatim `format=jsonv2&addressdetails=1&accept-language=en&limit=5`, suggestion list, picking stores city/country/lat/lng — copy the users.html handler) AND a second input `lat, lng` (placeholder `38.57, -7.91`; on change, parse two floats, set lat/lng, clear city/country if picker not used); a 📍/⚠ indicator; photo row (thumb if set, ✕, `+ photo` file input → POST `/api/upload` with `content-type: file.type`, push `{ photo: file }`); story textarea. `+ Round` appends `{ question: '', lat: NaN, lng: NaN }`. Save: strips client-only fields, PUT `{ title, rounds }`; rounds with no question or no coords → `alert` naming the round number, no request. Unsaved guard on `beforeunload` and on Back.
- Escape all rendered text with the same `esc()` helper as users.html.

- [ ] **Step 2: Screenshot verification.** Extend the scratchpad stub (`stub.js`): serve `views/game/builder.html` at `/game/admin` (no auth), fake `GET /game/api/admin/games` (two games), `GET /game/api/admin/games/1` (one game, two rounds — one with city+photo+story, one with raw coords only), `POST /api/upload`, `/uploads/*` PNG. Driver page iframes `/game/admin`; a second driver clicks Edit on game 1 (`d.querySelector('[data-edit]').click()`) after load. Shots at 1200×900 and 420×800 (list + editor). Chrome flags: `--headless=new --screenshot` — NO `--disable-gpu` (kills WebGL2; and keep the habit consistent). Check: rows readable, editor rounds complete, pickers/photo/story visible, nothing overlapping.

- [ ] **Step 3: Run all tests, commit**

```bash
node --test test/
git add views/game/builder.html
git commit -m "feat: game builder page — create, rounds, locations, photos, share link"
```

---

### Task 4: ship it

- [ ] **Step 1:** `node --test test/` in the worktree → all pass.
- [ ] **Step 2:** merge + re-test on main:

```bash
cd /Users/andre/Projects/maptap-scoreboard
git merge --no-ff game-builder -m "feat: custom game builder (slice 2)"
node --test test/
```

- [ ] **Step 3:** push + manual deploy (CI never deploys):

```bash
git push
ssh root@46.224.233.5 'cd /root/maptap-scoreboard && git pull --ff-only && docker compose up -d --build'
ssh root@46.224.233.5 'curl -s localhost:3000/healthz'
```

- [ ] **Step 4:** cleanup:

```bash
git worktree remove .claude/worktrees/game-builder
git branch -d game-builder
```
