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

CREATE TABLE IF NOT EXISTS daily_results (
  play_date    TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  is_winner    INTEGER NOT NULL,
  PRIMARY KEY (play_date, player_id)
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
  const insertDaily = db.prepare(
    'INSERT INTO daily_results (play_date, player_id, rank, is_winner) VALUES (?, ?, ?, ?)'
  );
  const deleteDaily = db.prepare('DELETE FROM daily_results WHERE play_date = ?');

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

    getResults(from, to) {
      return db.prepare(
        'SELECT * FROM results WHERE play_date BETWEEN ? AND ? ORDER BY play_date, final_score DESC'
      ).all(from, to);
    },

    getDates() {
      return db.prepare('SELECT DISTINCT play_date FROM results ORDER BY play_date')
        .all().map((r) => r.play_date);
    },

    replaceDailyResults(playDate, ranked) {
      db.transaction(() => {
        deleteDaily.run(playDate);
        for (const r of ranked) insertDaily.run(playDate, r.player_id, r.rank, r.is_winner);
      })();
    },
  };
}

module.exports = { openDb };
