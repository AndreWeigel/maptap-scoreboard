# Shape Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A round's answer can be a line or an area (GeoJSON) instead of a point; scoring is distance to the nearest part of the shape, the reveal draws the shape in gold with each player's line to their nearest point, and the builder takes pasted GeoJSON with a preview.

**Architecture:** A new dependency-free `src/game/geo.js` owns all geometry (nearest point on a shape, point-in-polygon, bbox centre, GeoJSON normalisation). `src/game/scoring.js` gains one function, `distanceToRound`, that every guess path calls. Rounds get a nullable `geometry` column (JSON text, parsed on read). Both play pages render the `truth` source through fill/line/circle layers so a point round looks exactly as today. The builder adds a Shape box per round.

**Tech Stack:** Node ≥ 20, Express 4, better-sqlite3, MapLibre GL 6.6.0 (CDN ESM), `node --test`, headless Chrome screenshots.

**Spec:** `docs/superpowers/specs/2026-10-22-shape-targets-design.md`

## Global Constraints

- Work in a git worktree: `git worktree add .claude/worktrees/shape-targets -b shape-targets` from local HEAD, then inside it `npm install --ignore-scripts` and `npm install --no-save better-sqlite3@13` (this Mac has only Node 26; see the project memory). Never commit a package.json change.
- Run tests as `node --test test/`.
- Geometry code is hand-written in `src/game/geo.js`; no Turf, no new npm dependency. The game module stays liftable (no imports from host code beyond `basicAuth`).
- Accepted shape kinds: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, `MultiPolygon`; Feature unwrapped; FeatureCollection merged when all features are one kind.
- Limits: ≤ 5,000 vertices total, ≤ 1 MB JSON text. Error messages, verbatim: `"shape too big — simplify it at mapshaper.org (max 5,000 points)"`, `"paste one kind of shape (all lines, or all areas)"`, `"invalid shape"`.
- A pasted `Point` (or single-position `MultiPoint`) is stored as a point round: `geometry` NULL, lat/lng from the point. Any other shape: `geometry` stored as JSON text, lat/lng overwritten with the bbox centre by the server.
- Scoring: `points(km, radius)` unchanged; `km` = distance to the nearest part of the shape, 0 on or inside it, rounded to one decimal.
- Everywhere a round's truth is exposed, `geometry` is a parsed object or `null`. The public round list exposes only `ord` + `question`.
- Known limitation, documented not handled: areas crossing the 180° meridian.
- Untrusted text into the DOM via `createElement`/`textContent` (play pages) or the builder's `esc()` helper only.
- Screenshots: headless Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, never `--disable-gpu`, real-time wait via a `/slow` gif.
- Commit messages: plain subject, no attribution trailers. Stage explicit paths.

---

### Task 1: `src/game/geo.js` — geometry primitives and GeoJSON normalisation

**Files:**
- Create: `src/game/geo.js`
- Test: `test/game-geo.test.js`

**Interfaces:**
- Produces:
  - `haversineKm(lat1, lng1, lat2, lng2) → number`
  - `nearestOnGeometry(lat, lng, geometry) → { km, lat, lng }` (`lat`/`lng` of the nearest point, 5 decimals; `km` unrounded)
  - `bboxCenter(geometry) → { lat, lng }` (5 decimals)
  - `normalizeGeometry(input) → geometry | null | { error }` (`null` for `null`/`undefined` input; a clean `{ type, coordinates }` otherwise)
  - `MAX_VERTICES = 5000`, `MAX_BYTES = 1000000`

- [ ] **Step 1: Write the failing tests** — create `test/game-geo.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, nearestOnGeometry, bboxCenter, normalizeGeometry, MAX_VERTICES } = require('../src/game/geo');

const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
// GeoJSON positions are [lng, lat].
const equatorLine = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const donut = { type: 'Polygon', coordinates: [
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
] };

test('haversineKm: one degree of latitude is ~111.2 km', () => {
  near(haversineKm(0, 0, 1, 0), 111.19);
  assert.equal(haversineKm(5, 5, 5, 5), 0);
});

test('nearestOnGeometry: Point and MultiPoint pick the nearest vertex', () => {
  const p = nearestOnGeometry(1, 0, { type: 'Point', coordinates: [0, 0] });
  near(p.km, 111.19); assert.deepEqual([p.lat, p.lng], [0, 0]);
  const m = nearestOnGeometry(1, 9, { type: 'MultiPoint', coordinates: [[0, 0], [10, 0]] });
  assert.deepEqual([m.lat, m.lng], [0, 10]);
});

test('nearestOnGeometry: on a line segment → 0; perpendicular → foot of the perpendicular', () => {
  const on = nearestOnGeometry(0, 5, equatorLine);
  near(on.km, 0, 1e-6); assert.deepEqual([on.lat, on.lng], [0, 5]);
  const perp = nearestOnGeometry(1, 5, equatorLine);
  near(perp.km, 111.19); near(perp.lat, 0, 1e-4); near(perp.lng, 5, 1e-4);
});

test('nearestOnGeometry: beyond an endpoint clamps to the endpoint', () => {
  const r = nearestOnGeometry(1, 12, equatorLine);
  assert.deepEqual([r.lat, r.lng], [0, 10]);
  near(r.km, haversineKm(1, 12, 0, 10), 1e-6);
});

// A segment along a parallel (constant latitude) is NOT a great circle: the arc bulges
// slightly poleward mid-way (≈0.08° at lat 20 over 10° of longitude), so these tests
// allow that and check km against the returned nearest point.
test('nearestOnGeometry: MultiLineString takes the nearest part', () => {
  const g = { type: 'MultiLineString', coordinates: [[[0, 0], [10, 0]], [[0, 20], [10, 20]]] };
  const r = nearestOnGeometry(18, 5, g);
  near(r.lat, 20, 0.2); near(r.lng, 5, 0.01);
  near(r.km, haversineKm(18, 5, r.lat, r.lng), 1e-6);
});

test('nearestOnGeometry: inside a polygon → 0 and the guess itself; outside → nearest edge', () => {
  const inside = nearestOnGeometry(5, 5, square);
  assert.deepEqual(inside, { km: 0, lat: 5, lng: 5 });
  const outside = nearestOnGeometry(12, 5, square);
  near(outside.lat, 10, 0.1); near(outside.lng, 5, 0.01);
  near(outside.km, haversineKm(12, 5, outside.lat, outside.lng), 1e-6);
  assert.ok(outside.km > 200 && outside.km < 225);
});

test('nearestOnGeometry: inside a hole is outside the polygon — distance to the hole ring', () => {
  const r = nearestOnGeometry(5, 5, donut);
  near(r.km, haversineKm(5, 5, 5, 4), 0.5); // nearest hole edge is at lng 4 (or 6, lat 4, lat 6 — all equal)
  assert.ok(r.km > 100);
  const rim = nearestOnGeometry(2, 2, donut);
  assert.equal(rim.km, 0);
});

test('nearestOnGeometry: MultiPolygon — inside any part → 0', () => {
  const g = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]] };
  assert.equal(nearestOnGeometry(25, 25, g).km, 0);
  assert.ok(nearestOnGeometry(15, 15, g).km > 0);
});

test('bboxCenter', () => {
  assert.deepEqual(bboxCenter(square), { lat: 5, lng: 5 });
  assert.deepEqual(bboxCenter({ type: 'MultiPoint', coordinates: [[-10, 2], [30, 6]] }), { lat: 4, lng: 10 });
});

test('normalizeGeometry: null passes through; Feature unwrapped; properties dropped; altitude dropped', () => {
  assert.equal(normalizeGeometry(null), null);
  assert.equal(normalizeGeometry(undefined), null);
  const g = normalizeGeometry({ type: 'Feature', properties: { name: 'x' }, geometry: { type: 'LineString', coordinates: [[0, 0, 99], [1, 1, 99]] } });
  assert.deepEqual(g, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
});

test('normalizeGeometry: FeatureCollection of lines → MultiLineString; of areas → MultiPolygon; mixed → error', () => {
  const lines = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[2, 2], [3, 3]]] } },
  ] };
  assert.deepEqual(normalizeGeometry(lines), { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] });
  const areas = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: square }, { type: 'Feature', geometry: square },
  ] };
  assert.equal(normalizeGeometry(areas).type, 'MultiPolygon');
  assert.equal(normalizeGeometry(areas).coordinates.length, 2);
  const mixed = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: square }, { type: 'Feature', geometry: equatorLine }] };
  assert.deepEqual(normalizeGeometry(mixed), { error: 'paste one kind of shape (all lines, or all areas)' });
});

test('normalizeGeometry: rings auto-close; too-short line/ring, bad coords, bad type → "invalid shape"', () => {
  const open = normalizeGeometry({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]] });
  assert.deepEqual(open.coordinates[0], [[0, 0], [10, 0], [10, 10], [0, 0]]);
  for (const bad of [
    { type: 'LineString', coordinates: [[0, 0]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] },
    { type: 'LineString', coordinates: [[0, 91], [1, 1]] },
    { type: 'LineString', coordinates: [[181, 0], [1, 1]] },
    { type: 'LineString', coordinates: [['a', 0], [1, 1]] },
    { type: 'GeometryCollection', geometries: [] },
    { type: 'Circle', coordinates: [0, 0] },
    'not json',
    42,
  ]) assert.deepEqual(normalizeGeometry(bad), { error: 'invalid shape' }, JSON.stringify(bad));
});

test('normalizeGeometry: accepts a JSON string; Point stays a Point; 1-vertex MultiPoint collapses to Point', () => {
  assert.deepEqual(normalizeGeometry('{"type":"Point","coordinates":[1,2]}'), { type: 'Point', coordinates: [1, 2] });
  assert.deepEqual(normalizeGeometry({ type: 'MultiPoint', coordinates: [[1, 2]] }), { type: 'Point', coordinates: [1, 2] });
  assert.equal(normalizeGeometry({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: equatorLine }] }).type, 'LineString');
});

test('normalizeGeometry: vertex and byte caps', () => {
  const big = { type: 'LineString', coordinates: Array.from({ length: MAX_VERTICES + 1 }, (_, i) => [i / 1000, 0]) };
  assert.deepEqual(normalizeGeometry(big), { error: 'shape too big — simplify it at mapshaper.org (max 5,000 points)' });
  const fat = JSON.stringify({ type: 'LineString', coordinates: [[0, 0], [1, 1]], pad: 'x'.repeat(1000001) });
  assert.deepEqual(normalizeGeometry(fat), { error: 'shape too big — simplify it at mapshaper.org (max 5,000 points)' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-geo.test.js`
