const assert = require('node:assert');
const { openDb } = require('../src/db');
const { deletePlayers } = require('../scripts/delete-player');

const db = openDb(':memory:');
const now = new Date('2026-07-20T00:00:00Z');
for (const [id, name] of [['a', 'Keep'], ['b', 'Brandi']]) {
  db.upsertPlayer(id, name, now);
  db.upsertResult({
    play_date: '2026-07-20', player_id: id, player_name: name,
    round1: 1, round2: 1, round3: 1, round4: 1, round5: 1, final_score: 5,
    raw_text: '', created_at: now.toISOString(),
  });
}

const deleted = deletePlayers(db, ['Brandi', 'Ghost']);
assert.deepStrictEqual(deleted, ['Brandi']);
assert.strictEqual(db.raw.prepare('SELECT count(*) c FROM players').get().c, 1);
assert.strictEqual(db.getResults('2026-07-20', '2026-07-20').length, 1);
console.log('ok');
