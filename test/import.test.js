const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { openDb } = require('../src/db');
const users = require('../src/users');
const importer = require('../src/import');

// One maptap result each for a registered player (Daniel) and two newcomers.
const CHAT = [
  '[12.07.26, 09:00:00] Daniel Couvinha: www.maptap.gg July 12',
  '88 90 91 92 93',
  'Final score: 800',
  '[12.07.26, 09:05:00] Henrique: www.maptap.gg July 12',
  '97 94 100 95 90',
  'Final score: 676',
  '[13.07.26, 09:05:00] Henrique: www.maptap.gg July 13',
  '80 80 80 80 80',
  'Final score: 700',
  '[12.07.26, 09:10:00] Joana: www.maptap.gg July 12',
  '99 98 81 96 90',
  'Final score: 662',
].join('\n');

function withRegistry(fn) {
  try {
    users.save({ users: [{ name: 'Daniel', ids: ['Daniel Couvinha'] }] });
    return fn();
  } finally { fs.rmSync(users.FILE, { force: true }); }
}

test('preview groups by sender and flags already-registered', () => {
  withRegistry(() => {
    const p = importer.preview(CHAT);
    const by = Object.fromEntries(p.map((s) => [s.sender, s]));
    assert.strictEqual(by['Henrique'].count, 2);
    assert.strictEqual(by['Henrique'].registered, false);
    assert.strictEqual(by['Joana'].count, 1);
    assert.strictEqual(by['Daniel Couvinha'].registered, true);
  });
});

test('run imports only chosen new senders, never touching a registered id', () => {
  withRegistry(() => {
    const db = openDb(':memory:');
    // choose everyone, including the registered Daniel — Daniel must still be skipped
    const c = importer.run(db, CHAT, ['Henrique', 'Joana', 'Daniel Couvinha']);
    assert.strictEqual(c.imported, 3); // 2 Henrique + 1 Joana
    assert.strictEqual(c.skippedRegistered, 1); // Daniel's row skipped
    assert.strictEqual(db.raw.prepare("SELECT COUNT(*) n FROM results WHERE player_id='Daniel Couvinha'").get().n, 0);
    assert.strictEqual(db.raw.prepare("SELECT COUNT(*) n FROM results WHERE player_id='Henrique'").get().n, 2);
  });
});