Expected: FAIL with `Cannot find module '../src/game/geo'`.

- [ ] **Step 3: Create `src/game/geo.js`**

```js
// Geometry for shape rounds: nearest point on a GeoJSON shape, point-in-polygon,
// bbox centre, and GeoJSON normalisation. Dependency-free on purpose (the game
// module stays liftable). GeoJSON positions are [lng, lat]; our API uses (lat, lng).
const R = 6371, rad = Math.PI / 180, deg = 180 / Math.PI;
const MAX_VERTICES = 5000;
const MAX_BYTES = 1000000;
const ERR_BIG = 'shape too big — simplify it at mapshaper.org (max 5,000 points)';
const ERR_MIXED = 'paste one kind of shape (all lines, or all areas)';
const ERR_INVALID = 'invalid shape';

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- unit-sphere vectors for great-circle segments ----
const toVec = (lat, lng) => {
  const p = lat * rad, l = lng * rad;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const fromVec = ([x, y, z]) => ({ lat: Math.atan2(z, Math.hypot(x, y)) * deg, lng: Math.atan2(y, x) * deg });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const angle = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));

// Nearest point to P on the great-circle arc A→B (all as {lat,lng}).
function nearestOnSegment(p, a, b) {
  const P = toVec(p.lat, p.lng), A = toVec(a.lat, a.lng), B = toVec(b.lat, b.lng);
  const n = cross(A, B), nl = len(n);
  if (nl > 1e-12) {
    const N = scale(n, 1 / nl);
    const f = sub(P, scale(N, dot(P, N))), fl = len(f); // foot of P on the great circle
    if (fl > 1e-12) {
      const F = scale(f, 1 / fl);
      if (Math.abs(angle(A, F) + angle(F, B) - angle(A, B)) < 1e-9) return fromVec(F); // foot lies on the arc
    }
  }
  return angle(P, A) <= angle(P, B) ? a : b; // degenerate or outside the arc: nearer endpoint
}

// Even-odd ray casting on lng/lat. Known limitation: rings crossing the 180° meridian.
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (lat, lng, rings) => inRing(lat, lng, rings[0]) && !rings.slice(1).some((h) => inRing(lat, lng, h));

const r5 = (x) => +x.toFixed(5);

function nearestOnGeometry(lat, lng, g) {
  let best = null;
  const consider = (c) => { if (!best || c.km < best.km) best = c; };
  const pt = ([x, y]) => consider({ km: haversineKm(lat, lng, y, x), lat: y, lng: x });
  const line = (coords) => {
    for (let i = 1; i < coords.length; i++) {
      const n = nearestOnSegment({ lat, lng }, { lat: coords[i - 1][1], lng: coords[i - 1][0] }, { lat: coords[i][1], lng: coords[i][0] });
      consider({ km: haversineKm(lat, lng, n.lat, n.lng), lat: n.lat, lng: n.lng });
    }
  };
  const poly = (rings) => { if (inPolygon(lat, lng, rings)) consider({ km: 0, lat, lng }); else rings.forEach(line); };
  switch (g.type) {
    case 'Point': pt(g.coordinates); break;
    case 'MultiPoint': g.coordinates.forEach(pt); break;
    case 'LineString': line(g.coordinates); break;
    case 'MultiLineString': g.coordinates.forEach(line); break;
    case 'Polygon': poly(g.coordinates); break;
    case 'MultiPolygon': g.coordinates.forEach(poly); break;
    default: throw new Error(`unsupported geometry ${g.type}`);
  }
  return { km: best.km, lat: r5(best.lat), lng: r5(best.lng) };
}

function positionsOf(g) {
  const out = [];
  const walk = (c) => (typeof c[0] === 'number' ? out.push(c) : c.forEach(walk));
  walk(g.coordinates);
  return out;
}

function bboxCenter(g) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [x, y] of positionsOf(g)) {
    if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
    if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
  }
  return { lat: r5((minLat + maxLat) / 2), lng: r5((minLng + maxLng) / 2) };
}

// ---- normalisation of pasted GeoJSON ----
const KIND = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'area', MultiPolygon: 'area' };

// A clean [lng, lat] or null.
function cleanPos(p) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const x = p[0], y = p[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 180 || Math.abs(y) > 90) return null;
  return [x, y];
}
const cleanLine = (c) => {
  if (!Array.isArray(c) || c.length < 2) return null;
  const out = c.map(cleanPos);
  return out.includes(null) ? null : out;
};
const cleanRing = (c) => {
  const out = cleanLine(c);
  if (!out) return null;
  const [fx, fy] = out[0], [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out.length < 4 ? null : out;
};
const cleanPoly = (rings) => {
  if (!Array.isArray(rings) || !rings.length) return null;
  const out = rings.map(cleanRing);
  return out.includes(null) ? null : out;
};

// Flatten one geometry into { kind, parts } where parts are positions / lines / polygons.
function flatten(g) {
  if (!g || typeof g !== 'object' || !KIND[g.type]) return null;
  const kind = KIND[g.type], c = g.coordinates;
  let parts;
  if (g.type === 'Point') parts = [cleanPos(c)];
  else if (g.type === 'MultiPoint') parts = Array.isArray(c) ? c.map(cleanPos) : [null];
  else if (g.type === 'LineString') parts = [cleanLine(c)];
  else if (g.type === 'MultiLineString') parts = Array.isArray(c) ? c.map(cleanLine) : [null];
  else if (g.type === 'Polygon') parts = [cleanPoly(c)];
  else parts = Array.isArray(c) ? c.map(cleanPoly) : [null];
  return !parts.length || parts.includes(null) ? null : { kind, parts };
}

function normalizeGeometry(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES) return { error: ERR_BIG };
    try { input = JSON.parse(input); } catch { return { error: ERR_INVALID }; }
  }
  if (!input || typeof input !== 'object') return { error: ERR_INVALID };
  if (JSON.stringify(input).length > MAX_BYTES) return { error: ERR_BIG };
  let geoms;
  if (input.type === 'Feature') geoms = [input.geometry];
  else if (input.type === 'FeatureCollection') geoms = Array.isArray(input.features) ? input.features.map((f) => f && f.geometry) : [];
  else geoms = [input];
  const flat = geoms.map(flatten);
  if (!flat.length || flat.includes(null)) return { error: ERR_INVALID };
  if (new Set(flat.map((f) => f.kind)).size > 1) return { error: ERR_MIXED };
  const kind = flat[0].kind, parts = flat.flatMap((f) => f.parts);
  const vertices = kind === 'point' ? parts.length : kind === 'line' ? parts.reduce((s, l) => s + l.length, 0)
    : parts.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
  if (vertices > MAX_VERTICES) return { error: ERR_BIG };
  if (kind === 'point') return parts.length === 1 ? { type: 'Point', coordinates: parts[0] } : { type: 'MultiPoint', coordinates: parts };
  if (kind === 'line') return parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts };
  return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
}

module.exports = { haversineKm, nearestOnGeometry, bboxCenter, normalizeGeometry, MAX_VERTICES, MAX_BYTES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/game-geo.test.js`
Expected: all 13 PASS. If the perpendicular test is off by more than 0.05 km, the arc check tolerance (`1e-9`) is the first suspect.

