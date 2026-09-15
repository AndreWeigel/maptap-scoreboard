#!/usr/bin/env node
// Ingest an exported WhatsApp .txt chat log through the same parser as live messages.
// Usage: node scripts/backfill.js export.txt
const fs = require('node:fs');
const config = require('../config');
process.env.TZ = config.TZ;
const { openDb } = require('../src/db');
const { ingestMessage } = require('../src/ingest');

// Two export dialects. Continuation lines have no prefix in either.
// Android: "7/20/26, 08:14 - Alice: text"
const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?\s*-\s*([^:]+):\s?(.*)$/;
// iOS:     "[20.07.26, 10:45:23] Alice: text"
const IOS = /^‎?\[(\d{1,2})\.(\d{1,2})\.(\d{2,4}),\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*([^:]+):\s?(.*)$/;

// noon, so a DST shift can't tip the date; the parser prefers the in-message
// header date anyway and only really needs the year from here.
const at = (y, month, day) => new Date(y < 100 ? 2000 + y : y, month - 1, day, 12);

function matchStart(line) {
  const a = ANDROID.exec(line);
  if (a) {
    // ponytail: assumes M/D/Y per spec example; if first number > 12 it must be D/M/Y
    const [month, day] = Number(a[1]) > 12 ? [+a[2], +a[1]] : [+a[1], +a[2]];
    return { ts: at(+a[3], month, day), sender: a[4].trim(), text: a[5] };
  }
  const i = IOS.exec(line);
  // Dotted iOS dates are day-first. Deliberately NO >12 swap heuristic here: it
  // would read every day <= 12 as a month and silently misdate half the export.
  if (i) return { ts: at(+i[3], +i[2], +i[1]), sender: i[4].trim(), text: i[5] };
  return null;
}

// Assemble an export into messages: each start line plus its continuation lines.
function parseMessages(text) {
  const msgs = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = matchStart(line);
    if (m) { if (current) msgs.push(current); current = m; }
    else if (current) current.text += '\n' + line;
  }
  if (current) msgs.push(current);
  return msgs;
}

function backfill(db, text, { after } = {}) {
  const counts = { ok: 0, replaced: 0, failure: 0, ignored: 0, skipped: 0 };
  for (const m of parseMessages(text)) {
    // Re-importing a day that already has rows does NOT replace them: the export
    // keys players by name, live rows by @lid, so both rows survive and the day is
    // counted twice. Pass `after` = the last day already recorded to cut the overlap.
    if (after && m.ts <= after) { counts.skipped++; continue; }
    // ponytail: export has no JIDs, so the sender name is the player_id; if the same
    // player later posts live under a JID, merge them on the /users admin page.
    const res = ingestMessage(db, { playerId: m.sender, playerName: m.sender, text: m.text, now: m.ts });
    counts[res.kind === 'ok' && res.replaced ? 'replaced' : res.kind]++;
  }
  return counts;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/backfill.js <whatsapp-export.txt> [after-YYYY-MM-DD]');
    console.error('  after-YYYY-MM-DD: skip that day and everything before it. Use the last day');
    console.error('  already in the DB, or every overlapping day gets counted twice.');
    process.exit(1);
  }
  // Local noon, matching the timestamps parseMessages builds, so the cutoff day compares equal.
  const after = process.argv[3] ? new Date(`${process.argv[3]}T12:00:00`) : null;
  const c = backfill(openDb(config.DB_PATH), fs.readFileSync(file, 'utf8'), { after });
  console.log(`Backfill done: ${c.ok} ingested, ${c.replaced} replaced, ${c.failure} parse failures, ${c.ignored} ignored, ${c.skipped} before cutoff.`);
}

module.exports = { matchStart, parseMessages, backfill };
