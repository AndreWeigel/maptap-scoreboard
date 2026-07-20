const test = require('node:test');
const assert = require('node:assert');
const { matchStart, backfill } = require('../scripts/backfill');
const { openDb } = require('../src/db');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('iOS dotted dates are day-first, not month-first', () => {
  // The trap: 07.05.26 is 7 May. A ">12 means swap" heuristic would read it as
  // 5 July, silently misdating every message whose day is <= 12.
  assert.strictEqual(iso(matchStart('[07.05.26, 11:12:29] Alice: hi').ts), '2026-05-07');
  assert.strictEqual(iso(matchStart('[23.05.25, 19:53:36] Alice: hi').ts), '2025-05-23');
});

test('Android slashed dates keep the month-first default', () => {
  assert.strictEqual(iso(matchStart('7/20/26, 08:14 - Alice: hi').ts), '2026-07-20');
  assert.strictEqual(iso(matchStart('20/7/26, 08:14 - Alice: hi').ts), '2026-07-20');
});

test('sender and text are split on the first colon only', () => {
  const m = matchStart('[07.07.26, 11:12:29] Ana-Lucia B.: www.maptap.gg July 7');
  assert.strictEqual(m.sender, 'Ana-Lucia B.');
  assert.strictEqual(m.text, 'www.maptap.gg July 7');
});

test('continuation lines join the message, and a result round-trips', () => {
  const db = openDb(':memory:');
  const counts = backfill(db, [
    '[07.07.26, 11:06:40] Sam Rivers: www.maptap.gg',
    '[07.07.26, 11:12:29] Ana-Lucia B.: www.maptap.gg July 7',
    '81🎓 90🔥 77🎉 84🏆 0🤮',
    'Final score: 604',
  ].join('\n'));

  assert.strictEqual(counts.ok, 1);
  assert.strictEqual(counts.ignored, 1); // the bare link is not a result
  const rows = db.getResults('2026-07-07', '2026-07-07');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].player_id, 'Ana-Lucia B.');
  assert.strictEqual(rows[0].final_score, 604);
  assert.strictEqual(rows[0].round2, 90);
});
