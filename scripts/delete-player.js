#!/usr/bin/env node
// Delete players by display name and rebuild standings.
// Usage: node scripts/delete-player.js "Yanina Isla" "Brandi" "Benoît Payet"
const config = require('../config');
process.env.TZ = config.TZ;
const { openDb } = require('../src/db');
const { scoreDay } = require('../src/cron');

function deletePlayers(db, names) {
  const raw = db.raw;
  const find = raw.prepare('SELECT player_id, display_name FROM players WHERE display_name = ?');
  const delResults = raw.prepare('DELETE FROM results WHERE player_id = ?');
  const delPlayer = raw.prepare('DELETE FROM players WHERE player_id = ?');
  const deleted = [];
  raw.transaction(() => {
    for (const name of names) {
      const rows = find.all(name);
      if (!rows.length) { console.warn(`no match: ${name}`); continue; }
      for (const { player_id } of rows) {
        delResults.run(player_id);
        delPlayer.run(player_id);
        deleted.push(name);
      }
    }
  })();
  return deleted;
}

module.exports = { deletePlayers };

if (require.main === module) {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('Usage: node scripts/delete-player.js "Name One" "Name Two"');
    process.exit(1);
  }
  const db = openDb(config.DB_PATH);
  const deleted = deletePlayers(db, names);
  // daily_results is derived — rebuild it for every remaining date.
  for (const date of db.getDates()) scoreDay(db, date);
  console.log(`Deleted ${deleted.length} player(s): ${deleted.join(', ')}`);
}
