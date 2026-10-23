# Spec: Split the quiz into its own repo (`quiz`, quiz.andreweigel.me)

2026-10-23. The custom-games module (`src/game/`, `views/game/`: builder,
self-paced play, live sessions, shape targets) moves out of
`maptap-scoreboard` into a new repository `AndreWeigel/quiz`, deployed as its
own container at `quiz.andreweigel.me`. The scoreboard keeps the WhatsApp bot,
standings, the `/globe` people album and the feedback page, and redirects old
`/game/...` links to the new domain.

Decisions made with André on 2026-10-23, in brainstorming. Don't re-litigate:

| Question | Decision |
|---|---|
| Repo name / domain | `quiz` → github.com/AndreWeigel/quiz, served at `quiz.andreweigel.me`. Public, like the other repos. Claude creates it with `gh`. |
| History | **Carried**: `git filter-repo` on a fresh clone, keeping only the game files (with their path renames), so blame and the design-doc trail survive. |
| URLs | Mounted at the root. `quiz.andreweigel.me/<slug>`, `/admin`, `/live/<code>`, `/host/<code>`, `/api/...`. No `/game` prefix. |
| Cutover | Quiz goes live and is verified first; then the scoreboard removes the module and redirects `/game/...` → `https://quiz.andreweigel.me/...` (prefix stripped). No period of running both. |
| Photos | Public static files on the quiz domain. Filenames are 16 random hex chars; a photo is only discoverable from a reveal, consistent with "the link is the access control". |
| Quiz types | Not in scope. The quiz repo ships the globe quiz as-is; a `type` abstraction waits for a second quiz type. |
| Out of scope | CI secrets (workflow copied, inert until `DEPLOY_*` secrets are set, same as the scoreboard today), monitoring, a landing page listing games. |

## 1. Repo and history rewrite

Done on a **fresh clone** of `maptap-scoreboard` at `/Users/Shared/Project/quiz`
(the scoreboard checkout is never rewritten). Tool: `git filter-repo`
(`brew install git-filter-repo`).

Keep (everything else is dropped from history):

```
src/game/**            → src/**          (path-rename)
views/game/**          → views/**        (path-rename)
test/game-db.test.js, test/game-routes.test.js, test/game-scoring.test.js,
test/game-live.test.js, test/game-geo.test.js
docs/HANDOVER-globe-game.md
docs/HANDOVER-globe.md
docs/superpowers/specs/2026-09-01-game-builder.md
docs/superpowers/plans/2026-09-01-game-builder.md
docs/superpowers/plans/2026-09-01-play-page.md
docs/superpowers/specs/2026-10-22-live-sessions-design.md
docs/superpowers/plans/2026-10-22-live-sessions.md
docs/superpowers/specs/2026-10-22-shape-targets-design.md
docs/superpowers/plans/2026-10-22-shape-targets.md
docs/superpowers/specs/2026-10-23-quiz-repo-split-design.md   (this file)
docs/superpowers/plans/2026-10-23-quiz-repo-split.md          (its plan)
```

After the rewrite the clone has a `main` with only those paths. The origin
remote is removed and replaced by the new GitHub repo. The first new commit
on top adds the app shell (section 2) and is where `npm test` first passes.

## 2. The app shell (new files in `quiz`)

```
package.json          name "quiz", private, engines node >=20, deps: express ^4.19, better-sqlite3 ^11
                      scripts: start = node src/index.js, test = node --test test/
src/index.js          createApp() + listen (below)
src/config.js         ADMIN_TOKEN (env, '' = locked), PORT (env, 3000), TZ (env, Europe/Berlin),
                      DB_PATH 'data/game.db', UPLOADS_DIR 'data/uploads'
src/auth.js           passwordGate('admin', 'ADMIN_TOKEN') → basicAuth middleware, same semantics
                      as the scoreboard's: any username, password = ADMIN_TOKEN, 401 + WWW-Authenticate,
                      503 when the token is unset
test/app.test.js      shell tests (section 6)
README.md             rewritten for the quiz (section 7)
Dockerfile            copy of the scoreboard's (node:20-bookworm-slim, native build stage)
docker-compose.yml    service `quiz`, container_name `quiz`, init: true, restart: always,
                      env ADMIN_TOKEN, TZ; volume ./data:/app/data; ports "127.0.0.1:3001:3000"
.env.example          ADMIN_TOKEN=, TZ=Europe/Berlin
.gitignore            node_modules/, data/, *.db*, .env, .DS_Store, .claude/worktrees/, .superpowers/
.dockerignore         node_modules, data, .git
.github/workflows/deploy.yml   copy of the scoreboard's (SSH pull + rebuild); inert until secrets exist
```