- [ ] **Step 5: Commit**

```bash
git add src/game/geo.js test/game-geo.test.js
git commit -m "feat(game): geometry primitives and GeoJSON normalisation for shape rounds"
```

---

### Task 2: Scoring and storage — `distanceToRound`, the `geometry` column

**Files:**
- Modify: `src/game/scoring.js` (whole file is 20 lines)
- Modify: `src/game/db.js` (SCHEMA `rounds` table; the ALTER block in `openGameDb`; `insertRound`; `replaceRounds`; `getGame`)
- Test: `test/game-scoring.test.js` (append), `test/game-db.test.js` (append)

**Interfaces:**
- Consumes: `haversineKm`, `nearestOnGeometry` from Task 1.
- Produces:
  - `scoring.js`: `distanceToRound(lat, lng, round) → { km, nearest: { lat, lng } }` with `km` rounded to 1 decimal; `haversineKm` and `points` still exported from `scoring.js`.
  - `db.js`: `rounds.geometry` column; `saveGame(id, title, rounds)` accepts `round.geometry` as an object (or null/undefined) and stores JSON text; `getGame`/`getGameBySlug` return each round's `geometry` as a parsed object or `null`.

- [ ] **Step 1: Write the failing tests** — append to `test/game-scoring.test.js`:

```js
const { distanceToRound } = require('../src/game/scoring');

test('distanceToRound: point round → haversine to the point; shape round → nearest on the shape', () => {
  const pt = distanceToRound(1, 0, { lat: 0, lng: 0, geometry: null });
  assert.equal(pt.km, 111.2);
  assert.deepEqual(pt.nearest, { lat: 0, lng: 0 });
  const line = distanceToRound(1, 5, { lat: 0, lng: 5, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]] } });
  assert.equal(line.km, 111.2);
  assert.deepEqual(line.nearest, { lat: 0, lng: 5 });
  const inside = distanceToRound(5, 5, { lat: 5, lng: 5, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } });
  assert.deepEqual(inside, { km: 0, nearest: { lat: 5, lng: 5 } });
});
```

and append to `test/game-db.test.js`:

```js
test('rounds keep geometry as JSON text and return it parsed; null for point rounds', () => {
  const db = openGameDb(':memory:');
  const g = db.createGame('shapes');
  const line = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
  db.saveGame(g.id, 'shapes', [round('Line?', 0, 5, { geometry: line }), round('Point?', 1, 2)]);
  const { rounds } = db.getGame(g.id);
  assert.deepEqual(rounds[0].geometry, line);
  assert.equal(rounds[1].geometry, null);
  assert.equal(db.raw.prepare('SELECT typeof(geometry) t FROM rounds WHERE ord = 0').get().t, 'text');
});

test('openGameDb adds the geometry column to a pre-shape db file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamedb-'));
  const file = path.join(dir, 'game.db');
  try {
    const Database = require('better-sqlite3');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL, question TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
        city TEXT, country TEXT, photo TEXT, story TEXT, answer TEXT, radius REAL, UNIQUE(game_id, ord));
      INSERT INTO games (slug, title, created_at) VALUES ('aaaabbbbccccdddd', 'old', 'now');
      INSERT INTO rounds (game_id, ord, question, lat, lng) VALUES (1, 0, 'q', 1, 2);
    `);
    old.close();
    const db = openGameDb(file);
    assert.equal(db.getGame(1).rounds[0].geometry, null);
    db.saveGame(1, 'old', [round('q', 1, 2, { geometry: { type: 'Point', coordinates: [2, 1] } })]);
    assert.deepEqual(db.getGame(1).rounds[0].geometry, { type: 'Point', coordinates: [2, 1] });
    db.raw.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

