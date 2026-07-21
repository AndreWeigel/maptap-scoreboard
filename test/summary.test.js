const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dailySummary, weeklySummary } = require('../src/summary');

const CFG = { FIRE_THRESHOLD: 95, PANIC_THRESHOLD: 40 };
const row = (date, id, final, rounds = [80, 80, 80, 80, 80]) => ({
  play_date: date, player_id: id, player_name: id,
  round1: rounds[0], round2: rounds[1], round3: rounds[2], round4: rounds[3], round5: rounds[4],
  final_score: final,
});

test('daily: winner, best, average, headcount', () => {
  const s = dailySummary([row('2026-07-20', 'André', 487), row('2026-07-20', 'Pau', 375)], '2026-07-20');
  assert.match(s, /Mon 20 Jul/);
  assert.match(s, /🥇 André  487/);
  assert.match(s, /avg 431 · 2 players/);
});

test('daily: tie lists both winners; empty day posts nothing', () => {
  assert.match(dailySummary([row('d', 'a', 500), row('d', 'b', 500)], '2026-07-20'), /🥇 a, b  500/);
  assert.equal(dailySummary([], '2026-07-20'), null);
});

test('weekly: wins ranking, best avg, record, streak', () => {
  const rows = [
    row('2026-07-14', 'André', 500), row('2026-07-14', 'Pau', 400),
    row('2026-07-15', 'André', 512), row('2026-07-15', 'Pau', 480),
    row('2026-07-16', 'Pau', 490), row('2026-07-16', 'André', 300),
  ];
  const s = weeklySummary(rows, '2026-07-14', '2026-07-20', CFG);
  assert.match(s, /Week of 14–20 Jul/);
  assert.match(s, /🏆 Wins: André 2 · Pau 1/);
  assert.match(s, /🔥 Record: André 512/);
  assert.equal(weeklySummary([], '2026-07-14', '2026-07-20', CFG), null);
});