`src/index.js`, in order:

1. `express()` with `express.json({ limit: '2mb' })` (shapes are capped at 1 MB).
2. `GET /healthz` → `{ ok: true }` — **before** the game router, whose `/:slug`
   catch-all would otherwise answer it.
3. `app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '365d', immutable: true }))` — public.
4. `POST /api/upload` behind `basicAuth` — the scoreboard's handler verbatim
   (raw `image/*` up to 8 MB, jpeg/png/webp/gif, random 16-hex filename).
   Registered **before** the game router so `/api/:slug` can't shadow it.
5. `app.use('/', gameRoutes({ basicAuth, dbPath: DB_PATH, uploadsDir: UPLOADS_DIR }))`.

`src/routes.js` (ex `src/game/routes.js`) and `src/live.js` keep their
signatures. Their internal `require('./db')`, `./scoring`, `./geo`, `./live`
already resolve after the flatten. `VIEWS` becomes
`path.join(__dirname, '..', 'views')`.

### Page edits (prefix removal)

| File | Change |
|---|---|
| `views/play.html` | `api = (p, opts) => fetch(\`/api/${slug}${p}\`)`; photo `src` `/uploads/<file>` unchanged |
| `views/live.html` | `HOST = location.pathname.startsWith('/host/')`; `api` base `/live/api/${code}`; host POSTs to `/api/admin/sessions/${code}/next|end`; join link `${origin}/live/${code}`; `photoUrl` → `/live/api/${code}/photo/<file>` |
| `views/builder.html` | all `/game/api/...` → `/api/...`; share link `${origin}/${slug}`; host-page links `/host/<code>`; Go live opens `/host/<code>`; "← Admin" back link removed (no hub on this domain) |

Nothing else in the pages changes. `location.pathname.split('/').filter(Boolean).pop()`
still yields the slug/code at the root.

### Test edits

The five game tests change `require('../src/game/x')` → `require('../src/x')`
and `require('../src/web')` → `require('../src/auth')` for `basicAuth`.
URLs in tests drop the `/game` prefix (they mount the router at `/game` in
`withServer`; change the mount to `/` and the paths to match, so the tests
exercise the real layout).

## 3. Server

Same pattern as maptap (own clone, own compose; nginx config lives in
`personal-cloud`):

1. **DNS** (André, at Gandi): `A quiz.andreweigel.me → 46.224.233.5`.
2. **personal-cloud**: add `nginx/quiz.conf` = `maptap.conf` with
   `server_name quiz.andreweigel.me;` and `proxy_pass http://127.0.0.1:3001;`.
   Commit, push.
