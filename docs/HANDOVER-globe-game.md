# Handover: People stories + "our own MapTap" game

> **Superseded for "what exists today" by [HANDOVER-globe.md](HANDOVER-globe.md)** — this file is the pre-implementation decision record.

2026-08-31. Written at the end of the session that built the `/globe` easter
egg. Read this whole file before touching code. The feature decisions below
are already made with André — don't re-litigate them; do write a proper spec
+ implementation plan from them (superpowers flow: writing-plans → execute).

## What we're building (two features)

**A. People stories on the existing globe** (small)
Click a player's card on `/globe` → photo(s) of that person with short
captions/stories underneath. The globe doubles as a "who we are" album.
Photos + bio text are entered on the existing `/users` admin page (with
upload), stored on the server.

**B. Game builder — custom MapTap-style quizzes** (the real project)
André creates a game (e.g. for Daniel's birthday) out of rounds:
"Where was Daniel born?", "Where did he study?", … Each round has a secret
location + optional photo + story. Friends get a link, tap the globe to
guess, score by distance, see the answer + photo + story after each round,
and land on a per-game leaderboard.

### Decisions already made (with André, 2026-08-31)

| Question | Decision |
|---|---|
| Play mode | Link in WhatsApp, play whenever, results collect on a leaderboard. NO live/party sync. |
| Who creates games | Only André, behind the existing admin Basic Auth. |
| Scoring | MapTap-style distance points (closer tap = more points per round). |
| Photos | Uploaded from the phone via the builder/admin pages, stored on the server. |
| Player identity | Type-your-name once, remembered in localStorage. Honor system. |
| Reveal | After each round: distance + points + photo + story, then next round. |
| Placement | Same repo/app, but isolated so it can be extracted later (own module, own routes, own DB file). |

## Architecture directives (separability)

- New code lives in `src/game/` (module) + `views/game/` (pages). Mounted
  into the existing Express app from `src/web.js` with ONE line, e.g.
  `app.use('/game', require('./game/routes')(deps))`.
- Game data goes in its OWN SQLite file `data/game.db` (better-sqlite3,
  same pattern as `src/db.js`) — never in `scores.db`. Uploads in
  `data/uploads/`, served read-only (e.g. `express.static` with maxAge).
- Reuse from the host app: `basicAuth` (export it from `src/web.js`),
  config, deploy pipeline. Do NOT entangle with scoreboard tables,
  users.json, or WhatsApp code.
- Feature A (people stories) is the exception — it belongs to the existing
  globe: media fields ride on `data/users.json` entries (photo paths +
  captions), uploads still under `data/uploads/`.
- Validate uploads at the boundary: images only, size cap (a few MB),
  random filenames, never trust client names.

## What exists today (map of the land)

- Plain Express app, no build step; `node --test` runs `test/*.test.js`
  (run `node --test test/` — bare `node --test` picks up stray worktrees).
- `src/web.js` — all routes. Public: `/`, `/api/standings`, `/globe`,
  `/api/globe`. Admin (Basic Auth, password = env `ADMIN_TOKEN`):
  `/users`, `/api/users`, `/admin`, `/import`, `/admin/summary`.
- `/api/globe` returns `{ layers: [{ id, label, points: [{label, city,
  country, lat, lng}] }] }` — built for more layers later. Game locations
  could surface here one day; don't break the shape.
- Player registry: `data/users.json` via `src/users.js` (`normalize()`
  whitelists fields — new fields must be added there or they're dropped on
  save). Each user: `name, ids, active` + optional `city, country, lat, lng`.
- `/users` admin page: city input queries Nominatim
  (`format=jsonv2&addressdetails=1&accept-language=en&limit=5`), user picks
  from top-5 list, structured city/country/lat/lng stored. Reuse this
  picker for game round locations (plus raw lat/lng entry as an option —
  André asked for coordinates input too).
- `/globe` page (`views/globe.html`): MapLibre GL 6.6.0, globe projection,
  Esri World Imagery raster tiles, dark sky/atmosphere. Player cards are
  DOM markers, ALWAYS visible: screen-space declutter pushes overlapping
  cards apart, SVG leader lines point to a `circle` layer dot at the true
  spot; manual horizon check (`degFromCenter > 78°` hides card) because DOM
  markers aren't occluded by the globe. Same-coordinate players merge into
  one card. Auto-spin until first pointer interaction. Card click →
  `flyTo`. Reuse this page's patterns for the game's tap-to-guess globe.
- Scoring code for the scoreboard lives in `src/scoring.js` (unrelated to
  game scoring, but follow its style).

## Hard-won technical lessons (do not rediscover these)

1. **MapLibre 6.6.0 is ESM-only, namespace import**:
   `import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.mjs'`
   (no default export). CSS from the same CDN path.
2. **Never load three.js-family libs via jsdelivr `/+esm`** — the bundle
   graph pulled THREE different three.js copies and the globe silently
   rendered black. If globe.gl/three is ever needed again: esm.sh with
   `?deps=three@<ver>` pins one shared copy. (Current page uses MapLibre,
   no three at all.)
3. **Headless screenshot verification** (how all UI here was tested):
   scratchpad stub server (`users-noauth.js`) serves views + fake APIs on
   :3101 with seeded players; screenshot via headless Chrome
   (`--headless=new --screenshot --window-size=1200,900`).
   `--virtual-time-budget` is UNRELIABLE for map/tile pages (nondeterministic
   half-loaded states) — instead the stub exposes `/slow?ms=25000` (a 1×1
   gif delayed N ms) and the driver page embeds it so Chrome's shutter
   waits in REAL time. A `/drive` page iframes the target and can jump the
   camera via `window.map` (exposed on the globe page as a debug handle).
4. Nominatim needs no key; city field can be `address.city || town ||
   village || hamlet || municipality || name`.
5. Esri World Imagery tiles:
   `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
   — keep the "Imagery © Esri & contributors" credit visible.

## Game design details to spec out (suggestions, not yet decided)

- Distance scoring: something like MapTap — per round max 100 pts, smooth
  decay with distance (e.g. `round(100 * exp(-km/500))`, tune the constant;
  perfect-ish under ~25 km). 5 rounds ≈ 500 max, familiar from the
  scoreboard. Keep the formula in one function with a test.
- Data sketch: `games(id, slug, title, created_at)`,
  `rounds(id, game_id, ord, question, lat, lng, city, country, photo,
  story)`, `plays(id, game_id, player_name, total, created_at)`,
  `guesses(play_id, round_ord, lat, lng, km, points)`. Slug = unguessable
  (the share link IS the access control for playing).
- Builder page (admin): create game, add rounds with the city picker OR
  raw lat/lng, upload photo, write story, drag to reorder, share link.
- Play page: name prompt (localStorage), globe with crosshair/tap, confirm
  guess, reveal (line from guess to truth, km, points, photo, story),
  next round, final leaderboard for that game.
- One playthrough per name per game (upsert or block replays — decide in spec).

## Working conventions in this repo (André's rules)

- ALWAYS create a git worktree before touching code (CLAUDE.md rule).
  `git worktree add .claude/worktrees/<name> -b <name>` from local HEAD
  (EnterWorktree branches from origin/main — check it has your base).
  `npm install` inside the worktree (native better-sqlite3).
- TDD with `node --test test/`; every UI change is verified with real
  screenshots before shipping (see lesson 3).
- When brainstorming new ideas with André: reflect understanding + ask
  clarifying questions FIRST (this is a saved memory rule).
- Merge to local main, run tests again, push, then deploy manually:
  `ssh root@46.224.233.5`, `cd /root/maptap-scoreboard`,
  `git pull --ff-only && docker compose up -d --build`, then check
  `curl localhost:3000/healthz`. CI deploy exists but its secrets were
  never set — it does not deploy.
- Specs/plans live in `docs/superpowers/`; spec first, then plan, then
  implement in slices. Suggested slices: (1) feature A people stories,
  (2) game data model + builder, (3) play page + scoring, (4) leaderboard
  + polish.
