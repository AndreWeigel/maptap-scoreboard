#!/usr/bin/env node
// Ingest an exported WhatsApp .txt chat log through the same parser as live messages.
// Usage: node scripts/backfill.js export.txt
const fs = require('node:fs');
const config = require('../config');
process.env.TZ = config.TZ;
const { openDb } = require('../src/db');
const { ingestMessage } = require('../src/ingest');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/backfill.js <whatsapp-export.txt>');
  process.exit(1);
}

// Android export: "7/20/26, 08:14 - Alice: text" — continuation lines have no prefix.
const MSG_START = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?\s*-\s*([^:]+):\s?(.*)$/;

function prefixDate(a, b, y) {
  // ponytail: assumes M/D/Y per spec example; if first number > 12 it must be D/M/Y
  const [month, day] = a > 12 ? [b, a] : [a, b];
  const year = y < 100 ? 2000 + y : y;
  return new Date(year, month - 1, day, 12); // noon; parser prefers the header date anyway
}

const db = openDb(config.DB_PATH);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const counts = { ok: 0, replaced: 0, failure: 0, ignored: 0 };
let current = null;

function flush() {
  if (!current) return;
  // ponytail: export has no JIDs, so the sender name is the player_id; if the same
  // player later posts live under a JID, merge with an UPDATE (see README)
  const res = ingestMessage(db, {
    playerId: current.sender,
    playerName: current.sender,
    text: current.text,
    now: current.ts,
  });
  counts[res.kind === 'ok' && res.replaced ? 'replaced' : res.kind]++;
  current = null;
}

for (const line of lines) {
  const m = line.match(MSG_START);
  if (m) {
    flush();
    current = {
      ts: prefixDate(Number(m[1]), Number(m[2]), Number(m[3])),
      sender: m[4].trim(),
      text: m[5],
    };
  } else if (current) {
    current.text += '\n' + line;
  }
}
flush();

console.log(`Backfill done: ${counts.ok} ingested, ${counts.replaced} replaced, ${counts.failure} parse failures, ${counts.ignored} ignored.`);
