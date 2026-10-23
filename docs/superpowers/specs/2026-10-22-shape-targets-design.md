# Spec: Shape targets — lines and areas as round answers

2026-10-22. A round's answer can be a **shape** (a railway line, the Great
Wall, a river, a country, a lake) instead of a single point. Scoring becomes
"how far from the nearest part of the shape", the reveal draws the shape, and
each player's line runs to their nearest point on it. Point rounds keep
working exactly as today.

Decisions made with André on 2026-10-22, in brainstorming. Don't re-litigate:

| Question | Decision |
|---|---|
| Shape kinds | Lines **and** areas (plus multi-point), in the same step. |
| Scoring | One rule for every shape: distance to the nearest part of the shape; zero on or inside it. The existing `radius` is the full-points margin (a corridor for a line, a grace margin outside an area). `points()` unchanged. |
| Getting shapes in | **Paste GeoJSON** into the builder, with a preview. No in-page drawing in this version; the builder links to geojson.io for drawing, overpass-turbo for OpenStreetMap exports, mapshaper for simplifying. |
| Geometry code | Hand-written, dependency-free, in the game module (`src/game/geo.js`). No Turf. |
| Known limitation | Shapes crossing the 180° meridian are rejected on paste (not supported). |
| Out of scope | In-builder drawing, server-side simplification, GeometryCollection, shapes on the self-paced leaderboard. |

## Data (`data/game.db`)

`rounds` gains one nullable column, added by `openGameDb` with the same
`PRAGMA table_info` + `ALTER TABLE` pattern as `answer`/`radius`:

```sql
ALTER TABLE rounds ADD COLUMN geometry TEXT;  -- GeoJSON Geometry as JSON text, or NULL
```

`NULL` means "point at lat/lng" — every existing round. `lat`/`lng` stay
`NOT NULL`: for a shape round they are the **anchor** (bounding-box centre),
set by the server at save time so the anchor can never disagree with the
shape. The builder also fills them on paste so the ⚠/📍 indicator behaves.

### Accepted input (at `PUT /game/api/admin/games/:id`, per round)

`round.geometry` may be absent/null, or any of:

- a GeoJSON **Geometry** of type `Point`, `MultiPoint`, `LineString`,
  `MultiLineString`, `Polygon`, `MultiPolygon`;
- a **Feature** → its `geometry` is used;
- a **FeatureCollection** → features' geometries are merged: all
  `LineString`/`MultiLineString` → one `MultiLineString`; all
  `Polygon`/`MultiPolygon` → one `MultiPolygon`; all `Point`/`MultiPoint` →
  one `MultiPoint`. Mixed kinds → 400 `"paste one kind of shape (all lines, or all areas)"`.

Normalisation, in `src/game/geo.js` `normalizeGeometry(input) → geometry | { error }`:

- strip `properties`, `bbox`, `id`, anything but `type` + `coordinates`;
- every position becomes `[lng, lat]` with exactly two finite numbers,
  `lng ∈ [-180, 180]`, `lat ∈ [-90, 90]` (extra elements such as altitude dropped);
- polygon rings are closed if the first and last positions differ;
- a `Point` (or single-position `MultiPoint`) collapses to a **point round**:
  `geometry` stored as `NULL`, `lat`/`lng` set from it;
- limits: ≤ **5,000 vertices** in total and ≤ **1 MB** of JSON text; over →
  400 `"shape too big — simplify it at mapshaper.org (max 5,000 points)"`;
- `LineString` needs ≥ 2 positions, a ring ≥ 4 (closed); anything else → 400 `"invalid shape"`.

`cleanRound` in `src/game/routes.js` calls `normalizeGeometry`; on success it
stores the JSON text and overwrites `lat`/`lng` with `bboxCenter(geometry)`.
Validation errors for geometry carry the message above in the 400 body
(`{ error, round: <index> }`) so the builder can show it on the right card.

### What the APIs return

