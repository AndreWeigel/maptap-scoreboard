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
