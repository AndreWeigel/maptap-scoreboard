const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankDay, computeStandings, dailyHistory } = require('../src/scoring');

const CFG = { FIRE_THRESHOLD: 95, PANIC_THRESHOLD: 40 };

const row = (date, id, final, rounds = [80, 80, 80, 80, 80]) => ({
  play_date: date, player_id: id, player_name: id,
  round1: rounds[0], round2: rounds[1], round3: rounds[2], round4: rounds[3], round5: rounds[4],
  final_score: final,
});

test('highest final score wins', () => {
  const ranked = rankDay([row('d', 'alice', 700), row('d', 'bob', 650)]);
  assert.equal(ranked[0].player_id, 'alice');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
});

test('tie at top: both rank 1, next ranks 3', () => {
  const ranked = rankDay([row('d', 'a', 700), row('d', 'b', 700), row('d', 'c', 650)]);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3]);
  const s = computeStandings([row('d', 'a', 700), row('d', 'b', 700), row('d', 'c', 650)], CFG);
  const wins = Object.fromEntries(s.leaderboard.map((p) => [p.playerId, p.wins]));
  assert.equal(wins.a, 1);
  assert.equal(wins.b, 1);
  assert.equal(wins.c, 0);
});

test('avg only counts played days', () => {
  const s = computeStandings([
    row('2026-07-01', 'alice', 600), row('2026-07-02', 'alice', 700),
    row('2026-07-01', 'bob', 500), // bob misses day 2
  ], CFG);
  const bob = s.leaderboard.find((p) => p.playerId === 'bob');
  assert.equal(bob.avgFinal, 500);
  assert.equal(bob.played, 1);
  assert.equal(bob.participationPct, 50);
});

test('fire/panic counts respect thresholds', () => {
  const s = computeStandings([row('d', 'alice', 500, [95, 96, 40, 39, 80])], CFG);
  const alice = s.leaderboard[0];
  assert.equal(alice.fireRounds, 2); // 95, 96 (>= 95)
  assert.equal(alice.panicRounds, 2); // 40, 39 (<= 40)
});

test('win streak counts consecutive active days only', () => {
  // alice wins the 1st, 3rd and 10th active day (gap in dates is irrelevant)
  const s = computeStandings([
    row('2026-07-01', 'alice', 700), row('2026-07-01', 'bob', 600),
    row('2026-07-03', 'alice', 700), row('2026-07-03', 'bob', 600),
    row('2026-07-10', 'alice', 700), row('2026-07-10', 'bob', 600),
  ], CFG);
  assert.equal(s.badges.currentWinStreak.playerId, 'alice');
  assert.equal(s.badges.currentWinStreak.length, 3);
});

test('streak broken by a loss on an active day', () => {
  const s = computeStandings([
    row('2026-07-01', 'alice', 700), row('2026-07-01', 'bob', 600),
    row('2026-07-02', 'alice', 500), row('2026-07-02', 'bob', 600),
    row('2026-07-03', 'alice', 700), row('2026-07-03', 'bob', 600),
  ], CFG);
  assert.equal(s.badges.currentWinStreak.playerId, 'alice');
  assert.equal(s.badges.currentWinStreak.length, 1);
});

test('record and participation streak badges', () => {
  const s = computeStandings([
    row('2026-07-01', 'alice', 700), row('2026-07-02', 'alice', 990),
    row('2026-07-02', 'bob', 500), row('2026-07-03', 'alice', 600),
  ], CFG);
  assert.equal(s.badges.record.score, 990);
  assert.equal(s.badges.record.playerId, 'alice');
  assert.equal(s.badges.record.date, '2026-07-02');
  assert.equal(s.badges.longestParticipationStreak.playerId, 'alice');
  assert.equal(s.badges.longestParticipationStreak.length, 3);
});

test('leaderboard ranked by wins', () => {
  const s = computeStandings([
    row('2026-07-01', 'alice', 700), row('2026-07-01', 'bob', 600),
    row('2026-07-02', 'alice', 700), row('2026-07-02', 'bob', 600),
    row('2026-07-03', 'alice', 500), row('2026-07-03', 'bob', 600),
  ], CFG);
  assert.deepEqual(s.leaderboard.map((p) => p.playerId), ['alice', 'bob']);
  assert.deepEqual(s.leaderboard[0].podiums, [2, 1, 0]);
});

test('dailyHistory: newest day first, winners flagged, ties share rank 1', () => {
  const h = dailyHistory([
    row('2026-07-19', 'a', 500), row('2026-07-19', 'b', 400),
    row('2026-07-20', 'x', 700), row('2026-07-20', 'y', 700), row('2026-07-20', 'z', 300),
  ]);
  assert.deepEqual(h.map((d) => d.date), ['2026-07-20', '2026-07-19']);
  assert.deepEqual(h[0].ranked.filter((r) => r.rank === 1).map((r) => r.name), ['x', 'y']);
  assert.equal(h[1].ranked[0].name, 'a');
  assert.equal(h[1].ranked[0].score, 500);
});
