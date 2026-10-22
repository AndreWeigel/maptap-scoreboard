# Spec: Live sessions — host-driven MapTap quiz for a remote group

2026-10-22. Adds a second way to play a custom game (the quizzes built at
`/game/admin`): a **live session** that André hosts over a video call. Everyone
plays the same round at the same time on their own computer, André reveals, and
every screen shows the true spot plus everyone's pins. The existing self-paced
share link (`/game/:slug`) is untouched.

Decisions made with André on 2026-10-22, in brainstorming. Don't re-litigate:

| Question | Decision |
|---|---|
| Reveal shows | Every player's pin on the globe, a line from each pin to the truth, a per-round ranking. |
| How a round ends | Host only. No timers, no auto-reveal. |
| Screens | Everyone is remote. Each player's own page *is* the big screen. No projector page. |
| Where it runs | Same server, same app. Join link is the access control (unguessable code). |
| Group size | 10–15 people. |
| Late joiners | Allowed at any time; they score 0 on rounds already revealed. |
| Editing a game mid-session | Not supported. The builder warns; no snapshotting. |
| Out of scope | Timers, a separate projector screen, kicking players, WhatsApp. |

## The experience

**Host.** On the builder's game list, "Go live" creates a session in the lobby
state and opens `/game/host/<code>`. The host page is the live page with a
control bar: join link + Copy, the player list with a tick for everyone who has
answered the current round and a "12 of 15" count, one **Next** button whose
label follows the state ("Start round 1" → "Reveal" → "Next round" → … →
"Show final scoreboard"), and **End session** (confirm). The host does not
play; their globe shows exactly what the players see. Closing the tab changes
nothing; reopen the host link and carry on. The builder lists sessions per game
so a running one can be found again.

**Player.** Opens `/game/live/<code>`, sees the game title and a name box.
After joining, the page holds one event stream open and redraws itself from
every snapshot the server pushes:

- *lobby* — "Waiting for the host to start", list of names so far.
- *round open* — question on top, globe below. Tap to drop a pin, drag to
  adjust, **Confirm**. The button becomes "Answer sent · tap again to change".
  No distance, no score, no truth shown.
- *revealed* — truth marker with its answer label; every player's pin, labelled
  with their name; a dashed line from each pin to the truth; the globe flies
  to frame all pins; a side panel with the round ranking (name, km, points,
  own row highlighted), then photo and story if the round has them.
- *finished* — the final scoreboard (name, total), own row highlighted.

A refresh, a dropped wifi, or a server restart brings the player back as
themselves via a token in `localStorage`, straight into the current state.

## Data (`data/game.db`, same file as the games — three new tables)

```sql
sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,           -- crypto.randomBytes(5).toString('hex'), 10 chars
  state       TEXT NOT NULL,                  -- 'lobby' | 'open' | 'revealed' | 'finished'
  current_ord INTEGER,                        -- NULL in lobby; the round's ord otherwise
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
session_players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,            -- crypto.randomBytes(16).toString('hex'); lives in the player's localStorage
  joined_at  TEXT NOT NULL,
  UNIQUE(session_id, name COLLATE NOCASE)
);
session_guesses (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
  round_ord  INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  km REAL NOT NULL, points INTEGER NOT NULL,  -- computed at guess time, hidden until reveal
  UNIQUE(session_id, player_id, round_ord)    -- re-tap before reveal = upsert
);
```

`openGameDb` creates these with `CREATE TABLE IF NOT EXISTS` (new tables, no
ALTER dance). The session store functions live in `src/game/db.js` next to the
game ones: `createSession(gameId)`, `getSession(code)`, `listSessions(gameId)`,
`advanceSession(code)`, `endSession(code)`, `joinSession(code, name)`,
`playerByToken(token)`, `upsertGuess(sessionId, playerId, ord, {lat,lng,km,points})`,
`sessionSnapshot(code)`.

### State machine (`advanceSession`, one transaction)