3. **On the server** (`ssh root@46.224.233.5`):
   ```
   git clone https://github.com/AndreWeigel/quiz.git ~/quiz
   cd ~/quiz && cp .env.example .env && nano .env     # ADMIN_TOKEN
   docker compose up -d --build
   curl localhost:3001/healthz
   cd ~/personal-cloud && git pull --ff-only
   cp nginx/quiz.conf /etc/nginx/sites-available/quiz.conf
   ln -s /etc/nginx/sites-available/quiz.conf /etc/nginx/sites-enabled/quiz.conf
   nginx -t && systemctl reload nginx
   ./scripts/ssl-setup.sh quiz.andreweigel.me
   ```
   (`deploy-service.sh` expects `services/<name>/docker-compose.yml`, which
   maptap doesn't use either; the steps above are what it would do.)

The SSE stream needs no nginx change: the app sends `X-Accel-Buffering: no`
and pings every 25 s.

## 4. Data migration

Run on the server after the quiz container exists and before the scoreboard
cleanup is deployed (the scoreboard keeps running throughout):

```
# consistent copy while the scoreboard is live (WAL-safe)
sqlite3 ~/maptap-scoreboard/data/game.db ".backup '/root/quiz/data/game.db'"
# photos referenced by rounds only
cd ~/quiz && docker compose run --rm quiz node scripts/import-photos.js /scoreboard-uploads
```

`scripts/import-photos.js <srcDir>` (new, in `quiz`): opens `data/game.db`,
selects `DISTINCT photo FROM rounds WHERE photo IS NOT NULL`, copies each
existing `<srcDir>/<photo>` into `data/uploads/` (skips existing), prints
copied/missing counts. For the `docker compose run` the scoreboard's uploads
folder is bind-mounted read-only: add to `docker-compose.yml` a commented
example, or run it with `docker compose run --rm -v /root/maptap-scoreboard/data/uploads:/scoreboard-uploads:ro quiz node scripts/import-photos.js /scoreboard-uploads`.
(`sqlite3` CLI: `apt-get install -y sqlite3` if missing, or run the backup
through the scoreboard container: `docker compose exec maptap node -e "require('better-sqlite3')('data/game.db').backup('/app/data/game-copy.db')"` then `mv`.)

Session tables, players and guesses come along inside `game.db`. Nothing is
deleted from the scoreboard's `data/` by this process.

## 5. Scoreboard cleanup (one commit on `maptap-scoreboard`, after section 6's end-to-end check)

- Delete `src/game/`, `views/game/`, the five `test/game-*.test.js` files,
  `docs/HANDOVER-globe-game.md`, and the game specs/plans listed in section 1
  (they live on in `quiz`). Keep `docs/HANDOVER-globe.md` but drop its
  "Play a game" / "Builder location picker" / "Live session" table rows and the
  reveal-overlays paragraph; note at the top that games moved to the quiz repo.
- `src/web.js`: remove the mount line and the `uploadsDir` plumbing; add,
  where the mount was:
  ```js
  // Custom games moved to quiz.andreweigel.me (2026-10-23); keep old share links alive.
  app.get(['/game', '/game/*'], (req, res) =>
    res.redirect(301, 'https://quiz.andreweigel.me' + req.originalUrl.replace(/^\/game/, '')));
  ```
  so `/game/<slug>` → `/<slug>`, `/game/live/<code>` → `/live/<code>`,
  `/game/admin` → `/admin`. Test: `GET /game/abc` → 301 to
  `https://quiz.andreweigel.me/abc`; `GET /game/live/xyz?x=1` keeps the query.
- `README.md`: remove the game-related paragraphs (builder, `/game/:slug`
  pages, live sessions, shape rounds; the `/uploads` sentence loses "including
  the ones on `/game/:slug` pages"); add one line under Endpoints:
  "Custom quizzes moved to [quiz.andreweigel.me](https://quiz.andreweigel.me)
  ([repo](https://github.com/AndreWeigel/quiz)); `/game/*` redirects there."
- `test/web.test.js`: the comment on line 123 loses "and the game builder".
- `.env.example` / `docker-compose.yml`: the `FRIENDS_TOKEN` comments lose
  the "custom game pages" clause.
- Deploy the scoreboard as usual.

## 6. Verification

**quiz repo**
- `node --test test/`: the five carried test files (paths updated) plus
  `test/app.test.js`: `GET /healthz` 200 `{ ok: true }`; `GET /admin` 401
  without the password, 200 with it; `POST /api/upload` 401 without, 200 and
  a 16-hex filename with, 400 for a non-image; the uploaded file is served at
  `GET /uploads/<file>` with no password; `GET /nope` → 404 "No such game."
  (the catch-all still works at the root).
- Headless-Chrome smoke of `/admin` and one play page against a stub (the
  handover's lesson 3), confirming no fetch still points at `/game/...`
  (grep the three pages for `/game/` must return nothing).
- End to end on `https://quiz.andreweigel.me`: `/healthz`; `/admin` lists the
  migrated games with photos; a round plays with its reveal photo; Go live →
  host page → join from a private window → one round; an old
  `https://maptap.andreweigel.me/game/<slug>` link lands on the quiz page.

**scoreboard repo**
- `node --test test/` green after the removal; the redirect test above.

## 7. Docs in `quiz`

`README.md`: what it is (a host-driven or self-paced geography quiz on a
globe; built for the MapTap friends group, used for work quizzes too), setup
(`npm install`, `npm test`, `npm start`, `ADMIN_TOKEN`), the URL table
(`/admin`, `/<slug>`, `/live/<code>`, `/host/<code>`, the API summary from the
scoreboard README's game/live/shape sections with the prefix dropped), photos
(public by unguessable name), deploy (section 3 in short), data (`data/game.db`,
`data/uploads`, back them up), and a pointer to `docs/HANDOVER-globe.md` and
the specs. `docs/HANDOVER-globe.md` keeps only the quiz-relevant rows and
paths (the people album row goes; the builder picker, play and live rows get
their new paths).