(`fs`, `os`, `path`, `round` and `openGameDb` are already imported at the top of that file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-scoring.test.js test/game-db.test.js`
Expected: the three new tests FAIL (`distanceToRound is not a function`; `rounds[0].geometry` is `undefined`).

- [ ] **Step 3: `src/game/scoring.js`** — replace the whole file:

```js
// Distance scoring for custom games (spec-pinned formula). Kept dependency-free
// so the whole game module stays liftable. Geometry lives in ./geo.
const { haversineKm, nearestOnGeometry } = require('./geo');

// Full points within the round's tolerance radius, smooth decay beyond it.
function points(km, radius = 25) {
  return km <= radius ? 100 : Math.round(100 * Math.exp(-(km - radius) / 500));
}

// Distance from a guess to a round's answer: its shape, or its point. km has one decimal.
function distanceToRound(lat, lng, round) {
  const n = round.geometry
    ? nearestOnGeometry(lat, lng, round.geometry)
    : { km: haversineKm(lat, lng, round.lat, round.lng), lat: round.lat, lng: round.lng };
  return { km: Math.round(n.km * 10) / 10, nearest: { lat: n.lat, lng: n.lng } };
}

module.exports = { haversineKm, points, distanceToRound };
```

- [ ] **Step 4: `src/game/db.js`**

In `SCHEMA`, the `rounds` table: change `answer   TEXT, radius REAL,` to `answer   TEXT, radius REAL, geometry TEXT,`.

In the ALTER block after the `radius` line add:

```js
  if (!cols.includes('geometry')) db.exec('ALTER TABLE rounds ADD COLUMN geometry TEXT');
```

`insertRound`: add `geometry` to both the column list and the VALUES list (`…, answer, radius, geometry) VALUES (…, @answer, @radius, @geometry)`).

In `replaceRounds`, the `insertRound.run({ … })` object gains:

```js
      geometry: r.geometry ? JSON.stringify(r.geometry) : null,
```

In `getGame`, parse on read:

```js
      const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY ord').all(id)
        .map((r) => ({ ...r, geometry: r.geometry ? JSON.parse(r.geometry) : null }));
```

- [ ] **Step 5: Run the tests to verify they pass, then the whole suite**

Run: `node --test test/game-scoring.test.js test/game-db.test.js` then `node --test test/`
Expected: all PASS. (`getGameBySlug` goes through `getGame`, so it is covered.)

- [ ] **Step 6: Commit**

```bash
git add src/game/scoring.js src/game/db.js test/game-scoring.test.js test/game-db.test.js
git commit -m "feat(game): distanceToRound and a geometry column on rounds"
```

---

### Task 3: Routes — accept shapes on save, score against them, expose them on the reveal

**Files:**
- Modify: `src/game/routes.js` (`cleanRound`, the `PUT /api/admin/games/:id` handler, `POST /api/:slug/guess`, `POST /api/:slug/plays`)
- Test: `test/game-routes.test.js` (append)

**Interfaces:**
- Consumes: `normalizeGeometry`, `bboxCenter` (Task 1); `distanceToRound` (Task 2); `db.saveGame` storing `geometry` (Task 2).
- Produces:
  - `PUT /game/api/admin/games/:id`: a round may carry `geometry`; 400 body is `{ error, round: <index> }` for a bad round, `{ error: 'invalid title or rounds' }` for a bad title / non-array.
  - `POST /game/api/:slug/guess` response: `{ km, points, nearest: { lat, lng }, truth }` where `truth.geometry` is an object or `null`.

- [ ] **Step 1: Write the failing tests** — append to `test/game-routes.test.js` (it already has `withServer`, `auth`, `json`):

```js
const LINE = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };

async function lineGame(base) {
  const g = await (await fetch(`${base}/game/api/admin/games`, {
    method: 'POST', headers: json, body: JSON.stringify({ title: 'shapes' }),
  })).json();
  const put = await fetch(`${base}/game/api/admin/games/${g.id}`, {
    method: 'PUT', headers: json,
    body: JSON.stringify({ title: 'shapes', rounds: [
      { question: 'Where is the equator line?', lat: 99, lng: 99, geometry: { type: 'Feature', properties: { a: 1 }, geometry: LINE }, radius: 10 },
      { question: 'Point?', lat: 1, lng: 2, geometry: { type: 'Point', coordinates: [5, 6] } },
    ] }),
  });
  assert.equal(put.status, 200);
  return g;
}

test('PUT stores a shape (Feature unwrapped), sets lat/lng to the bbox centre, collapses a Point', async () => {
  await withServer(async (base) => {
    const g = await lineGame(base);
    const { rounds } = await (await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).json();
    assert.deepEqual(rounds[0].geometry, LINE);
    assert.deepEqual([rounds[0].lat, rounds[0].lng], [0, 5]);
    assert.equal(rounds[1].geometry, null);
    assert.deepEqual([rounds[1].lat, rounds[1].lng], [6, 5]); // from the Point [lng 5, lat 6]
    const pub = await (await fetch(`${base}/game/api/${g.slug}`)).json();
    assert.deepEqual(Object.keys(pub.rounds[0]).sort(), ['ord', 'question']); // the shape is the answer
  });
});

test('PUT rejects a bad shape with the message and the round index', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 't' }),
    })).json();
    const resp = await fetch(`${base}/game/api/admin/games/${g.id}`, {
      method: 'PUT', headers: json,
      body: JSON.stringify({ title: 't', rounds: [
        { question: 'ok', lat: 1, lng: 2 },
        { question: 'bad', lat: 1, lng: 2, geometry: { type: 'LineString', coordinates: [[0, 0]] } },
      ] }),
    });
    assert.equal(resp.status, 400);
    assert.deepEqual(await resp.json(), { error: 'invalid shape', round: 1 });
  });
});

