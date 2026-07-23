// Import maptap results from a pasted/uploaded WhatsApp .txt export. Two steps:
// preview() groups the results by sender and flags who's already a registered
// player, then run() ingests only the senders you picked. Registered ids are
// never touched, so an import can't overwrite an existing player's history.
const { parseMessages } = require('../scripts/backfill');
const { parseResult, FINAL_RE } = require('./parser');
const { ingestMessage } = require('./ingest');
const usersStore = require('./users');

// ids already claimed by a player (active or not) — protected from import
function assignedIds() {
  return new Set(usersStore.get().users.flatMap((u) => u.ids));
}

// [{ sender, count, from, to, registered }] — one row per sender with results,
// most results first.
function preview(text) {
  const assigned = assignedIds();
  const bySender = new Map();
  for (const m of parseMessages(text)) {
    if (!FINAL_RE.test(m.text)) continue;
    const p = parseResult(m.text, m.ts);
    if (!p.ok) continue;
    if (!bySender.has(m.sender)) bySender.set(m.sender, []);
    bySender.get(m.sender).push(p.playDate);
  }
  return [...bySender.entries()].map(([sender, dates]) => {
    const sorted = dates.slice().sort();
    return { sender, count: dates.length, from: sorted[0], to: sorted[sorted.length - 1], registered: assigned.has(sender) };
  }).sort((a, b) => b.count - a.count);
}

// Ingest results for the chosen senders. Skips any sender that's already
// registered (belt-and-suspenders — the UI won't offer them either).
function run(db, text, senders) {
  const assigned = assignedIds();
  const pick = new Set(senders);
  const counts = { imported: 0, replaced: 0, skippedRegistered: 0 };
  for (const m of parseMessages(text)) {
    if (!pick.has(m.sender)) continue;
    if (assigned.has(m.sender)) { counts.skippedRegistered++; continue; }
    const res = ingestMessage(db, { playerId: m.sender, playerName: m.sender, text: m.text, now: m.ts });
    if (res.kind === 'ok') counts[res.replaced ? 'replaced' : 'imported']++;
  }
  return counts;
}

module.exports = { preview, run };
