const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ingestMessage } = require('../src/ingest');

const NOW = new Date('2026-07-20T10:00:00');
const MSG = 'www.maptap.gg July 20\n88🎉 96🔥 97🔥 97🔥 7😱\nFinal score: 690';

test('duplicate post same player same day -> one row, latest wins', () => {
  const db = openDb(':memory:');
  ingestMessage(db, { playerId: 'a@s.net', playerName: 'Alice', text: MSG, now: NOW });
  const r2 = ingestMessage(db, {
    playerId: 'a@s.net', playerName: 'Alice',
    text: 'www.maptap.gg July 20\n90 96 97 97 80\nFinal score: 460', now: NOW,
  });
  assert.equal(r2.replaced, true);
  const rows = db.getResults('2026-07-20', '2026-07-20');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].final_score, 460);
});

test('final score without five rounds -> parse_failures, not ingested', () => {
  const db = openDb(':memory:');
  const r = ingestMessage(db, {
    playerId: 'a@s.net', playerName: 'Alice',
    text: 'www.maptap.gg July 20\n88 96 97\nFinal score: 690', now: NOW,
  });
  assert.equal(r.kind, 'failure');
  assert.equal(db.getResults('2026-07-20', '2026-07-20').length, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM parse_failures').get().n, 1);
});

test('non-result chatter is silently ignored', () => {
  const db = openDb(':memory:');
  const r = ingestMessage(db, { playerId: 'a@s.net', playerName: 'Alice', text: 'gg everyone', now: NOW });
  assert.equal(r.kind, 'ignored');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM parse_failures').get().n, 0);
});
