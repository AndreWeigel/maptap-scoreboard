// Pure text builders for the WhatsApp group digests. Both take raw `results`
// rows and return a string, or null when there's nothing worth posting.
const { rankDay, computeStandings } = require('./scoring');

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = (s) => { const d = day(s); return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`; };

// One line after each night's scoring: winner(s), best score, average, headcount.
function dailySummary(rows, playDate) {
  if (!rows.length) return null;
  const ranked = rankDay(rows);
  const best = ranked[0].final_score;
  const winners = ranked.filter((r) => r.rank === 1).map((r) => r.player_name).join(', ');
  const avg = Math.round(rows.reduce((s, r) => s + r.final_score, 0) / rows.length);
  return `🎯 maptap — ${fmt(playDate)}\n🥇 ${winners}  ${best}\n📊 avg ${avg} · ${rows.length} player${rows.length === 1 ? '' : 's'}`;
}

// Monday recap of the prior week: win counts, best average, record, live streak.
function weeklySummary(rows, from, to, cfg) {
  const s = computeStandings(rows, cfg);
  if (!s.activeDays) return null;

  const wins = s.leaderboard.filter((p) => p.wins > 0)
    .map((p) => `${p.name} ${p.wins}`).join(' · ');
  const topAvg = [...s.leaderboard].sort((a, b) => b.avgFinal - a.avgFinal)[0];
  const rec = s.badges.record;
  const streak = s.badges.currentWinStreak;

  const a = day(from), b = day(to);
  const range = a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MO[b.getMonth()]}`
    : `${a.getDate()} ${MO[a.getMonth()]} – ${b.getDate()} ${MO[b.getMonth()]}`;
  const lines = [`📅 Week of ${range}`];
  if (wins) lines.push(`🏆 Wins: ${wins}`);
  if (topAvg) lines.push(`📈 Best avg: ${topAvg.name} ${topAvg.avgFinal}`);
  if (rec) lines.push(`🔥 Record: ${rec.name} ${rec.score} (${WD[day(rec.date).getDay()]})`);
  if (streak && streak.length >= 2) lines.push(`⚡ Streak: ${streak.name} on ${streak.length}`);
  return lines.join('\n');
}

module.exports = { dailySummary, weeklySummary };
