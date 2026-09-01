const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, points } = require('../src/game/scoring');

test('haversineKm: Porto→Lisbon ≈ 274 km, zero for same point', () => {
  const km = haversineKm(41.15, -8.61, 38.7078, -9.1366);
  assert.ok(Math.abs(km - 274) < 5, `got ${km}`);
  assert.equal(haversineKm(33.0106, 91.6642, 33.0106, 91.6642), 0);
});

test('points: full inside radius, exp decay after, radius tunes the zone', () => {
  assert.equal(points(0), 100);
  assert.equal(points(25), 100);
  assert.equal(points(525), Math.round(100 * Math.exp(-1))); // 37
  assert.equal(points(24.9, 20), Math.round(100 * Math.exp(-4.9 / 500)));
  assert.equal(points(19, 20), 100);
  assert.ok(points(200) > points(300), 'monotonic decay');
});
