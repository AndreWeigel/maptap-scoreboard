# Spec: Custom MapTap game (feature B — slices 2–4)

2026-09-01. Feature B from `docs/HANDOVER-globe-game.md`. Decisions in that
file are final. This spec
pins the details it left open. Slice 2 implements the data model + builder;
slices 3 (play + scoring) and 4 (leaderboard + polish) build on it.

## The game

André builds a quiz ("Daniel's 30th") out of rounds: a question with a secret
location, optional photo + story. Friends open a share link, tap the globe per
round, score by distance, see the reveal (distance, points, photo, story),
and land on a per-game leaderboard. No live sync; play whenever.

## Decisions pinned here (handover left them open)

- **Scoring** (`src/game/scoring.js`, slice 3): per round
  `points(km) = km <= 25 ? 100 : Math.round(100 * Math.exp(-(km - 25) / 500))`
  — perfect zone under 25 km, smooth decay after (≈82 at 125 km, ≈38 at
  500 km, ≈14 at 1000 km). Distance via haversine (own ~8-line function,
  same file). Both covered by tests. 5 rounds ≈ 500 max, like the scoreboard.
- **Slug**: `crypto.randomBytes(8).toString('hex')` (16 chars). The link IS
  the access control for playing.
- **Replays**: blocked. `UNIQUE(game_id, player_name COLLATE NOCASE)` on
  plays — a second finish with the same name is rejected; the play page shows
  the leaderboard instead.
- **Reorder**: up/down buttons, not drag-and-drop (phone-friendly, less code).
- **Rounds save**: replace-all on Save (same "save the whole registry"
  pattern as `/api/users`). No per-round PATCH.

## Isolation (handover directives, restated)

- Code in `src/game/` (`db.js`, `routes.js`, later `scoring.js`), pages in
  `views/game/`. ONE mount line in `src/web.js`:
  `app.use('/game', require('./game/routes')({ basicAuth }))`.
- Own DB `data/game.db` (better-sqlite3, `src/db.js` pattern), never
  `scores.db`. Tests use `:memory:` via a `dbPath` dep.
- Photos reuse the host's `POST /api/upload` + `data/uploads/` + `/uploads/`
  serving (slice 1). The photo filename regex is duplicated into the game
  module on purpose — no import from host code beyond `basicAuth`.

## Schema (`data/game.db`, WAL, foreign_keys ON)

```sql
games   (id INTEGER PK, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
         created_at TEXT NOT NULL);
rounds  (id INTEGER PK, game_id INT NOT NULL REFERENCES games ON DELETE CASCADE,
         ord INTEGER NOT NULL, question TEXT NOT NULL,
         lat REAL NOT NULL, lng REAL NOT NULL,
         city TEXT, country TEXT, photo TEXT, story TEXT,
         UNIQUE(game_id, ord));
plays   (id INTEGER PK, game_id INT NOT NULL REFERENCES games ON DELETE CASCADE,
         player_name TEXT NOT NULL, total INTEGER NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE(game_id, player_name COLLATE NOCASE));
guesses (play_id INT NOT NULL REFERENCES plays ON DELETE CASCADE,
         round_ord INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
         km REAL NOT NULL, points INTEGER NOT NULL,
         UNIQUE(play_id, round_ord));
```

## Routes (mounted under `/game`)

Admin (Basic Auth — same `basicAuth` as the rest of the admin):
- `GET /game/admin` → `views/game/builder.html`
- `GET /game/api/admin/games` → `{ games: [{ id, slug, title, created_at, rounds, plays }] }` (counts)
- `POST /game/api/admin/games` `{ title }` → full game row (random slug)
- `GET /game/api/admin/games/:id` → `{ game, rounds }`
- `PUT /game/api/admin/games/:id` `{ title, rounds: [...] }` → replace-all; 400 on any invalid round
- `DELETE /game/api/admin/games/:id` → cascade delete

Public:
- `GET /game/:slug` — slice 2 ships a placeholder (game title + "play page
  coming soon") so share links resolve; slice 3 replaces it with the play
  page. Unknown slug → 404.

Round validation at the PUT boundary: `question` non-empty trimmed string;
`lat` finite in [-90, 90], `lng` finite in [-180, 180]; `city`/`country`/
`story` optional trimmed strings; `photo` optional, must match
`^[a-f0-9]{16}\.(jpg|png|webp|gif)$`. `ord` is assigned server-side from
array order (0-based) — the client never sends it.

## Builder page (`views/game/builder.html`, slice 2)

Same dark visual language as `/users`. Two views in one page:
- **Game list**: each game → title, round count, play count, share link
  (`/game/<slug>`) with a Copy button, Edit, Delete (confirm). "+ New game"
  prompts for a title.
- **Editor**: title (click to rename), rounds as cards: question input,
  location via Nominatim city picker (same UX as /users) OR a raw "lat, lng"
  text input (either fills the same lat/lng), photo (upload via
  `/api/upload`, thumbnail, ✕), story textarea, ↑/↓/✕ buttons.
  "+ Round", Save (PUT replace-all), Back to list. Unsaved-changes guard.

## Slices 3–4 (for context, not built in slice 2)

3: play page `/game/:slug` — name prompt (localStorage), tap-to-guess globe
(MapLibre, reuse globe.html patterns), confirm, reveal (guess→truth line, km,
points, photo, story), next round; `POST /game/api/:slug/plays` writes
play + guesses in one transaction, rejects replays (409 → leaderboard).
4: per-game leaderboard + polish.

## Verification

- `node --test test/` (new: `test/game-db.test.js`, `test/game-routes.test.js`).
- Builder verified with headless-Chrome screenshots via the scratchpad stub
  (no `--disable-gpu` — it kills WebGL2; not needed for the builder page but
  the rule stands for slice 3).
