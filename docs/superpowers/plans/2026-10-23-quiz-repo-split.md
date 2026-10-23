# Quiz Repo Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the custom-games module out of `maptap-scoreboard` into its own repo `AndreWeigel/quiz`, deployed at quiz.andreweigel.me, with history carried, URLs at the root, data migrated, and the scoreboard redirecting old `/game/...` links.

**Architecture:** A fresh clone of the scoreboard is rewritten with `git filter-repo` so only the game files (flattened to `src/` and `views/`) and their design docs survive. A thin app shell (entry, config, password gate, upload, static photos) mounts the unchanged game router at `/`. The server runs it as a sibling container on port 3001 behind a new nginx vhost; the database file and referenced photos are copied over; the scoreboard then drops the module and 301-redirects `/game/*`.

**Tech Stack:** git filter-repo, Node ≥ 20, Express 4, better-sqlite3, Docker Compose, nginx + certbot (personal-cloud), `node --test`, headless Chrome.

**Spec:** `docs/superpowers/specs/2026-10-23-quiz-repo-split-design.md`

## Global Constraints

- Two repos are touched. **Tasks 1–5 work in `/Users/Shared/Project/quiz`** (the new repo; it IS the isolated workspace, no worktree needed). **Task 8 works in a worktree of `maptap-scoreboard`** (`git worktree add .claude/worktrees/quiz-split -b quiz-split`). Never rewrite history in the scoreboard checkout.
- This Mac has only Node 26: in any fresh checkout run `npm install --ignore-scripts` then `npm install --no-save better-sqlite3@13`; never commit a package.json change caused by that. Production is Node 20 via the Dockerfile.
- Repo name `quiz`, public, at github.com/AndreWeigel/quiz. Domain `quiz.andreweigel.me`, host port `3001`, container `quiz`.
- URLs at the root: `/<slug>`, `/admin`, `/live/<code>`, `/host/<code>`, `/api/...`, `/live/api/...`, `/uploads/<file>`, `/healthz`. After Task 4, `grep -n "/game" views/*.html` must print nothing.
- Photos are public static files (random 16-hex names). `POST /api/upload` and every admin route stay behind the admin password (`ADMIN_TOKEN`; unset = 503 locked).
- Outward actions (creating the GitHub repo, pushing, pushing to personal-cloud, running commands on the server) are listed where they happen; the controller confirms each with André before running it.
- Cutover order is strict: quiz verified on its domain (Task 7) before the scoreboard cleanup is deployed (Task 8).
- Commit messages: plain subject, no attribution trailers. Stage explicit paths.

---

### Task 1: Rewrite history into the new repo

**Files:**
- Create: `/Users/Shared/Project/quiz` (a filtered clone)

**Interfaces:**
- Produces: a git repo at `/Users/Shared/Project/quiz` on branch `main` whose tree is `src/{db,geo,live,routes,scoring}.js`, `views/{builder,live,play}.html`, `test/game-*.test.js` (5 files), `docs/HANDOVER-globe.md`, `docs/HANDOVER-globe-game.md`, `docs/superpowers/{specs,plans}/…` (the game docs), with their commits intact. No remote yet. GitHub repo `AndreWeigel/quiz` created (empty, public).

- [ ] **Step 1: Install the tool**

```bash
brew install git-filter-repo
```

- [ ] **Step 2: Fresh clone** (never the working checkout)

Clone the **local** checkout, not GitHub: local `main` holds the live-sessions, shape-targets and split commits that have not been pushed yet, and the filter must see them.

```bash
git clone /Users/Shared/Project/maptap-scoreboard /Users/Shared/Project/quiz
```

Then `git -C /Users/Shared/Project/quiz log --oneline | head -3` must show the split plan/spec commits at the top.

- [ ] **Step 3: Filter** — from `/Users/Shared/Project/quiz`:

```bash
git filter-repo --force \
  --path src/game/ --path views/game/ \
  --path test/game-db.test.js --path test/game-routes.test.js --path test/game-scoring.test.js \
  --path test/game-live.test.js --path test/game-geo.test.js \
  --path docs/HANDOVER-globe-game.md --path docs/HANDOVER-globe.md \
  --path docs/superpowers/specs/2026-09-01-game-builder.md \
  --path docs/superpowers/plans/2026-09-01-game-builder.md \
  --path docs/superpowers/plans/2026-09-01-play-page.md \
  --path docs/superpowers/specs/2026-10-22-live-sessions-design.md \
  --path docs/superpowers/plans/2026-10-22-live-sessions.md \
  --path docs/superpowers/specs/2026-10-22-shape-targets-design.md \
  --path docs/superpowers/plans/2026-10-22-shape-targets.md \
  --path docs/superpowers/specs/2026-10-23-quiz-repo-split-design.md \
  --path docs/superpowers/plans/2026-10-23-quiz-repo-split.md \
  --path-rename src/game/:src/ --path-rename views/game/:views/
```

