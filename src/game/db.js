// Game storage — its OWN SQLite file (data/game.db), never scores.db, so the
// whole game module can be lifted out of this repo later (handover directive).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  question TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  city     TEXT, country TEXT, photo TEXT, story TEXT,
  answer   TEXT, radius REAL,
  UNIQUE(game_id, ord)
);
CREATE TABLE IF NOT EXISTS plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  total       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(game_id, player_name COLLATE NOCASE)
);
CREATE TABLE IF NOT EXISTS guesses (
  play_id   INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  round_ord INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  km        REAL NOT NULL,
  points    INTEGER NOT NULL,
  UNIQUE(play_id, round_ord)
);
`;

function openGameDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Files created before 2026-09-01 lack the trivia columns; CREATE IF NOT
  // EXISTS won't touch them, so bring them up with ALTERs.
  const cols = db.prepare('PRAGMA table_info(rounds)').all().map((c) => c.name);
  if (!cols.includes('answer')) db.exec('ALTER TABLE rounds ADD COLUMN answer TEXT');
  if (!cols.includes('radius')) db.exec('ALTER TABLE rounds ADD COLUMN radius REAL');

  const insertRound = db.prepare(`
    INSERT INTO rounds (game_id, ord, question, lat, lng, city, country, photo, story, answer, radius)
    VALUES (@game_id, @ord, @question, @lat, @lng, @city, @country, @photo, @story, @answer, @radius)
  `);
  const insertGuess = db.prepare(`
    INSERT INTO guesses (play_id, round_ord, lat, lng, km, points)
    VALUES (@play_id, @round_ord, @lat, @lng, @km, @points)
  `);
  const insertPlay = db.transaction((gameId, playerName, total, guesses) => {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO plays (game_id, player_name, total, created_at) VALUES (?, ?, ?, ?)'
    ).run(gameId, playerName, total, new Date().toISOString());
    for (const g of guesses) insertGuess.run({ play_id: lastInsertRowid, ...g });
    return { id: lastInsertRowid };
  });
  const replaceRounds = db.transaction((id, title, rounds) => {
    db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, id);
    db.prepare('DELETE FROM rounds WHERE game_id = ?').run(id);
    rounds.forEach((r, ord) => insertRound.run({
      game_id: id, ord, question: r.question, lat: r.lat, lng: r.lng,
      city: r.city ?? null, country: r.country ?? null, photo: r.photo ?? null, story: r.story ?? null,
      answer: r.answer ?? null, radius: r.radius ?? null,
    }));
  });

  return {
    raw: db,

    createGame(title) {
      const slug = crypto.randomBytes(8).toString('hex'); // the link IS the access control
      db.prepare('INSERT INTO games (slug, title, created_at) VALUES (?, ?, ?)')
        .run(slug, title, new Date().toISOString());
      return db.prepare('SELECT * FROM games WHERE slug = ?').get(slug);
    },

    listGames() {
      return db.prepare(`
        SELECT g.*,
          (SELECT COUNT(*) FROM rounds r WHERE r.game_id = g.id) AS rounds,
          (SELECT COUNT(*) FROM plays p WHERE p.game_id = g.id) AS plays
        FROM games g ORDER BY g.id DESC
      `).all();
    },

    getGame(id) {
      const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
      if (!game) return null;
      const rounds = db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY ord').all(id);
      return { game, rounds };
    },

    saveGame(id, title, rounds) {
      replaceRounds(id, title, rounds);
      return this.getGame(id);
    },

    deleteGame(id) {
      return { deleted: db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0 };
    },

    getGameBySlug(slug) {
      const game = db.prepare('SELECT * FROM games WHERE slug = ?').get(slug);
      return game ? this.getGame(game.id) : null;
    },

    // guesses: [{ round_ord, lat, lng, km, points }] — one transaction with the
    // play row; throws SQLITE_CONSTRAINT on a duplicate (game, name) pair.
    recordPlay(gameId, playerName, total, guesses) {
      return insertPlay(gameId, playerName, total, guesses);
    },

    listPlays(gameId) {
      return db.prepare(
        'SELECT player_name, total, created_at FROM plays WHERE game_id = ? ORDER BY total DESC, created_at'
      ).all(gameId);
    },
  };
}

module.exports = { openGameDb };