Everywhere a round's truth is exposed (`GET /game/api/admin/games/:id`,
the self-paced `/guess` reveal, the live snapshot's `reveal.truth`), `geometry`
is included **parsed** (an object, not text), or `null`. The public
round list (`GET /game/api/:slug`, and the live snapshot's `round`) still
exposes only `ord` + `question` — the shape is the answer.

## Scoring

New `src/game/geo.js` (dependency-free, pure functions, fully unit-tested):

```js
haversineKm(lat1, lng1, lat2, lng2)              // moves here from scoring.js; scoring.js re-exports it
nearestOnGeometry(lat, lng, geometry) → { km, lat, lng }
//   Point/MultiPoint: nearest vertex.
//   LineString/MultiLineString: nearest point on any segment — great-circle
//     cross-track distance when the perpendicular foot lies within the
//     segment, else the nearer endpoint.
//   Polygon/MultiPolygon: inside the outer ring and outside every hole →
//     { km: 0, lat, lng } (the guess itself); otherwise nearest point on the
//     rings, treated as lines. Point-in-polygon = even-odd ray casting on
//     lng/lat (the 180° limitation lives here).
//   Multi*: minimum over parts.
bboxCenter(geometry) → { lat, lng }
normalizeGeometry(input) → geometry | { error }
```

`src/game/scoring.js` gains:

```js
// Distance from a guess to a round's answer: its shape, or its point.
distanceToRound(lat, lng, round) → { km, nearest: { lat, lng } }
```

`km` is rounded to one decimal as today. `points(km, radius)` is unchanged.
All three guess paths use `distanceToRound`:

- `POST /game/api/:slug/guess` → response gains `nearest`; `truth` gains `geometry`.
- `POST /game/api/:slug/plays` → per-round scoring via `distanceToRound` (stores km + points as today; `nearest` not stored).
- live `POST /game/live/api/:code/guess` → stores km + points as today.

The live snapshot computes `nearest` per guess at reveal time (not stored):
`reveal.guesses[i].nearest = { lat, lng }`, and `reveal.truth.geometry`.
At 15 players × 5,000 vertices that is trivial.

## The reveal (`views/game/play.html` and `views/game/live.html`)

Both pages replace the single `truth` point source with three layers on one
`truth` geojson source, added once on map load:

| Layer | Type | Shows | Paint |
|---|---|---|---|
| `truth-fill` | fill | areas | gold `#ffd15c`, opacity .25 |
| `truth-line` | line | lines and area outlines | gold, width 3 |
| `truth` | circle | points (and MultiPoint vertices) | as today |

The source gets the round's `geometry`, or a Point at lat/lng when `geometry`
is null — so point rounds render exactly as now. Each player's dashed line
goes from their pin to their `nearest` (self-paced: from the `/guess` response;
live: from the snapshot). The camera fits the shape's bounding box plus all
pins (`maxZoom` 9, same paddings as today). `clearGlobe`/`startRound` reset
the source to empty as now.

## The builder (`views/game/builder.html`)

Each round card gains a **Shape** row under the location row:

- A `<details>` block titled "Shape (line or area) — optional" containing a
  textarea "Paste GeoJSON here", a status line, a **Preview** button and a
  **Clear shape** button.
- Help line inside it with three links, opening in new tabs: "Draw one at
  geojson.io · Export from OpenStreetMap at overpass-turbo.eu · Simplify big
  files at mapshaper.org".
- On input: client-side `JSON.parse`; show `"LineString · 1,240 points"`,
  `"MultiPolygon · 3 parts · 812 points"`, or the parse error. On a valid
  shape set `r.geometry` to the parsed object, set `r.lat`/`r.lng` to the
  bounding-box centre, clear `city`/`country`, mark dirty. The textarea keeps
  the user's text; the status line is the truth.
- When a round has a shape: the `<details>` is open, the coords input shows
  the anchor and is read-only, the 🗺 button opens the picker in **preview
  mode** (shape drawn on the picker map via a `shape` geojson source + line
  and fill layers, map fitted to it, clicks ignored, hint "Clear the shape to
  pick a point"). **Clear shape** removes `r.geometry`, re-enables the point
  inputs, marks dirty.
- On Save: send `geometry` as the parsed object (or omit). A 400 with
  `round: i` scrolls to card `i` and shows the server message in its status line.

## Round shape rules (server is the authority)

| Input | Stored | lat/lng |
|---|---|---|
| no geometry | NULL | as sent |
| Point / 1-vertex MultiPoint | NULL | from the point |
| line / area / multi | normalised JSON text | bbox centre (server-set) |

## Verification

- `test/game-geo.test.js` (new): known answers — point on a segment → 0;
  equator segment `[0,0]→[10,0]`, guess at `(1, 5)` → ≈111.2 km with nearest
  `(0, 5)`; guess beyond an endpoint clamps to the endpoint; inside a square
  polygon → 0 and nearest = the guess; outside → distance to the nearest
  edge; inside a hole → distance to the hole ring; MultiLineString takes the
  minimum; `bboxCenter`; `normalizeGeometry`: Feature unwrap, FeatureCollection
  merge (lines, areas, mixed → error), ring auto-close, altitude dropped,
  vertex cap, size cap, bad coords, Point collapse.
- `test/game-routes.test.js`: PUT a line round → stored geometry parsed back,
  lat/lng = bbox centre; PUT bad geometry → 400 with `round` index; `/guess`
  on a line round returns `km`, `nearest`, `truth.geometry`; `/plays` scores
  a line round with the same km.
- `test/game-live.test.js`: a line round session → reveal snapshot carries
  `truth.geometry` and per-guess `nearest`; a guess on the line scores 100.
- `test/game-db.test.js`: `openGameDb` migrates a pre-geometry file in place.
- Headless-Chrome screenshots (handover lesson 3): self-paced reveal with a
  line and with an area; live reveal with a line (three pins, lines to nearest
  points); builder card with a pasted shape and the picker in preview mode.
