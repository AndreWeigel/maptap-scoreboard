// Runtime-mutable toggles, persisted to data/settings.json (in the same volume
// as the DB). Defaults come from the DAILY_SUMMARY / WEEKLY_SUMMARY env flags,
// so an unset file behaves exactly like before. The /summary admin page flips
// these at runtime without a restart.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const FILE = path.join(path.dirname(config.DB_PATH), 'settings.json');
const DEFAULTS = { dailySummary: config.DAILY_SUMMARY, weeklySummary: config.WEEKLY_SUMMARY };
const KEYS = Object.keys(DEFAULTS);

let state;
function get() {
  if (!state) {
    try { state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
    catch { state = { ...DEFAULTS }; }
  }
  return state;
}

// Accepts only known boolean keys; ignores anything else.
function set(patch) {
  const next = { ...get() };
  for (const k of KEYS) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  state = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

module.exports = { get, set, FILE };
