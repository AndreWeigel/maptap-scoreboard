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
  near(r.km, haversineKm(18, 5, r.lat, r.lng), 1e-2);
});

test('nearestOnGeometry: inside a polygon → 0 and the guess itself; outside → nearest edge', () => {
  const inside = nearestOnGeometry(5, 5, square);
  assert.deepEqual(inside, { km: 0, lat: 5, lng: 5 });
  const outside = nearestOnGeometry(12, 5, square);
  near(outside.lat, 10, 0.1); near(outside.lng, 5, 0.01);
  near(outside.km, haversineKm(12, 5, outside.lat, outside.lng), 1e-2);
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
