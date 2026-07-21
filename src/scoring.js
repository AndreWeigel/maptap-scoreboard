// Pure functions over `results` rows — the standings are always derived, never stored.

// Competition ranking per spec acceptance tests: tie at top -> both rank 1, next ranks 3.
function rankDay(rows) {
  const sorted = [...rows].sort((a, b) => b.final_score - a.final_score);
  let rank = 0;
  let prevScore = null;
  return sorted.map((r, i) => {
    if (r.final_score !== prevScore) {
      rank = i + 1;
      prevScore = r.final_score;
    }
    return { ...r, rank };
  });
}

// Per-day results, newest day first: [{ date, ranked: [{name, score, rank}] }].
function dailyHistory(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.play_date)) byDate.set(r.play_date, []);
    byDate.get(r.play_date).push(r);
  }
  return [...byDate.keys()].sort().reverse().map((date) => ({
    date,
    ranked: rankDay(byDate.get(date)).map((r) => ({
      name: r.player_name, score: r.final_score, rank: r.rank,
    })),
  }));
}

function computeStandings(rows, cfg) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.play_date)) byDate.set(r.play_date, []);
    byDate.get(r.play_date).push(r);
  }
  const activeDays = [...byDate.keys()].sort();
  const players = new Map();
  const winnersByDay = new Map();
  let record = null;

  for (const date of activeDays) {
    const ranked = rankDay(byDate.get(date));
    winnersByDay.set(date, new Set(ranked.filter((r) => r.rank === 1).map((r) => r.player_id)));
    for (const r of ranked) {
      let p = players.get(r.player_id);
      if (!p) {
        p = {
          playerId: r.player_id, name: r.player_name, wins: 0, podiums: [0, 0, 0],
          played: 0, totalFinal: 0, best: 0, fire: 0, panic: 0, playedDays: new Set(),
        };
        players.set(r.player_id, p);
      }
      p.name = r.player_name;
      p.played++;
      p.playedDays.add(date);
      p.totalFinal += r.final_score;
      if (r.final_score > p.best) p.best = r.final_score;
      if (r.rank <= 3) p.podiums[r.rank - 1]++;
      if (r.rank === 1) p.wins++;
      for (const round of [r.round1, r.round2, r.round3, r.round4, r.round5]) {
        if (round >= cfg.FIRE_THRESHOLD) p.fire++;
        if (round <= cfg.PANIC_THRESHOLD) p.panic++;
      }
      if (!record || r.final_score > record.score) {
        record = { playerId: r.player_id, name: r.player_name, score: r.final_score, date };
      }
    }
  }

  const leaderboard = [...players.values()]
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      wins: p.wins,
      podiums: p.podiums,
      avgFinal: Math.round((p.totalFinal / p.played) * 10) / 10,
      best: p.best,
      played: p.played,
      participationPct: Math.round((100 * p.played) / activeDays.length),
      fireRounds: p.fire,
      panicRounds: p.panic,
    }))
    .sort((a, b) => b.wins - a.wins || b.avgFinal - a.avgFinal);

  // Current win streak: winners of the latest active day, counting back over
  // active days only (a day nobody played doesn't break it).
  let currentWinStreak = null;
  if (activeDays.length) {
    const lastDay = activeDays[activeDays.length - 1];
    for (const pid of winnersByDay.get(lastDay)) {
      let n = 0;
      for (let i = activeDays.length - 1; i >= 0 && winnersByDay.get(activeDays[i]).has(pid); i--) n++;
      if (!currentWinStreak || n > currentWinStreak.length) {
        currentWinStreak = { playerId: pid, name: players.get(pid).name, length: n };
      }
    }
  }

  let longestParticipationStreak = null;
  for (const p of players.values()) {
    let best = 0, cur = 0;
    for (const date of activeDays) {
      cur = p.playedDays.has(date) ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    if (!longestParticipationStreak || best > longestParticipationStreak.length) {
      longestParticipationStreak = { playerId: p.playerId, name: p.name, length: best };
    }
  }

  const maxBy = (key) => {
    let top = null;
    for (const p of players.values()) {
      if (p[key] > 0 && (!top || p[key] > top.count)) {
        top = { playerId: p.playerId, name: p.name, count: p[key] };
      }
    }
    return top;
  };

  return {
    activeDays: activeDays.length,
    leaderboard,
    badges: {
      record,
      mostFire: maxBy('fire'),
      currentWinStreak,
      longestParticipationStreak,
    },
  };
}

module.exports = { rankDay, computeStandings, dailyHistory };