- [ ] **Step 4: Verify**

```bash
git -C /Users/Shared/Project/quiz log --oneline | wc -l
git -C /Users/Shared/Project/quiz ls-files
git -C /Users/Shared/Project/quiz remote -v
```

Expected: a few dozen commits; the file list above and nothing else (no `package.json`, no `src/web.js`); no remotes (filter-repo removes `origin`).

- [ ] **Step 5: Create the GitHub repo** (outward — confirm with André first)

```bash
gh repo create AndreWeigel/quiz --public --description "Geography quiz on a globe — self-paced or live with a host. Built for the MapTap friends group, used for work quizzes too." 
git -C /Users/Shared/Project/quiz remote add origin https://github.com/AndreWeigel/quiz.git
```

Do **not** push yet (Task 6 pushes once tests pass).

---

### Task 2: Make the carried tests pass in the new layout

**Files:**
- Create: `package.json`, `src/config.js`, `src/auth.js`, `.gitignore`
- Modify: `src/routes.js` (VIEWS path), `src/live.js` (VIEWS path), the five `test/game-*.test.js` files

**Interfaces:**
- Produces: `src/auth.js` exporting `{ basicAuth, passwordGate }` (same semantics as the scoreboard's); `src/config.js` exporting `{ ADMIN_TOKEN, PORT, TZ, DB_PATH, UPLOADS_DIR }`; `gameRoutes` serving `views/` from the repo root; tests mounting the router at `/`.

- [ ] **Step 1: `package.json`**

```json
{
  "name": "quiz",
  "version": "1.0.0",
  "private": true,
  "description": "Geography quiz on a globe — self-paced or live with a host",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "express": "^4.19.0"
  }
}
```

- [ ] **Step 2: `.gitignore`**

```
node_modules/
data/
*.db
*.db-wal
*.db-shm
.env
.env.*
!.env.example
.DS_Store
.claude/worktrees/
.superpowers/
```

- [ ] **Step 3: Install** (the Node 26 recipe): `npm install --ignore-scripts` then `npm install --no-save better-sqlite3@13`. Commit `package-lock.json` as generated by the first command (it must list better-sqlite3@11, not 13 — check with `grep '"node_modules/better-sqlite3"' -A2 package-lock.json`).

- [ ] **Step 4: Run the carried tests to see them fail**

Run: `node --test test/`
Expected: every file FAILS with `Cannot find module '../src/game/...'` or `'../src/web'`.

- [ ] **Step 5: `src/config.js`**

```js
// All tunables in one place; env overrides so the container needs no rebuild.
module.exports = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',   // password for /admin, /host, /api/admin, /api/upload; '' = locked (503)
  PORT: Number(process.env.PORT) || 3000,
  TZ: process.env.TZ || 'Europe/Berlin',
  DB_PATH: 'data/game.db',
  UPLOADS_DIR: 'data/uploads',
};
```

- [ ] **Step 6: `src/auth.js`**

```js
// HTTP Basic Auth. Any username; the password must equal one of the named
// config secrets (compared in constant time). None of them set => locked (503).
const crypto = require('node:crypto');
const config = require('./config');

function passwordGate(realm, ...secretNames) {
  return function gate(req, res, next) {
    const secrets = secretNames.map((n) => config[n]).filter(Boolean);
    const deny = (msg, code = 401) => {
      if (code === 401) res.set('WWW-Authenticate', `Basic realm="quiz ${realm}"`);
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

module.exports = { basicAuth, passwordGate };
```

- [ ] **Step 7: VIEWS paths.** In `src/routes.js` change
`const VIEWS = path.join(__dirname, '..', '..', 'views', 'game');` to
`const VIEWS = path.join(__dirname, '..', 'views');` and the same in `src/live.js`. Update the header comment in `routes.js` ("mounted at /game from src/web.js") to "mounted at / from src/index.js".

- [ ] **Step 8: Test edits** (use the Edit tool with `replace_all` per file):

| File | Replace | With |
|---|---|---|
| all five | `require('../src/game/` | `require('../src/` |
| `game-routes.test.js`, `game-live.test.js` | `require('../src/web')` | `require('../src/auth')` |
| `game-routes.test.js` | `app.use('/game', gameRoutes(` | `app.use('/', gameRoutes(` |
| `game-live.test.js` | `app.use('/game', liveRoutes(` | `app.use('/', liveRoutes(` |
| `game-routes.test.js`, `game-live.test.js` | `${base}/game/` | `${base}/` |
| `game-routes.test.js` | the test title `GET /game/:slug serves…` | `GET /:slug serves…`; the comment `its data comes from /game/api/:slug` | `/api/:slug` |

Then `grep -n "/game" test/` must print nothing.

- [ ] **Step 9: Run the tests**

Run: `node --test test/`
Expected: all PASS (the same count as in the scoreboard's game files: 40-ish tests).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json .gitignore src/config.js src/auth.js src/routes.js src/live.js test/
git commit -m "chore: stand the quiz up as its own package — config, auth, root mount, test paths"
```

---

### Task 3: The app entry, its tests, and the container files

**Files:**
- Create: `src/index.js`, `test/app.test.js`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `basicAuth` (Task 2), `gameRoutes({ basicAuth, dbPath, uploadsDir })`.
- Produces: `createApp({ dbPath?, uploadsDir? }) → express app` exported from `src/index.js`; `node src/index.js` listens on `PORT`.

- [ ] **Step 1: Write the failing tests** — `test/app.test.js`:

```js
process.env.ADMIN_TOKEN = 's3cret'; // before config loads
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/index');

const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };

async function withApp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-'));
  const app = createApp({ dbPath: ':memory:', uploadsDir: path.join(dir, 'uploads') });
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`, dir); }
  finally { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('healthz answers before the /:slug catch-all', async () => {
  await withApp(async (base) => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});

test('admin pages and upload need the password; photos do not', async () => {
  await withApp(async (base, dir) => {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    assert.equal((await fetch(`${base}/admin`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'x' })).status, 401);
    const bad = await fetch(`${base}/api/upload`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(bad.status, 400);
    const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: { ...auth, 'content-type': 'image/png' }, body: Buffer.from('fakepng') });
    assert.equal(up.status, 200);
    const { file } = await up.json();
    assert.match(file, /^[a-f0-9]{16}\.png$/);
    assert.ok(fs.existsSync(path.join(dir, 'uploads', file)));
    const got = await fetch(`${base}/uploads/${file}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'fakepng');
  });
});

