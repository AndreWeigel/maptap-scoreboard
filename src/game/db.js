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

  const insertRound = db.prepare(`
    INSERT INTO rounds (game_id, ord, question, lat, lng, city, country, photo, story)
    VALUES (@game_id, @ord, @question, @lat, @lng, @city, @country, @photo, @story)
  `);
  const replaceRounds = db.transaction((id, title, rounds) => {
    db.prepare('UPDATE games SET title = ? WHERE id = ?').run(title, id);
    db.prepare('DELETE FROM rounds WHERE game_id = ?').run(id);
    rounds.forEach((r, ord) => insertRound.run({
      game_id: id, ord, question: r.question, lat: r.lat, lng: r.lng,
      city: r.city ?? null, country: r.country ?? null, photo: r.photo ?? null, story: r.story ?? null,
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
  };
}

module.exports = { openGameDb };
