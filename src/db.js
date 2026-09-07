const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  play_date    TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  round1       INTEGER NOT NULL,
  round2       INTEGER NOT NULL,
  round3       INTEGER NOT NULL,
  round4       INTEGER NOT NULL,
  round5       INTEGER NOT NULL,
  final_score  INTEGER NOT NULL,
  raw_text     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(play_date, player_id)
);

CREATE TABLE IF NOT EXISTS players (
  player_id    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  first_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  sender     TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT,
  raw_text   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Feedback started out with an optional sender and no email. SQLite has no
  // ADD COLUMN IF NOT EXISTS and throws on a repeat, so look before adding.
  // Rows written before this keep a NULL email; the form requires one now.
  if (!db.prepare('PRAGMA table_info(feedback)').all().some((c) => c.name === 'email')) {
    db.exec('ALTER TABLE feedback ADD COLUMN email TEXT');
  }

  const insertResult = db.prepare(`
    INSERT INTO results (play_date, player_id, player_name, round1, round2, round3, round4, round5, final_score, raw_text, created_at)
    VALUES (@play_date, @player_id, @player_name, @round1, @round2, @round3, @round4, @round5, @final_score, @raw_text, @created_at)
    ON CONFLICT(play_date, player_id) DO UPDATE SET
      player_name = excluded.player_name,
      round1 = excluded.round1, round2 = excluded.round2, round3 = excluded.round3,
      round4 = excluded.round4, round5 = excluded.round5,
      final_score = excluded.final_score,
      raw_text = excluded.raw_text,
      created_at = excluded.created_at
  `);
  const hasResult = db.prepare('SELECT 1 FROM results WHERE play_date = ? AND player_id = ?');

  return {
    raw: db,

    upsertPlayer(playerId, displayName, now) {
      db.prepare(`
        INSERT INTO players (player_id, display_name, first_seen) VALUES (?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET display_name = excluded.display_name
      `).run(playerId, displayName, now.toISOString());
    },

    // returns { replaced } so callers can log corrections
    upsertResult(r) {
      const replaced = !!hasResult.get(r.play_date, r.player_id);
      insertResult.run(r);
      return { replaced };
    },

    logParseFailure(playerId, rawText, reason, now) {
      db.prepare(
        'INSERT INTO parse_failures (player_id, raw_text, reason, created_at) VALUES (?, ?, ?, ?)'
      ).run(playerId, rawText, reason, now.toISOString());
    },

    addFeedback(f) {
      return db.prepare(
        'INSERT INTO feedback (kind, message, sender, email, created_at) VALUES (@kind, @message, @sender, @email, @created_at)'
      ).run(f).lastInsertRowid;
    },

    // ponytail: newest 200, no paging — a friend group won't out-write that.
    listFeedback() {
      return db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 200').all();
    },

    getResults(from, to) {
      return db.prepare(
        'SELECT * FROM results WHERE play_date BETWEEN ? AND ? ORDER BY play_date, final_score DESC'
      ).all(from, to);
    },

    getDates() {
      return db.prepare('SELECT DISTINCT play_date FROM results ORDER BY play_date')
        .all().map((r) => r.play_date);
    },
  };
}

module.exports = { openDb };