test('unknown slugs still 404 at the root', async () => {
  await withApp(async (base) => {
    const r = await fetch(`${base}/deadbeefdeadbeef`);
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'No such game.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/app.test.js`
Expected: FAIL with `Cannot find module '../src/index'`.

- [ ] **Step 3: `src/index.js`**

```js
// The quiz app: health check, public photos, the admin-only upload endpoint,
// and the game router mounted at the root. Nothing else lives on this domain.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { basicAuth } = require('./auth');
const gameRoutes = require('./routes');

const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function createApp({ dbPath = config.DB_PATH, uploadsDir = config.UPLOADS_DIR } = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' })); // pasted shapes are capped at 1 MB

  // Before the game router: its /:slug catch-all would answer this with a 404.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Photos are public. Names are 16 random hex chars that only ever appear on a
  // reveal, so a photo is as discoverable as the game link itself — no more.
  app.use('/uploads', express.static(uploadsDir, { maxAge: '365d', immutable: true }));

  // Random server-side names; client names never used. Before the router so
  // /api/:slug can't shadow it.
  app.post('/api/upload', basicAuth, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
    const ext = IMG_EXT[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'jpeg/png/webp/gif only' });
    }
    const file = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, file), req.body);
    res.json({ file });
  });

  app.use('/', gameRoutes({ basicAuth, dbPath, uploadsDir }));
  return app;
}

if (require.main === module) {
  process.env.TZ = config.TZ;
  createApp().listen(config.PORT, () => console.log(`[quiz] listening on http://localhost:${config.PORT}`));
}

module.exports = { createApp };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/`
Expected: all PASS, including the three new ones.

- [ ] **Step 5: Container files**

`Dockerfile`:

```dockerfile
# better-sqlite3 is a native module: compile it in a stage that has the
# toolchain, then copy node_modules into the slim runtime (same glibc).
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
```

`docker-compose.yml`:

```yaml
# quiz — geography quiz on a globe (quiz.andreweigel.me)
# Deployed on the personal-cloud server; nginx proxies quiz.andreweigel.me → 127.0.0.1:3001.
services:
  quiz:
    build: .
    container_name: quiz
    labels:
      - 'wud.watch=false'   # built here, not pulled: nothing for What's Up Docker to watch
    restart: always
    init: true              # node must not be PID 1 or SIGTERM is ignored and every stop gets SIGKILLed
    environment:
      ADMIN_TOKEN: ${ADMIN_TOKEN:-}   # password for /admin, /host, uploads. Empty = locked.
      TZ: ${TZ:-Europe/Berlin}
    volumes:
      - ./data:/app/data    # game.db + uploads. Back it up.
    ports:
      - "127.0.0.1:3001:3000"
```

`.env.example`:

```
# Copy to .env on the server. Compose reads it automatically.
# Admin password for /admin, /host/<code>, /api/admin/* and /api/upload (HTTP Basic Auth, any username).
# REQUIRED — leave empty and those pages return 503 (locked).
ADMIN_TOKEN=
TZ=Europe/Berlin
```

`.dockerignore`:

```
node_modules
data
.git
.superpowers
.claude
```

`.github/workflows/deploy.yml`: copy the scoreboard's file verbatim (`/Users/Shared/Project/maptap-scoreboard/.github/workflows/deploy.yml`). It is inert until the `DEPLOY_*` secrets exist on the new repo; say so in the README (Task 5).

- [ ] **Step 6: Build check** (Docker is installed here): `docker build -t quiz-local .` must succeed; then `docker rmi quiz-local`.

- [ ] **Step 7: Commit**

```bash
git add src/index.js test/app.test.js Dockerfile docker-compose.yml .env.example .dockerignore .github/workflows/deploy.yml
git commit -m "feat: app entry with health check, public photos and admin upload; container and deploy files"
```

---

### Task 4: Drop the `/game` prefix from the pages

**Files:**
- Modify: `views/play.html`, `views/live.html`, `views/builder.html`
- Scratch (not committed): `/tmp/quiz-split/stub.js`

**Interfaces:**
- Consumes: the root-mounted routes (`/api/:slug…`, `/live/api/:code…`, `/api/admin/…`, `/host/:code`, `/live/:code`, `/<slug>`, `/uploads/<file>`).

- [ ] **Step 1: Edits** (Edit tool; every occurrence):

`views/play.html`
- line ~96: `` fetch(`/game/api/${slug}${p}`, opts) `` → `` fetch(`/api/${slug}${p}`, opts) ``

`views/live.html`
- `const HOST = location.pathname.startsWith('/game/host/');` → `startsWith('/host/')`
- `` fetch(`/game/live/api/${code}${p}`, opts) `` → `` fetch(`/live/api/${code}${p}`, opts) ``
- `` const photoUrl = (file) => `/game/live/api/${code}/photo/${file}`; `` → `` `/live/api/${code}/photo/${file}` ``
- `` $('joinlink').value = `${location.origin}/game/live/${code}`; `` → `` `${location.origin}/live/${code}` ``
- `` fetch(`/game/api/admin/sessions/${code}/next`, … `` and `…/end` → `/api/admin/sessions/${code}/next` / `/end`
- `` new EventSource(`/game/live/api/${code}/events?token=…`) `` → `` `/live/api/${code}/events?token=…` ``

`views/builder.html`
- remove the line `<a class="back" href="/admin">← Admin</a>` (there is no hub on this domain)
- `href="/game/host/${esc(s.code)}"` → `href="/host/${esc(s.code)}"`
- `Share link: ${esc(location.origin)}/game/${esc(game.slug)}` → `${esc(location.origin)}/${esc(game.slug)}`
- `` const url = `${location.origin}/game/${slug}`; `` → `` `${location.origin}/${slug}` ``
- `window.open(\`/game/host/${code}\`, …)` → `` `/host/${code}` ``
- every `fetch('/game/api/admin/games` / `` fetch(`/game/api/admin/games… `` → `/api/admin/games…` (six places)

- [ ] **Step 2: Check** — `grep -n "/game" views/*.html` prints nothing. `node --test test/` still green.

- [ ] **Step 3: Smoke screenshots** — write `/tmp/quiz-split/stub.js` (create the folder with the Write tool; run from the repo root):

```js
// Real app, no auth, seeded game + revealed live session, drivers that wait in real time.
const path = require('node:path');
const fs = require('node:fs');
const express = require(path.resolve('node_modules/express'));
const { openGameDb } = require(path.resolve('src/db'));
const gameRoutes = require(path.resolve('src/routes'));

const DB = '/tmp/quiz-split/stub.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
const noauth = (_req, _res, next) => next();
const app = express();
app.use(express.json());
app.use('/uploads', express.static('/tmp/quiz-split'));
app.use('/', gameRoutes({ basicAuth: noauth, dbPath: DB, uploadsDir: '/tmp/quiz-split' }));

const db = openGameDb(DB);
const g = db.createGame('Trains');
db.saveGame(g.id, 'Trains', [
  { question: 'Highest railway station?', lat: 33.0106, lng: 91.6642, radius: 20, answer: 'Tanggula' },
  { question: 'First public steam railway?', lat: 54.52, lng: -1.55 },
]);
const s = db.createSession(g.id);
const fer = db.joinSession(s.id, 'Fer'), ana = db.joinSession(s.id, 'Ana');
db.advanceSession(s.code);
db.upsertGuess(s.id, fer.id, 0, { lat: 31.2, lng: 90.1, km: 240, points: 65 });
db.upsertGuess(s.id, ana.id, 0, { lat: 27.7, lng: 85.3, km: 880, points: 18 });
db.advanceSession(s.code);

app.get('/slow', (req, res) => setTimeout(() => res.type('gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')), +req.query.ms || 8000));
app.get('/drive-admin', (_req, res) => res.type('html').send(`<!doctype html><body style="margin:0">
  <iframe id="f" src="/admin" style="border:0;width:1200px;height:900px"></iframe>
  <script>setTimeout(() => document.getElementById('f').contentWindow.document.querySelector('[data-edit]').click(), 2500);</script>
  <img src="/slow?ms=6000" width="1" height="1"></body>`));
app.get('/drive-play', (_req, res) => res.type('html').send(`<!doctype html><body style="margin:0">
  <script>localStorage.setItem('maptap:player', 'Fer');</script>
  <iframe id="f" src="/${g.slug}" style="border:0;width:1200px;height:900px"></iframe>
  <script>const w = () => document.getElementById('f').contentWindow;
    setTimeout(() => w().document.getElementById('start').click(), 5000);
    setTimeout(() => w().playState.place(30, 90), 6000);
    setTimeout(() => w().playState.confirm(), 6500);</script>
  <img src="/slow?ms=16000" width="1" height="1"></body>`));
app.get('/drive-live', (_req, res) => res.type('html').send(`<!doctype html><body style="margin:0">
  <script>localStorage.setItem('maptap:live:${s.code}', '${fer.token}');</script>
  <iframe src="/live/${s.code}" style="border:0;width:1200px;height:900px"></iframe>
  <img src="/slow?ms=14000" width="1" height="1"></body>`));
app.listen(3105, () => console.log('quiz stub on :3105', g.slug, s.code));
```

Start it in the background, then one Chrome call each (no `--disable-gpu`):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/quiz-split/admin.png "http://localhost:3105/drive-admin"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/quiz-split/play.png "http://localhost:3105/drive-play"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/quiz-split/live.png "http://localhost:3105/drive-live"
```

Read the PNGs: **admin** shows the editor with two round cards (data loaded through `/api/admin/...`), the share link `http://localhost:3105/<slug>` without `/game`, and no "← Admin" link; **play** shows the reveal (gold dot, dashed line, points card) — proving `/api/<slug>/guess` resolved; **live** shows the revealed round with two named pins and the ranking — proving `/live/api/<code>/state` and the stream resolved. Fix and re-shoot until all three are right. Stop the stub (`lsof -ti :3105`), delete `/tmp/quiz-split/stub.db*`.

- [ ] **Step 4: Commit**

```bash
git add views/play.html views/live.html views/builder.html
git commit -m "feat: pages talk to the root-mounted API — no /game prefix on this domain"
```

---

### Task 5: Docs and the photo-import script

**Files:**
- Create: `README.md` (replace the scoreboard's), `scripts/import-photos.js`, `test/import-photos.test.js`
- Modify: `docs/HANDOVER-globe.md`

- [ ] **Step 1: Write the failing test** — `test/import-photos.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openGameDb } = require('../src/db');

test('import-photos copies the photos rounds reference, skips present ones, reports missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  try {
    const src = path.join(dir, 'src'), dest = path.join(dir, 'dest'), dbPath = path.join(dir, 'game.db');
    fs.mkdirSync(src); fs.mkdirSync(dest);
    fs.writeFileSync(path.join(src, 'aaaaaaaaaaaaaaaa.jpg'), 'A');
    fs.writeFileSync(path.join(src, 'bbbbbbbbbbbbbbbb.png'), 'B');
    fs.writeFileSync(path.join(dest, 'bbbbbbbbbbbbbbbb.png'), 'B-already');
    const db = openGameDb(dbPath);
    const g = db.createGame('t');
    db.saveGame(g.id, 't', [
      { question: 'a', lat: 1, lng: 1, photo: 'aaaaaaaaaaaaaaaa.jpg' },
      { question: 'b', lat: 1, lng: 1, photo: 'bbbbbbbbbbbbbbbb.png' },
      { question: 'c', lat: 1, lng: 1, photo: 'cccccccccccccccc.gif' },
      { question: 'd', lat: 1, lng: 1 },
    ]);
    db.raw.close();
    let out, status = 0;
    try { out = execFileSync(process.execPath, ['scripts/import-photos.js', src, dbPath, dest], { encoding: 'utf8' }); }
    catch (e) { out = e.stdout; status = e.status; }
    assert.equal(status, 1); // one missing
    assert.match(out, /3 referenced, 1 copied, 1 already present, 1 missing: cccccccccccccccc\.gif/);
    assert.equal(fs.readFileSync(path.join(dest, 'aaaaaaaaaaaaaaaa.jpg'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(dest, 'bbbbbbbbbbbbbbbb.png'), 'utf8'), 'B-already');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/import-photos.test.js` → FAIL (script missing; `execFileSync` throws with a non-1 status or ENOENT).

- [ ] **Step 3: `scripts/import-photos.js`**

```js
#!/usr/bin/env node
// One-off for the move from maptap-scoreboard: copy the photos that rounds
// reference out of another uploads folder. Safe to re-run (skips files already here).
// Usage: node scripts/import-photos.js <src-uploads-dir> [db=data/game.db] [dest=data/uploads]
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const [src, dbPath = 'data/game.db', dest = 'data/uploads'] = process.argv.slice(2);
if (!src) { console.error('usage: node scripts/import-photos.js <src-uploads-dir> [db] [dest]'); process.exit(2); }

const db = new Database(dbPath, { readonly: true });
const files = db.prepare('SELECT DISTINCT photo FROM rounds WHERE photo IS NOT NULL').all().map((r) => r.photo);
fs.mkdirSync(dest, { recursive: true });
let copied = 0, present = 0;
const missing = [];
for (const f of files) {
  const from = path.join(src, f), to = path.join(dest, f);
  if (fs.existsSync(to)) { present++; continue; }
  if (!fs.existsSync(from)) { missing.push(f); continue; }
  fs.copyFileSync(from, to);
  copied++;
}
console.log(`${files.length} referenced, ${copied} copied, ${present} already present, ${missing.length} missing${missing.length ? ': ' + missing.join(' ') : ''}`);
process.exit(missing.length ? 1 : 0);
```

- [ ] **Step 4: Run** — `node --test test/` → all PASS.

- [ ] **Step 5: `README.md`** — replace the whole file:

```markdown
# Quiz

A geography quiz on a globe. The host builds rounds ("Where is the highest
railway station in the world?"), each with a secret point or shape, an
optional photo and a story. Players tap the globe, score by distance, and see
the reveal. Two ways to play:

- **Self-paced**: share `/<slug>`; everyone plays whenever and lands on a leaderboard.
- **Live**: press "Go live" in the builder, share `/live/<code>`, and drive the
  rounds from `/host/<code>` while every screen shows the same reveal — truth,
  everyone's pins, the ranking — in real time.

Built for the MapTap friends group, lifted out of
[maptap-scoreboard](https://github.com/AndreWeigel/maptap-scoreboard) on
2026-10-23 (history carried; see `docs/superpowers/specs/2026-10-23-quiz-repo-split-design.md`).

Node, Express, SQLite (better-sqlite3), MapLibre GL from a CDN. No build step.

## Setup

```sh
npm install
npm test
ADMIN_TOKEN=secret npm start      # http://localhost:3000/admin
```

`ADMIN_TOKEN` is the password for everything admin-side (HTTP Basic Auth, any
username). Unset = those pages are locked (503).

## URLs

Public (the link is the access control — slugs and codes are unguessable):

- `GET /<slug>` — the self-paced play page
- `GET /live/<code>` — the live play page (type a name, wait for the host)
- `GET /uploads/<file>` — photos; 16 random hex chars, only ever shown on a reveal
- `GET /healthz`

Admin (`ADMIN_TOKEN`):

- `GET /admin` — the builder: games, rounds, photos, shapes, Go live, sessions
- `GET /host/<code>` — the host page for a live session

API — self-paced: `GET /api/<slug>` (rounds without answers), `POST /api/<slug>/guess`
`{ ord, lat, lng }` → `{ km, points, nearest, truth }`, `POST /api/<slug>/plays`,
`GET /api/<slug>/leaderboard`. Live: `GET /live/api/<code>`, `POST …/join`,
`POST …/guess` `{ token, ord, lat, lng }`, `GET …/state?token=`, `GET …/events?token=`
(Server-Sent Events), `GET …/photo/<file>` (only once that round is revealed).
Admin: `GET/POST /api/admin/games`, `GET/PUT/DELETE /api/admin/games/:id`,
`GET/POST /api/admin/games/:id/sessions`, `POST /api/admin/sessions/:code/next|end`,
`POST /api/upload` (raw `image/*`, ≤ 8 MB).

## Rounds

A round's answer is a point with a full-points `radius` in km, or a **shape**:
paste GeoJSON (a line or an area) into the round's Shape box — draw one at
geojson.io, export from OpenStreetMap at overpass-turbo.eu, simplify big files
at mapshaper.org; max 5,000 points; shapes crossing the 180° meridian are
rejected. Scoring is distance to the nearest part of the shape, zero inside an
area. `points = km <= radius ? 100 : round(100 · e^(−(km − radius)/500))`.

## Data

`data/game.db` (games, rounds, plays, guesses, sessions) and `data/uploads/`
(photos). Both live in the compose volume. **Back them up.**

`scripts/import-photos.js <dir>` copies the photos that rounds reference from
another uploads folder (used once for the move from the scoreboard).

## Running in production (Docker)

Runs on the personal-cloud server; nginx proxies `quiz.andreweigel.me` →
`127.0.0.1:3001` (config in the `personal-cloud` repo, `nginx/quiz.conf`).

```sh
git clone https://github.com/AndreWeigel/quiz.git ~/quiz
cd ~/quiz
cp .env.example .env          # set ADMIN_TOKEN
docker compose up -d --build
curl localhost:3001/healthz
```

Update: `git pull --ff-only && docker compose up -d --build`. The GitHub
Actions deploy workflow does the same over SSH once the `DEPLOY_*` secrets are
set on the repo; until then, deploy by hand.

The live-session stream sends `X-Accel-Buffering: no` and a ping every 25 s,
so nginx needs no special config.

## Read this before touching the globe

`docs/HANDOVER-globe.md` — the MapLibre recipe, the screenshot method, and the
hard-won lessons. The design records are under `docs/superpowers/`.
```

- [ ] **Step 6: `docs/HANDOVER-globe.md`** — edit in place:
  - Title → `# Handover: the globe stack (quiz)`; add a line under it: "Lifted from maptap-scoreboard on 2026-10-23; the people album (`/globe`) stayed there."
  - In the "Where the globe appears" table: delete the "People album" row; change the three game rows' paths to `views/play.html` / `GET /:slug` (`src/routes.js`), `views/builder.html` / `GET /admin`, `views/live.html` / `GET /live/:code`, `GET /host/:code` (`src/live.js`).
  - Replace every remaining `views/game/` with `views/`, `src/game/` with `src/`, `/game/api/` with `/api/`, and the mount-line example `app.use('/game', require('./game/routes')({ basicAuth }));` with `app.use('/', gameRoutes({ basicAuth, dbPath, uploadsDir }));`. The "Geocoding" paragraph's `views/users.html:243` reference becomes "(the scoreboard's `/users` page uses the same call)".
  - `grep -n "game/" docs/HANDOVER-globe.md` must print nothing afterwards.

- [ ] **Step 7: Commit**

```bash
git add README.md scripts/import-photos.js test/import-photos.test.js docs/HANDOVER-globe.md
git commit -m "docs: README for the quiz, handover paths updated; photo import script for the move"
```

---

### Task 6: Push, and the nginx config in personal-cloud

Outward actions — confirm each with André before running.

- [ ] **Step 1: Push the quiz repo**

```bash
git -C /Users/Shared/Project/quiz push -u origin main
```

Check `gh repo view AndreWeigel/quiz --web` shows the README.

- [ ] **Step 2: personal-cloud** — clone (or use the scratchpad clone, after `git pull`), add `nginx/quiz.conf`:

```nginx
# Nginx config for quiz (quiz.andreweigel.me)
# Port 80 only — certbot adds the 443 block (see scripts/ssl-setup.sh).

server {
    listen 80;
    server_name quiz.andreweigel.me;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

Commit `nginx/quiz.conf` with the subject `nginx: quiz.andreweigel.me → quiz container on 3001` and push to `main`.

---

### Task 7: Server — DNS, container, nginx, TLS, data migration

Run on the server (`ssh root@46.224.233.5`) by André, or by Claude with André's go-ahead per command. DNS first.

- [ ] **Step 1: DNS** (André, Gandi): `A  quiz  46.224.233.5`. Check from here: `dig +short quiz.andreweigel.me A` → `46.224.233.5`.

- [ ] **Step 2: Container**

```bash
git clone https://github.com/AndreWeigel/quiz.git ~/quiz
cd ~/quiz && cp .env.example .env && nano .env        # ADMIN_TOKEN=<the scoreboard's admin password, or a new one>
docker compose up -d --build
curl localhost:3001/healthz                           # {"ok":true}
```

- [ ] **Step 3: nginx + TLS**

```bash
cd ~/personal-cloud && git pull --ff-only
cp nginx/quiz.conf /etc/nginx/sites-available/quiz.conf
ln -s /etc/nginx/sites-available/quiz.conf /etc/nginx/sites-enabled/quiz.conf
nginx -t && systemctl reload nginx
./scripts/ssl-setup.sh quiz.andreweigel.me
curl -sI https://quiz.andreweigel.me/healthz | head -1      # HTTP/2 200
```

- [ ] **Step 4: Data** (scoreboard keeps running)

```bash
# consistent copy of the live database (WAL-safe)
docker compose -f ~/maptap-scoreboard/docker-compose.yml exec maptap \
  node -e "require('better-sqlite3')('data/game.db').backup('data/game-export.db').then(()=>console.log('ok'))"
mv ~/maptap-scoreboard/data/game-export.db ~/quiz/data/game.db
# photos that rounds reference
cd ~/quiz && docker compose run --rm -v /root/maptap-scoreboard/data/uploads:/src:ro quiz node scripts/import-photos.js /src
docker compose restart quiz
```

Expected: `N referenced, N copied, 0 already present, 0 missing`. Then `https://quiz.andreweigel.me/admin` lists the games with their photos.

---

### Task 8: Scoreboard cleanup and redirect

**Files (in a worktree of `maptap-scoreboard`, branch `quiz-split`):**
- Delete: `src/game/`, `views/game/`, `test/game-db.test.js`, `test/game-routes.test.js`, `test/game-scoring.test.js`, `test/game-live.test.js`, `test/game-geo.test.js`, `docs/HANDOVER-globe-game.md`, `docs/superpowers/specs/2026-09-01-game-builder.md`, `docs/superpowers/plans/2026-09-01-game-builder.md`, `docs/superpowers/plans/2026-09-01-play-page.md`, `docs/superpowers/specs/2026-10-22-live-sessions-design.md`, `docs/superpowers/plans/2026-10-22-live-sessions.md`, `docs/superpowers/specs/2026-10-22-shape-targets-design.md`, `docs/superpowers/plans/2026-10-22-shape-targets.md`
- Modify: `src/web.js` (line ~115 mount; `UPLOADS` stays — the upload endpoint and `/uploads` still serve the people album), `test/web.test.js`, `README.md`, `docs/HANDOVER-globe.md`, `.env.example`, `docker-compose.yml`

- [ ] **Step 1: Write the failing test** — append to `test/web.test.js`:

```js
test('/game/* redirects to the quiz domain with the prefix stripped', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/game/abc`, { redirect: 'manual' });
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.get('location'), 'https://quiz.andreweigel.me/abc');
    const l = await fetch(`${base}/game/live/xyz?x=1`, { redirect: 'manual' });
    assert.strictEqual(l.headers.get('location'), 'https://quiz.andreweigel.me/live/xyz?x=1');
    const root = await fetch(`${base}/game`, { redirect: 'manual' });
    assert.strictEqual(root.headers.get('location'), 'https://quiz.andreweigel.me');
  });
});
```

Run `node --test test/web.test.js` → the new test FAILS (the game page answers 404 / 200).

- [ ] **Step 2: `src/web.js`** — replace the mount block

```js
  // ---- Custom games (isolated module: src/game/, data/game.db). ----
  app.use('/game', require('./game/routes')({ basicAuth, uploadsDir: UPLOADS }));
```

with

```js
  // Custom games moved to quiz.andreweigel.me (2026-10-23); keep old share links alive.
  app.get(['/game', '/game/*'], (req, res) =>
    res.redirect(301, 'https://quiz.andreweigel.me' + req.originalUrl.replace(/^\/game/, '')));
```

- [ ] **Step 3: Delete the files** listed above (`git rm -r src/game views/game test/game-*.test.js docs/HANDOVER-globe-game.md` plus the seven docs).

- [ ] **Step 4: Text edits**
  - `test/web.test.js` line ~123 comment: drop "and the game builder".
  - `README.md`: delete the "Live sessions (…)" block, the "Shape rounds: …" paragraph, and the game-page sentences in the Endpoints section; in the `/uploads/*` bullet drop "including the ones on `/game/:slug` pages, so a shared game link now needs the password too"; add under Endpoints: `Custom quizzes moved to [quiz.andreweigel.me](https://quiz.andreweigel.me) ([repo](https://github.com/AndreWeigel/quiz)); \`/game/*\` redirects there.` Remove the "Read this, Fernando" subsections that describe the game module if any (grep `game` to find them).
  - `docs/HANDOVER-globe.md`: delete the three game rows from the table, the reveal-overlays paragraph, the "`/game/:slug` — the play page" section and the "custom games" architecture section; add one line near the top: "Custom games moved to the `quiz` repo on 2026-10-23 — see its `docs/HANDOVER-globe.md`." `grep -n "game" docs/HANDOVER-globe.md` should then only hit that line.
  - `.env.example` and `docker-compose.yml`: the `FRIENDS_TOKEN` comments lose the "custom game pages" clause.

- [ ] **Step 5: Run the suite** — `node --test test/` → all PASS (the suite shrinks by the five game files).

- [ ] **Step 6: Commit**

```bash
git add src/web.js test/web.test.js README.md docs/HANDOVER-globe.md .env.example docker-compose.yml
git commit -m "refactor: custom games moved to the quiz repo; /game/* redirects to quiz.andreweigel.me"
```

(The `git rm` in Step 3 already staged the deletions; `git status --short` before committing must show only staged entries.)

- [ ] **Step 7:** merge to local `main` (finishing-a-development-branch), push, deploy the scoreboard (`git pull --ff-only && docker compose up -d --build` on the server), `curl -sI https://maptap.andreweigel.me/game/x | grep -i location`.

---

### Task 9: End-to-end check and memory

- [ ] On `https://quiz.andreweigel.me`: `/healthz`; `/admin` (password) lists the migrated games, a round card shows its photo; open a game's share link in a private window, play one round, see the reveal photo; Go live → host page → join from a private window → Start round → Reveal → scoreboard.
- [ ] An old link `https://maptap.andreweigel.me/game/<slug>` lands on `https://quiz.andreweigel.me/<slug>`.
- [ ] Save a project memory: the quiz now lives at `/Users/Shared/Project/quiz`, repo `AndreWeigel/quiz`, deployed at `~/quiz` on the server, port 3001, nginx config in personal-cloud; the scoreboard no longer has the game module.
