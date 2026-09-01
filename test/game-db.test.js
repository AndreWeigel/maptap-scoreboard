const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openGameDb } = require('../src/game/db');

const round = (q, lat, lng, extra = {}) => ({ question: q, lat, lng, ...extra });

test('rounds keep answer + radius (trivia rounds)', () => {
  const db = openGameDb(':memory:');
  const g = db.createGame('trivia');
  db.saveGame(g.id, 'trivia', [
    round('Highest railway station?', 33.0106, 91.6642,
      { answer: 'Tanggula, Qinghai–Tibet Railway, China', radius: 20 }),
    round('Born?', 38.57, -7.9),
  ]);
  const { rounds } = db.getGame(g.id);
  assert.equal(rounds[0].answer, 'Tanggula, Qinghai–Tibet Railway, China');
  assert.equal(rounds[0].radius, 20);
  assert.equal(rounds[1].answer, null);
  assert.equal(rounds[1].radius, null);
});

test('openGameDb migrates a pre-answer/radius db file in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamedb-'));
  const file = path.join(dir, 'game.db');
  try {
    // Build a slice-2-era file: same schema minus answer/radius.
    const Database = require('better-sqlite3');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL, question TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
        city TEXT, country TEXT, photo TEXT, story TEXT, UNIQUE(game_id, ord));
      INSERT INTO games (slug, title, created_at) VALUES ('aaaabbbbccccdddd', 'old', 'now');
      INSERT INTO rounds (game_id, ord, question, lat, lng) VALUES (1, 0, 'q', 1, 2);
    `);
    old.close();
    const db = openGameDb(file);
    const { rounds } = db.getGame(1); // old row still there, new columns null
    assert.equal(rounds[0].question, 'q');
    assert.equal(rounds[0].radius, null);
    db.saveGame(1, 'old', [round('q2', 1, 2, { radius: 5, answer: 'x' })]);
    assert.equal(db.getGame(1).rounds[0].radius, 5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