test('guess against a line: km to the nearest point, nearest returned, truth carries the geometry; plays score the same', async () => {
  await withServer(async (base) => {
    const g = await lineGame(base);
    const r = await (await fetch(`${base}/game/api/${g.slug}/guess`, {
      method: 'POST', headers: json, body: JSON.stringify({ ord: 0, lat: 1, lng: 5 }),
    })).json();
    assert.equal(r.km, 111.2);
    assert.deepEqual(r.nearest, { lat: 0, lng: 5 });
    assert.deepEqual(r.truth.geometry, LINE);
    assert.equal(r.points, 82); // radius 10: round(100 * exp(-(111.2 - 10) / 500))
    const on = await (await fetch(`${base}/game/api/${g.slug}/guess`, {
      method: 'POST', headers: json, body: JSON.stringify({ ord: 0, lat: 0, lng: 7 }),
    })).json();
    assert.equal(on.km, 0); assert.equal(on.points, 100);
    const play = await (await fetch(`${base}/game/api/${g.slug}/plays`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ player_name: 'Fer', guesses: [{ ord: 0, lat: 1, lng: 5 }, { ord: 1, lat: 6, lng: 5 }] }),
    })).json();
    assert.deepEqual(play.rounds.map((x) => [x.km, x.points]), [[111.2, 82], [0, 100]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/game-routes.test.js`
Expected: the three new tests FAIL (geometry comes back `undefined`/`null`, lat/lng not re-centred, no `nearest`).

- [ ] **Step 3: Edit `src/game/routes.js`**

Change the requires at the top:

```js
const { points, distanceToRound } = require('./scoring');
const { normalizeGeometry, bboxCenter } = require('./geo');
```

Replace `cleanRound` with a version that returns `{ round }` or `{ error }`:

```js
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
```

Replace the body of the `PUT /api/admin/games/:id` handler after the 404 check:

```js
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
```

In `POST /api/:slug/guess`, replace the two lines that compute `km` and respond with:

```js
    const { km, nearest } = distanceToRound(b.lat, b.lng, round);
    const { question, ord, game_id, id, ...truth } = round;
    res.json({ km, nearest, points: points(km, round.radius ?? undefined), truth });
```

In `POST /api/:slug/plays`, replace the `km` line inside `scored` with:

```js
      const { km } = distanceToRound(x.lat, x.lng, r);
```

`haversineKm` is no longer used in this file; remove it from the require.

- [ ] **Step 4: Run the tests to verify they pass, then the whole suite**

Run: `node --test test/game-routes.test.js` then `node --test test/`
Expected: all PASS. The pre-existing "PUT rejects invalid rounds with 400" test still passes (status unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/game/routes.js test/game-routes.test.js
git commit -m "feat(game): shape rounds — validate on save, score by nearest point, expose on the reveal"
```

---

### Task 4: Live sessions — score shapes and carry them in the reveal snapshot

**Files:**
- Modify: `src/game/live.js` (`snapshot`; the `POST /live/api/:code/guess` handler)
- Test: `test/game-live.test.js` (append)

**Interfaces:**
- Consumes: `distanceToRound` (Task 2).
- Produces: snapshot `reveal.truth.geometry` (object or `null`) and `reveal.guesses[i].nearest = { lat, lng }`.

- [ ] **Step 1: Write the failing test** — append to `test/game-live.test.js` (uses its `withServer`, `post`, `next`, `auth`):

```js
test('shape round: live guesses score by nearest point; reveal carries geometry and each nearest', async () => {
  await withServer(async ({ base, db }) => {
    const LINE = { type: 'LineString', coordinates: [[0, 0], [10, 0]] };
    const g = db.createGame('Shapes');
    db.saveGame(g.id, 'Shapes', [{ question: 'Equator?', lat: 0, lng: 5, geometry: LINE, radius: 10 }]);
    const { code } = await (await post(`${base}/game/api/admin/games/${g.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    const ana = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Ana' })).json();
    await next(base, code); // open
    await post(`${base}/game/live/api/${code}/guess`, { token: fer.token, ord: 0, lat: 0, lng: 7 });
    await post(`${base}/game/live/api/${code}/guess`, { token: ana.token, ord: 0, lat: 1, lng: 5 });
    const snap = await (await next(base, code)).json(); // revealed
    assert.deepEqual(snap.reveal.truth.geometry, LINE);
    assert.deepEqual(snap.reveal.guesses.map((x) => [x.name, x.km, x.points, x.nearest]),
      [['Fer', 0, 100, { lat: 0, lng: 7 }], ['Ana', 111.2, 82, { lat: 0, lng: 5 }]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/game-live.test.js`
Expected: the new test FAILS (`truth.geometry` undefined; `nearest` undefined; Ana's km measured to the anchor).

- [ ] **Step 3: Edit `src/game/live.js`**

Change the scoring require to:

```js
const { points, distanceToRound } = require('./scoring');
```

In `snapshot`, replace the `reveal` block with:

```js
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
```

In the guess handler, replace the `km` line with:

```js
    const { km } = distanceToRound(b.lat, b.lng, round);
```

`haversineKm` is no longer used in this file; remove it from the require.

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `node --test test/game-live.test.js` then `node --test test/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/live.js test/game-live.test.js
git commit -m "feat(game): live sessions score shape rounds and reveal geometry with nearest points"
```

---

### Task 5: The reveal on both play pages

**Files:**
- Modify: `views/game/play.html` (the `map.on('load', …)` block; `confirmGuess`)
- Modify: `views/game/live.html` (the `map.on('load', …)` block; `renderReveal`)
- Scratch (not committed): `/tmp/shape-targets/stub.js`

**Interfaces:**
- Consumes: `/game/api/:slug/guess` → `{ km, points, nearest, truth }` with `truth.geometry` (Task 3); live snapshot `reveal.truth.geometry` and `reveal.guesses[i].nearest` (Task 4).
- Produces: nothing programmatic. Both pages keep `window.map`; `play.html` keeps `window.playState`.

- [ ] **Step 1: Shared snippet — the truth layers.** In BOTH pages, inside `map.on('load', …)`, replace the single `truth` circle layer with three layers on the same source, keeping the guess-line layer between the fill and the outline. In `play.html` the guess-line source/layer is called `line`; in `live.html` it is `lines`. The result in `play.html`:

```js
map.on('load', () => {
  map.addSource('truth', { type: 'geojson', data: EMPTY });
  map.addSource('line', { type: 'geojson', data: EMPTY });
  // A shape round renders as fill + outline, a point round as the dot — geometry-type picks per feature.
  map.addLayer({ id: 'truth-fill', type: 'fill', source: 'truth', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#ffd15c', 'fill-opacity': 0.25 } });
  map.addLayer({ id: 'line', type: 'line', source: 'line',
    paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-dasharray': [1.5, 1.5] } });
  map.addLayer({ id: 'truth-line', type: 'line', source: 'truth', filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': '#ffd15c', 'line-width': 3 } });
  map.addLayer({ id: 'truth', type: 'circle', source: 'truth', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': '#ffd15c', 'circle-stroke-color': '#070b1c', 'circle-stroke-width': 2 } });
});
```

In `live.html` the same block, with `'lines'` as the guess-line source/layer id, its existing paint (`#ffffff`, opacity .7, width 1.5, dasharray), its existing `circle-radius: 7`, and `ready = true;` kept as the last statement.

Also add to BOTH pages, next to the `EMPTY` constant:

```js
// The reveal geometry as a feature: the round's shape, or a point at the anchor.
const truthFeature = (t) => ({ type: 'Feature', geometry: t.geometry || { type: 'Point', coordinates: [t.lng, t.lat] } });
// Extend bounds by every position of a geometry.
const extendBy = (bounds, geometry) => {
  const walk = (c) => (typeof c[0] === 'number' ? bounds.extend(c) : c.forEach(walk));
  walk(geometry.coordinates);
  return bounds;
};
```

- [ ] **Step 2: `play.html` `confirmGuess`** — replace the block from `const truthPt = …` through the `map.fitBounds(…)` call with:

```js
  const tf = truthFeature(r.truth);
  map.getSource('truth').setData(tf);
  map.getSource('line').setData({ type: 'Feature', geometry: {
    type: 'LineString', coordinates: [[lng, lat], [r.nearest.lng, r.nearest.lat]] } });
  const bounds = extendBy(new maplibregl.LngLatBounds([lng, lat], [lng, lat]), tf.geometry);
  map.fitBounds(bounds, { padding: 90, maxZoom: 9, duration: RM ? 0 : 1200 });
```

- [ ] **Step 3: `live.html` `renderReveal`** — inside its `whenLoaded(() => { … })`, replace the truth `setData`, the lines `setData` and the bounds construction with:

```js
    const tf = truthFeature(truth);
    map.getSource('truth').setData(tf);
    map.getSource('lines').setData({ type: 'FeatureCollection', features: guesses.map((g) => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: [[g.lng, g.lat], [g.nearest.lng, g.nearest.lat]] } })) });
    if (!roundChanged) return;
    const b = extendBy(new maplibregl.LngLatBounds([truth.lng, truth.lat], [truth.lng, truth.lat]), tf.geometry);
    for (const g of guesses) b.extend([g.lng, g.lat]);
```

leaving the existing `padding` computation and `map.fitBounds(b, …)` call after it as they are.

- [ ] **Step 4: Run the suite** (the pages aren't unit-tested, but the routes serving them are): `node --test test/` → all PASS.

- [ ] **Step 5: Screenshot stub** — write `/tmp/shape-targets/stub.js` (create the folder with the Write tool; run from the worktree root):

```js
// Stub for screenshots: real routers, no auth, seeded shape rounds, driver pages that
// wait in real time (the /slow gif) and drive the self-paced page through its handles.
const path = require('node:path');
const fs = require('node:fs');
const express = require(path.resolve('node_modules/express'));
const { openGameDb } = require(path.resolve('src/game/db'));
const gameRoutes = require(path.resolve('src/game/routes'));
const liveRoutes = require(path.resolve('src/game/live'));

const DB = '/tmp/shape-targets/stub.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
const noauth = (_req, _res, next) => next();
const app = express();
app.use(express.json());
app.use('/game', gameRoutes({ basicAuth: noauth, dbPath: DB, uploadsDir: '/tmp/shape-targets' }));

const db = openGameDb(DB); // second connection to the same file, for seeding
const WALL = { type: 'MultiLineString', coordinates: [
  [[119.8, 40.0], [117.2, 40.4], [116.0, 40.4], [114.9, 40.2], [113.5, 40.5], [111.9, 40.9], [109.3, 39.9], [107.6, 40.5], [105.6, 38.5], [103.9, 37.5], [102.0, 37.9], [100.3, 39.1], [98.3, 39.9], [97.6, 40.3]],
  [[115.3, 38.9], [116.5, 40.3], [117.6, 40.5]],
] };
const SWISS = { type: 'Polygon', coordinates: [[[5.96, 46.13], [6.8, 46.4], [7.0, 45.9], [7.9, 45.9], [8.5, 46.1], [9.0, 45.8], [9.3, 46.5], [10.1, 46.2], [10.5, 46.6], [9.6, 47.1], [9.5, 47.5], [8.6, 47.8], [7.6, 47.6], [7.0, 47.3], [6.1, 46.7], [5.96, 46.13]]] };
const g = db.createGame('Shapes');
db.saveGame(g.id, 'Shapes', [
  { question: 'Where is the Great Wall of China?', lat: 0, lng: 0, geometry: WALL, radius: 25, answer: 'The Great Wall, northern China' },
  { question: 'Where is Switzerland?', lat: 0, lng: 0, geometry: SWISS, radius: 25, answer: 'Switzerland' },
]);
// A live session already revealed on the wall round, three guesses.
const live = (() => {
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer'), ana = db.joinSession(s.id, 'Ana'), tom = db.joinSession(s.id, 'Tom');
  db.advanceSession(s.code);
  db.upsertGuess(s.id, fer.id, 0, { lat: 40.9, lng: 111.0, km: 12, points: 100 });
  db.upsertGuess(s.id, ana.id, 0, { lat: 36.1, lng: 103.9, km: 160, points: 76 });
  db.upsertGuess(s.id, tom.id, 0, { lat: 31.2, lng: 121.5, km: 980, points: 15 });
  db.advanceSession(s.code);
  return { s, fer };
})();

app.get('/slow', (req, res) => setTimeout(() => {
  res.type('gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
}, +req.query.ms || 10000));

// Self-paced: name pre-set, press Play, drop a pin, confirm — then the shutter.
app.get('/drive-play', (req, res) => {
  const [lat, lng] = (req.query.at || '38,112').split(',').map(Number);
  const skip = +req.query.skip || 0; // rounds to click through first (0 = wall, 1 = Switzerland)
  res.type('html').send(`<!doctype html><body style="margin:0">
    <script>localStorage.setItem('maptap:player', 'Fer');</script>
    <iframe id="f" src="/game/${g.slug}" style="border:0;width:1200px;height:900px"></iframe>
    <script>
      const w = () => document.getElementById('f').contentWindow;
      setTimeout(() => w().document.getElementById('start').click(), 5000);
      ${Array.from({ length: skip }, (_, i) => `setTimeout(() => { w().playState.place(0, 0); }, ${6000 + i * 2000});
      setTimeout(() => { w().playState.confirm(); }, ${6500 + i * 2000});
      setTimeout(() => { w().playState.next(); }, ${7500 + i * 2000});`).join('\n')}
      setTimeout(() => w().playState.place(${lat}, ${lng}), ${6000 + skip * 2000});
      setTimeout(() => w().playState.confirm(), ${6500 + skip * 2000});
    </script>
    <img src="/slow?ms=${18000 + skip * 2000}" width="1" height="1">
  </body>`);
});
// Live: token in localStorage, straight to the revealed wall round.
app.get('/drive-live', (_req, res) => {
  res.type('html').send(`<!doctype html><body style="margin:0">
    <script>localStorage.setItem('maptap:live:${live.s.code}', '${live.fer.token}');</script>
    <iframe src="/game/live/${live.s.code}" style="border:0;width:1200px;height:900px"></iframe>
    <img src="/slow?ms=14000" width="1" height="1">
  </body>`);
});
app.listen(3103, () => console.log('shape stub on :3103, game', g.slug, 'live', live.s.code));
```

- [ ] **Step 6: Take the screenshots** — start the stub in the background, then (one Bash call each, no `--disable-gpu`):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/shape-targets/play-wall.png "http://localhost:3103/drive-play?at=38,112"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/shape-targets/play-swiss.png "http://localhost:3103/drive-play?skip=1&at=48.5,9.5"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,900 --screenshot=/tmp/shape-targets/live-wall.png "http://localhost:3103/drive-live"
```

Read each PNG. Check: **play-wall** shows the wall as a gold line across northern China, the cyan pin near Datong, a dashed line to the nearest point on the wall (not to a centre), the reveal card with km and points. **play-swiss** shows Switzerland as a translucent gold area with a gold outline, the pin north of the border in Germany, a dashed line to the border, and km well under 100. **live-wall** shows the gold wall, three named pins, three dashed lines each ending on the wall, and the ranking Fer / Ana / Tom. Fix and re-shoot until right. Stop the stub (`lsof -ti :3103`) and delete `/tmp/shape-targets/stub.db*`.

- [ ] **Step 7: Commit**

```bash
git add views/game/play.html views/game/live.html
git commit -m "feat(game): draw shape answers on the reveal with lines to each nearest point"
```

---

### Task 6: Builder — Shape box, preview, links, server error on the right card

**Files:**
- Modify: `views/game/builder.html` (CSS block; `renderEditor` round template; the `main` click handler; the `main` change handler; `openMapPicker` and the picker click handler; the Save handler; `openEditor`)
- Scratch (not committed): `/tmp/shape-targets/builder-stub.js`

**Interfaces:**
- Consumes: `PUT /game/api/admin/games/:id` with `round.geometry`; its 400 body `{ error, round }` (Task 3); `GET /game/api/admin/games/:id` returning parsed `geometry` (Task 2).
- Produces: nothing programmatic.

- [ ] **Step 1: CSS** — add after the `.ansrow .unit` rule:

```css
  details.shape { margin: 8px 0; border: 1px dashed var(--border); border-radius: 8px; padding: 6px 10px; }
  details.shape summary { cursor: pointer; font: .78rem var(--mono); color: var(--muted); }
  details.shape textarea { width: 100%; min-height: 64px; resize: vertical; font: .75rem var(--mono); margin-top: 6px; }
  details.shape .st { font: .75rem var(--mono); color: var(--muted); margin: 4px 0; }
  details.shape .st.ok { color: var(--cyan); }
  details.shape .st.err { color: var(--red); }
  details.shape .links { font: .75rem var(--mono); color: var(--muted); margin: 4px 0; }
  details.shape .links a { color: var(--cyan); text-decoration: none; }
```

- [ ] **Step 2: Helpers** — add after `fmtCoords`:

```js
// Client-side read of pasted GeoJSON: enough to label it and place the anchor. The server re-validates.
const KINDS = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'area', MultiPolygon: 'area' };
function parseShape(text) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: 'not valid JSON' }; }
  let geoms = v && v.type === 'Feature' ? [v.geometry] : v && v.type === 'FeatureCollection' ? (v.features || []).map((f) => f && f.geometry) : [v];
  geoms = geoms.filter(Boolean);
  if (!geoms.length || geoms.some((g) => !KINDS[g.type] || !Array.isArray(g.coordinates))) return { error: 'invalid shape' };
  if (new Set(geoms.map((g) => KINDS[g.type])).size > 1) return { error: 'paste one kind of shape (all lines, or all areas)' };
  const geometry = geoms.length === 1 ? geoms[0] : v; // the server merges a FeatureCollection; send it as pasted
  let n = 0, minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  const walk = (c) => { if (typeof c[0] === 'number') { n++; minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); } else c.forEach(walk); };
  for (const g of geoms) walk(g.coordinates);
  const label = `${geoms.length === 1 ? geoms[0].type : geoms.length + ' features'} · ${n.toLocaleString()} point${n === 1 ? '' : 's'}`;
  return { geometry, label, lat: +((minLat + maxLat) / 2).toFixed(5), lng: +((minLng + maxLng) / 2).toFixed(5) };
}
const shapeLabel = (r) => (r.shapeLabel || (r.geometry ? `${r.geometry.type} · ${countPositions(r.geometry).toLocaleString()} points` : ''));
function countPositions(g) { let n = 0; const walk = (c) => (typeof c[0] === 'number' ? n++ : c.forEach(walk)); walk(g.coordinates); return n; }
```

- [ ] **Step 3: Round template** — in `renderEditor`, change the coords input and the 🗺 button to be disabled when a shape is set, and add the Shape block right after the `.locrow` div:

```js
        <input type="text" class="coords" data-coords="${i}" placeholder="or lat, lng" value="${esc(fmtCoords(r))}" ${r.geometry ? 'disabled title="Anchor set from the shape"' : ''}>
        <button class="sm" data-mappick="${i}" title="${r.geometry ? 'Preview the shape on a map' : 'Pick the spot on a map'}" aria-label="Open the map">🗺</button>
```

(the `city` input in the same row also gets `${r.geometry ? 'disabled' : ''}`), then:

```js
      <details class="shape" ${r.geometry ? 'open' : ''}>
        <summary>Shape (line or area) — optional${r.geometry ? ` · ${esc(shapeLabel(r))}` : ''}</summary>
        <textarea data-shape="${i}" placeholder='Paste GeoJSON here — a line or an area, e.g. {"type":"LineString","coordinates":[[lng,lat],[lng,lat]]}'>${esc(r.shapeText ?? (r.geometry ? JSON.stringify(r.geometry) : ''))}</textarea>
        <div class="st ${r.shapeErr ? 'err' : r.geometry ? 'ok' : ''}">${esc(r.shapeErr || (r.geometry ? shapeLabel(r) + ' · anchor set to its centre' : 'No shape — this round is a point'))}</div>
        <div class="links">Draw one at <a href="https://geojson.io" target="_blank" rel="noopener">geojson.io</a> ·
          export from OpenStreetMap at <a href="https://overpass-turbo.eu" target="_blank" rel="noopener">overpass-turbo.eu</a> ·
          simplify big files at <a href="https://mapshaper.org" target="_blank" rel="noopener">mapshaper.org</a></div>
        ${r.geometry ? `<button class="sm" data-mappick="${i}">Preview</button> <button class="sm" data-shapeclear="${i}">Clear shape</button>` : ''}
      </details>
```

- [ ] **Step 4: Handlers.** In the `main` click handler, next to the `delphoto` branch:

```js
  const shapeclear = btn('shapeclear');
  if (shapeclear !== undefined) {
    const r = editing.rounds[+shapeclear];
    delete r.geometry; delete r.shapeText; delete r.shapeLabel; delete r.shapeErr;
    editing.dirty = true; return render();
  }
```

In the `main` change handler, before the `coords` branch:

```js
  [i, el] = val('shape');
  if (el) {
    const r = editing.rounds[i], text = el.value.trim();
    delete r.shapeErr;
    if (!text) { delete r.geometry; delete r.shapeText; delete r.shapeLabel; editing.dirty = true; return render(); }
    const p = parseShape(text);
    r.shapeText = text;
    if (p.error) { r.shapeErr = p.error; return render(); }
    r.geometry = p.geometry; r.shapeLabel = p.label;
    r.lat = p.lat; r.lng = p.lng; delete r.city; delete r.country;
    editing.dirty = true; return render();
  }
```

The `coords` and `city` branches are unreachable for a shape round because their inputs are disabled; no change needed.

- [ ] **Step 5: Picker preview.** In `openMapPicker`, after `window.pickmap = pickmap;` add the shape layers once the map loads, and make the click handler ignore clicks while previewing:

```js
    pickmap.on('load', () => {
      pickmap.addSource('shape', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      pickmap.addLayer({ id: 'shape-fill', type: 'fill', source: 'shape', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#ffd15c', 'fill-opacity': 0.25 } });
      pickmap.addLayer({ id: 'shape-line', type: 'line', source: 'shape', filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': '#ffd15c', 'line-width': 3 } });
      pickmap.addLayer({ id: 'shape-pt', type: 'circle', source: 'shape', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffd15c', 'circle-stroke-color': '#070b1c', 'circle-stroke-width': 2 } });
      pickReady = true; showShape();
    });
```

with, above `openMapPicker`, `let pickReady = false;` and:

```js
// Draw the current round's shape on the picker (or clear it) and frame it.
function showShape() {
  if (!pickReady) return;
  const r = editing && editing.rounds[pickIdx];
  const g = r && r.geometry;
  pickmap.getSource('shape').setData(g ? { type: 'Feature', geometry: g } : { type: 'FeatureCollection', features: [] });
  document.querySelector('.maphint').textContent = g ? 'Previewing the shape — clear it on the card to pick a point' : 'Tap the secret spot — zoom in for precision';
  if (!g) return;
  const b = new maplibregl.LngLatBounds();
  const walk = (c) => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
  walk(g.coordinates);
  pickmap.fitBounds(b, { padding: 60, maxZoom: 9, duration: 0 });
}
```

`maplibregl` is currently a local inside `openMapPicker`; hoist it: `let maplibregl = null;` next to `pickmap`, and `maplibregl = await import(…)` instead of `const`. At the end of `openMapPicker` (after the `if (!pickmap) { … }` block) call `showShape();`. At the top of the picker's click handler add `if (editing && editing.rounds[pickIdx] && editing.rounds[pickIdx].geometry) return;`.

- [ ] **Step 6: Save and load.** In the Save handler, send only server fields and route a 400 to its card:

```js
      body: JSON.stringify({ title: editing.game.title,
        rounds: editing.rounds.map(({ shapeText, shapeLabel, shapeErr, ...r }) => r) }),
```

and replace `if (!resp.ok) throw new Error(resp.status);` with:

```js
    if (resp.status === 400) {
      const d = await resp.json();
      if (Number.isInteger(d.round) && editing.rounds[d.round]) {
        editing.rounds[d.round].shapeErr = d.error;
        render();
        document.querySelectorAll('.round')[d.round].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setStatus(d.error); $('save').disabled = false; return;
    }
    if (!resp.ok) throw new Error(resp.status);
```

Also in the Save handler's pre-check, treat a round with a shape as located: `!r.question.trim() || (!Number.isFinite(r.lat) && !r.geometry)`.

- [ ] **Step 7: Verify with a screenshot** — write `/tmp/shape-targets/builder-stub.js`:

```js
const path = require('node:path');
const express = require(path.resolve('node_modules/express'));
const gameRoutes = require(path.resolve('src/game/routes'));
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use('/game', gameRoutes({ basicAuth: (_req, _res, next) => next(),
  dbPath: '/tmp/shape-targets/builder.db', uploadsDir: '/tmp/shape-targets' }));
app.listen(3104, () => console.log('builder stub on :3104'));
```

Start it in the background from the worktree root, seed with plain curl calls (read the id from the first response):

```bash
curl -s -X POST localhost:3104/game/api/admin/games -H 'content-type: application/json' -d '{"title":"Shapes"}'
curl -s -X PUT localhost:3104/game/api/admin/games/1 -H 'content-type: application/json' -d '{"title":"Shapes","rounds":[{"question":"Where is the Great Wall?","lat":0,"lng":0,"geometry":{"type":"LineString","coordinates":[[119.8,40.0],[116.0,40.4],[111.9,40.9],[105.6,38.5],[97.6,40.3]]},"radius":25}]}'
```

The editor view needs a click on the game's Edit button, so the stub gets a driver route that iframes the builder and clicks it. Add before `app.listen`:

```js
app.get('/drive', (_req, res) => res.type('html').send(`<!doctype html><body style="margin:0">
  <iframe id="f" src="/game/admin" style="border:0;width:1200px;height:900px"></iframe>
  <script>setTimeout(() => document.getElementById('f').contentWindow.document.querySelector('[data-edit]').click(), 2500);</script>
  <img src="/slow?ms=6000" width="1" height="1"></body>`));
app.get('/slow', (req, res) => setTimeout(() => res.type('gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')), +req.query.ms || 5000));
```

Screenshot `http://localhost:3104/drive` to `/tmp/shape-targets/builder-shape.png` (same Chrome command shape as Task 5) and Read it: the round card shows the Shape block open with "LineString · 5 points · anchor set to its centre" in cyan, the three links, Preview and Clear shape buttons, and the coords input disabled showing the centre.

For the preview view add a second driver route `/drive-preview` identical to `/drive` plus one more line in its script, `setTimeout(() => document.getElementById('f').contentWindow.document.querySelector('[data-mappick]').click(), 4000);`, and `ms=14000` on its `/slow` image. Screenshot it to `/tmp/shape-targets/builder-preview.png` and Read it: the picker shows the gold line framed, with the hint "Previewing the shape — clear it on the card to pick a point". Stop the stub (`lsof -ti :3104`) and delete `/tmp/shape-targets/builder.db*`.

- [ ] **Step 8: Run the suite and commit**

```bash
node --test test/
git add views/game/builder.html
git commit -m "feat(game): paste a GeoJSON shape per round in the builder, with preview and links"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md` (after the "Live sessions" block added on 2026-10-22), `docs/HANDOVER-globe.md` (after "The shared recipe" code block)

- [ ] **Step 1: README** — add after the live-sessions paragraph that ends "so no proxy config is needed.":

```markdown
Shape rounds: a round's answer can be a line or an area instead of a point.
Paste GeoJSON into the round's "Shape" box in the builder (draw one at
geojson.io, export from OpenStreetMap at overpass-turbo.eu, simplify big files
at mapshaper.org; max 5,000 points). Scoring is distance to the nearest part of
the shape — zero inside an area — with the radius as the full-points margin.
Known limitation: areas that cross the 180° meridian.
```

- [ ] **Step 2: Handover** — add after the shared-recipe code block's closing paragraph (the one about CSS from the CDN):

```markdown
Reveal overlays (both play pages): one `truth` geojson source with three
layers — `truth-fill` (areas), `truth-line` (lines and outlines), `truth`
(points) — filtered on `['geometry-type']`, so a point round still renders as
the gold dot. Geometry math is server-side in `src/game/geo.js`; the pages
only draw what `/guess` or the live snapshot hands them (`truth.geometry`,
`nearest`).
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/HANDOVER-globe.md
git commit -m "docs: shape rounds"
```

---

### Task 8: Finish the branch

- [ ] **Step 1:** `node --test test/` in the worktree — all PASS.
- [ ] **Step 2:** Use `superpowers:finishing-a-development-branch` (merge `shape-targets` into local `main`, suite on `main`, push when André says so).
- [ ] **Step 3:** After deploy, paste a real export (the Great Wall from overpass-turbo, simplified at mapshaper) into a test game and play one round self-paced and one live.
