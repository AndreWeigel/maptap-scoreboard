// Parse a maptap.gg result message into { rounds[5], finalScore, playDate }.
// Anchor-based: keys off the "Final score:" line and the last line before it
// with exactly five integers. Everything else (emojis, shouts) is noise.

const FINAL_RE = /Final score:\s*(\d+)/i;
const DATE_RE = /maptap\.gg\s+([\p{L}]+)\s+(\d{1,2})/iu;

// lowercase + strip diacritics, so 'März' -> 'marz'
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

const MONTHS_RAW = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
  // German (add other languages as members join)
  januar: 1, februar: 2, märz: 3, maerz: 3, mai: 5, juni: 6, juli: 7,
  oktober: 10, dezember: 12,
};
const MONTHS = Object.fromEntries(
  Object.entries(MONTHS_RAW).map(([k, v]) => [norm(k), v])
);

const pad = (n) => String(n).padStart(2, '0');

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Header date beats the clock (post-midnight posts belong to yesterday's game).
// Year from context: current year, unless that lands in the future -> previous year.
function resolveDate(text, now) {
  const m = text.match(DATE_RE);
  if (m) {
    const month = MONTHS[norm(m[1])];
    const day = Number(m[2]);
    if (month && day >= 1 && day <= 31) {
      const year = now.getFullYear();
      const date = `${year}-${pad(month)}-${pad(day)}`;
      return date > toDateStr(now) ? `${year - 1}-${pad(month)}-${pad(day)}` : date;
    }
    console.log(`[parser] unknown month word "${m[1]}" — falling back to server date (extend MONTHS)`);
  }
  return toDateStr(now);
}

function parseResult(text, now = new Date()) {
  const finalMatch = FINAL_RE.exec(text);
  if (!finalMatch) return { ok: false, reason: 'no "Final score:" line' };

  // Only look before "Final score:"; trailing reactions/shouts can't leak in.
  const before = text.slice(0, finalMatch.index);
  let rounds = null;
  const lines = before.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && !rounds; i--) {
    const nums = (lines[i].match(/\d{1,3}/g) || []).map(Number);
    if (nums.length === 5) rounds = nums;
  }
  if (!rounds) return { ok: false, reason: 'no line with exactly five round scores' };

  return {
    ok: true,
    rounds,
    finalScore: Number(finalMatch[1]),
    playDate: resolveDate(text, now),
  };
}

module.exports = { parseResult, toDateStr, FINAL_RE };
