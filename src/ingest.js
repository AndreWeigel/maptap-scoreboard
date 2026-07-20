// Shared ingestion path: live WhatsApp messages and backfill go through here,
// so both use the exact same parser and upsert rules.
const { parseResult, FINAL_RE } = require('./parser');

function ingestMessage(db, { playerId, playerName, text, now = new Date() }) {
  if (!FINAL_RE.test(text)) return { kind: 'ignored' };

  const parsed = parseResult(text, now);
  if (!parsed.ok) {
    db.logParseFailure(playerId, text, parsed.reason, now);
    console.warn(`[ingest] parse failure from ${playerName}: ${parsed.reason}`);
    return { kind: 'failure', reason: parsed.reason };
  }

  db.upsertPlayer(playerId, playerName, now);
  const [round1, round2, round3, round4, round5] = parsed.rounds;
  const { replaced } = db.upsertResult({
    play_date: parsed.playDate,
    player_id: playerId,
    player_name: playerName,
    round1, round2, round3, round4, round5,
    final_score: parsed.finalScore,
    raw_text: text,
    created_at: now.toISOString(),
  });
  if (replaced) console.log(`[ingest] replaced ${playerName}'s result for ${parsed.playDate}`);
  return { kind: 'ok', playDate: parsed.playDate, replaced };
}

module.exports = { ingestMessage };