```
lobby     --Next--> open(ord = first round)
open      --Next--> revealed(same ord)
revealed  --Next--> open(ord = next round)   if a next round exists
revealed  --Next--> finished                 if it was the last round
finished  --Next--> 400 (nothing to do)
any       --End---> finished (finished_at set)
```

Rounds are read from `rounds` by ord at transition time. A game with zero
rounds cannot go live (400 on create).

**"Revealed rounds"** (used by standings, the photo route, and the snapshot)
means: in `open`, every ord < `current_ord`; in `revealed`, every ord ≤
`current_ord`; in `finished`, every round; in `lobby`, none. One helper,
`revealedOrds(session, rounds)`, is the only place this is computed.

### Scoring

`haversineKm` + `points(km, radius)` from `src/game/scoring.js`, unchanged.
Computed and stored when the guess lands. Per-player total = sum of stored
`points` over revealed rounds (rounds with no guess contribute 0). Final
ranking: total desc, then joined_at asc.

## Snapshot (what every client renders from)

One JSON shape, sent on first paint and on every change. Truth and guesses
appear only for rounds whose reveal has happened.

```jsonc
{
  "code": "a1b2c3d4e5", "title": "Trains of the world", "state": "revealed",
  "roundCount": 5,
  "round": { "ord": 2, "question": "Highest railway station in the world?" },   // null in lobby/finished
  "players": [ { "id": 7, "name": "Fer", "answered": true } ],                  // answered: has a guess for round.ord
  "reveal": {                                                                   // only when state === 'revealed'
    "truth": { "lat": 33.01, "lng": 91.66, "answer": "Tanggula…", "city": null, "country": "China",
               "photo": "deadbeef….jpg", "story": "…" },
    "guesses": [ { "playerId": 7, "name": "Fer", "lat": 31.2, "lng": 90.1, "km": 240.3, "points": 65 } ]
  },
  "standings": [ { "playerId": 7, "name": "Fer", "total": 265 } ],              // always; cumulative over revealed rounds
  "you": { "playerId": 7, "name": "Fer" }                                       // per-connection; null for the host / before join
}
```

The host receives the same snapshot (host page adds the join link itself from
`code`). Nothing per-player is secret except the token, so one shared payload
per session is fine; `you` is stamped per connection.

## Real-time: Server-Sent Events

`src/game/live.js` owns an in-memory `Map<code, Set<res>>`. Each
`GET /game/live/api/:code/events` adds its response, writes the current
snapshot as one `state` event, and is removed on `close`. `broadcast(code)`
recomputes the snapshot once and writes it to every connection. A comment line
(`: ping`) goes out every 25 s so proxies keep the connection open. Response
headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, `X-Accel-Buffering: no` (tells nginx not to buffer;
no nginx config change needed). `EventSource` reconnects on its own; the first
event after reconnect is a full snapshot, so clients never need to replay.

State is in SQLite; the connection map is the only in-memory thing and rebuilds
itself as clients reconnect after a restart.

## Routes (all inside the game module, mounted at `/game`)

Admin — `basicAuth`, same as the builder:

| Method | Path | Does |
|---|---|---|
| POST | `/game/api/admin/games/:id/sessions` | Create (lobby). 404 unknown game, 400 no rounds. → `{ code }` |
| GET | `/game/api/admin/games/:id/sessions` | `{ sessions: [{ code, state, current_ord, players, created_at, finished_at }] }` |
| POST | `/game/api/admin/sessions/:code/next` | `advanceSession` + broadcast. → snapshot. 400 if finished |
| POST | `/game/api/admin/sessions/:code/end` | `endSession` + broadcast. → snapshot |
| GET | `/game/host/:code` | `views/game/live.html` (host mode is detected from the path) |

Public — the code is the access control:

| Method | Path | Does |
|---|---|---|
| GET | `/game/live/:code` | `views/game/live.html`. 404 unknown code |
| GET | `/game/live/api/:code` | `{ title, roundCount, state }` — enough for the name screen |
| POST | `/game/live/api/:code/join` `{ name }` | Trim, ≤ 40 chars, non-empty. Existing name (case-insensitive) → 409. → `{ token, playerId, name }` + broadcast |
| POST | `/game/live/api/:code/guess` `{ token, ord, lat, lng }` | 401 bad token, 409 unless `state === 'open' && ord === current_ord`, 400 bad coords. Upsert, broadcast (answered flag), → `{ ok: true }` |
| GET | `/game/live/api/:code/events?token=` | SSE stream (token optional; sets `you`) |
| GET | `/game/live/api/:code/state?token=` | One snapshot, same shape (first paint, tests) |
| GET | `/game/live/api/:code/photo/:file` | Serves `uploads/<file>` only if `file` matches `PHOTO_FILE` and belongs to a round of this session's game whose ord ≤ the last revealed ord. 404 otherwise. `maxAge` 1 h |

The photo route is why `gameRoutes` gains a second dep: `uploadsDir`, passed
from `src/web.js` (which already computes it). Still one mount line.

Live routes are registered **before** the existing `/:slug` catch-all so
`/game/live/...` and `/game/host/...` don't fall into it.

## The page: `views/game/live.html`

One file for player and host. Same visual language and the globe recipe from
`docs/HANDOVER-globe.md` (MapLibre 6.6.0 ESM namespace import, Esri imagery,
globe projection, `window.map` debug handle). Host mode =
`location.pathname.startsWith('/game/host/')`; it hides the name box and shows
the control bar. Host actions call the admin endpoints; the browser already
holds the Basic Auth from opening the page.

Rendering is a pure function of the latest snapshot plus local pin state:
`render(snapshot)` switches on `state` and rebuilds the overlays. On
`open`, the client keeps the pin the player dragged until the server confirms
`answered`. On `revealed`, three geojson sources: `truth` (one point),
`pins` (one point per guess, `name` property, rendered as a circle layer plus a
`symbol` layer with the name), `lines` (one LineString per guess). Own pin in
cyan, others in white, truth in gold. `fitBounds` over truth + all pins,
`maxZoom` 9. Ranking panel reuses the reveal card styling from `play.html`
(`createElement`/`textContent` only — names are untrusted text).

Token storage key: `maptap:live:<code>`. On load: fetch `/state?token=`; if
`you` is null (no/invalid token) show the name box, else go straight to
rendering and open the event stream.

## Builder changes (`views/game/builder.html`)

- Game list: a **Go live** button per game (disabled when the game has no
  rounds). POSTs a session, then opens `/game/host/<code>` in a new tab.
- Game list: under each game, its sessions (state, player count, Open host
  link) — a small line, fetched from the sessions endpoint.
- Editor: on Save, if the game has a session in `open`/`revealed`/`lobby`,
  confirm("A live session is running on this game. Saving changes rounds under
  it. Continue?").

## Error handling

- Guess outside an open round (host revealed while the click was in flight)
  → 409; the page shows "Round closed" and waits for the next snapshot.
- Event stream drops → `EventSource` retries; the page shows a small
  "reconnecting…" hint until the next snapshot lands.
- Name taken → inline message, keep the box open.
- Lost token (cleared storage) → the player joins again under a new name;
  their previous rows stay. Acceptable for a 15-person game.

## Verification

- `node --test test/` — new `test/game-live.test.js`: state machine
  transitions (including End from each state and Next on finished → 400),
  join uniqueness, guess rejected unless open + current ord, guess upsert,
  reveal payload hides truth before reveal and includes all guesses after,
  late joiner has 0 for earlier rounds, photo route 404 before reveal / 200
  after, SSE endpoint sends a `state` event on connect and on `next`.
- `test/game-db.test.js` grows cases for the session store.
- `views/game/live.html` verified with headless Chrome screenshots via the
  scratchpad stub server (handover lesson 3): lobby, open with a pin, reveal
  with three pins, final scoreboard, host bar.
