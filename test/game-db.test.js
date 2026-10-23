const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openGameDb, revealedOrds } = require('../src/game/db');

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

function seedGame(db) {
  const g = db.createGame('trains');
  db.saveGame(g.id, 'trains', [
    round('Highest station?', 33.0106, 91.6642, { radius: 20, answer: 'Tanggula' }),
    round('First railway?', 54.9, -1.6),
    round('Longest tunnel?', 46.5, 8.6),
  ]);
  return g;
}

test('createSession starts in lobby with a 10-char code; listSessions counts players', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  assert.match(s.code, /^[a-f0-9]{10}$/);
  assert.equal(s.state, 'lobby');
  assert.equal(s.current_ord, null);
  assert.deepEqual(db.getSession(s.code), s);
  assert.equal(db.getSession('nope'), null);
  db.joinSession(s.id, 'Fer');
  const list = db.listSessions(g.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].code, s.code);
  assert.equal(list[0].players, 1);
});

test('advanceSession walks lobby → open → revealed → … → finished; end jumps to finished', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const step = () => { const n = db.advanceSession(s.code); return [n.state, n.current_ord]; };
  assert.deepEqual(step(), ['open', 0]);
  assert.deepEqual(step(), ['revealed', 0]);
  assert.deepEqual(step(), ['open', 1]);
  assert.deepEqual(step(), ['revealed', 1]);
  assert.deepEqual(step(), ['open', 2]);
  assert.deepEqual(step(), ['revealed', 2]);
  assert.deepEqual(step(), ['finished', 2]);
  assert.ok(db.getSession(s.code).finished_at);
  assert.throws(() => db.advanceSession(s.code), RangeError);
  assert.equal(db.advanceSession('nope'), null);

  const s2 = db.createSession(g.id);
  db.advanceSession(s2.code);
  const ended = db.endSession(s2.code);
  assert.equal(ended.state, 'finished');
  assert.ok(ended.finished_at);
  assert.equal(db.endSession('nope'), null);
});

test('joinSession: token per player, names unique per session (case-insensitive), playerByToken', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer');
  assert.match(fer.token, /^[a-f0-9]{32}$/);
  assert.throws(() => db.joinSession(s.id, 'fer'), (e) => String(e.code).startsWith('SQLITE_CONSTRAINT'));
  const other = db.createSession(g.id);
  db.joinSession(other.id, 'Fer'); // same name in another session is fine
  assert.deepEqual(db.playerByToken(fer.token), { id: fer.id, session_id: s.id, name: 'Fer' });
  assert.equal(db.playerByToken('nope'), null);
  assert.deepEqual(db.listPlayers(s.id).map((p) => p.name), ['Fer']);
});

test('upsertGuess keeps the latest tap; listGuesses sorts by km; standings sum revealed rounds only', () => {
  const db = openGameDb(':memory:');
  const g = seedGame(db);
  const s = db.createSession(g.id);
  const fer = db.joinSession(s.id, 'Fer');
  const ana = db.joinSession(s.id, 'Ana');
  db.upsertGuess(s.id, fer.id, 0, { lat: 1, lng: 1, km: 900, points: 10 });
  db.upsertGuess(s.id, fer.id, 0, { lat: 33, lng: 91, km: 12, points: 100 });
  db.upsertGuess(s.id, ana.id, 0, { lat: 30, lng: 90, km: 300, points: 57 });
  db.upsertGuess(s.id, ana.id, 1, { lat: 54, lng: -1, km: 80, points: 90 });
  assert.deepEqual(db.listGuesses(s.id, 0).map((x) => [x.name, x.km, x.points]), [['Fer', 12, 100], ['Ana', 300, 57]]);
  assert.deepEqual(db.standings(s.id, [0]).map((x) => [x.name, x.total]), [['Fer', 100], ['Ana', 57]]);
  assert.deepEqual(db.standings(s.id, [0, 1]).map((x) => [x.name, x.total]), [['Ana', 147], ['Fer', 100]]);
  assert.deepEqual(db.standings(s.id, []).map((x) => [x.name, x.total]), [['Fer', 0], ['Ana', 0]]);
});

test('revealedOrds follows the state', () => {
  const rounds = [{ ord: 0 }, { ord: 1 }, { ord: 2 }];
  assert.deepEqual(revealedOrds({ state: 'lobby', current_ord: null }, rounds), []);
  assert.deepEqual(revealedOrds({ state: 'open', current_ord: 0 }, rounds), []);
  assert.deepEqual(revealedOrds({ state: 'revealed', current_ord: 0 }, rounds), [0]);
  assert.deepEqual(revealedOrds({ state: 'open', current_ord: 2 }, rounds), [0, 1]);
  assert.deepEqual(revealedOrds({ state: 'finished', current_ord: 2 }, rounds), [0, 1, 2]);
});

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
