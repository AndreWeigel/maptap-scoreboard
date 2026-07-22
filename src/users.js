// Player registry: maps each person's WhatsApp identities (backfill display-name
// ids and live @lid ids) to one canonical name. Editable at runtime from the
// /users admin page, persisted to data/users.json. The SEED below is the
// starting roster used until that file is first written.
//
// `active: false` keeps a person's history in the DB but hides them everywhere
// (leaderboard, daily winners, digests) — for when someone leaves the group.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const FILE = path.join(path.dirname(config.DB_PATH), 'users.json');
const UNREGISTERED_SUFFIX = ' (user not registered yet)';

// WhatsApp renders non-contacts as "~" + U+202F (narrow no-break space) + name.
const DENNIS_ID = '~' + String.fromCharCode(0x202F) + 'dela nesto';

const SEED = [
  { name: 'Andre',      ids: ['16046064955519@lid', 'Andre'] },
  { name: 'Bodan',      ids: ['215942399299697@lid', 'Bodan Andonov'] },
  { name: 'Mila',       ids: ['173104512901278@lid', 'Mila Andonova'] },
  { name: 'Jan-Niklas', ids: ['95670480408676@lid', 'Jan-Niklas C.', 'Jan-Niklas'] },
  { name: 'Daniel',     ids: ['59777438757039@lid', 'Daniel Couvinha'] },
  { name: 'Fernando',   ids: ['123287153688707@lid', 'Fernando Zu'] },
  { name: 'Afroze',     ids: ['63591352950909@lid', 'Afroze Ibrahim'] },
  { name: 'Dennis',     ids: [DENNIS_ID] },
  { name: 'Brandi',     ids: ['118468150055005@lid', 'Brandi'] },
  { name: 'Yanina',     ids: ['177158945300634@lid', 'Yanina Isla'] },
  { name: 'Alice',      ids: ['47523947380872@lid'] },
];

// Coerce arbitrary input into a clean registry: valid names, unique string ids,
// active defaulting to true.
function normalize(reg) {
  const users = Array.isArray(reg && reg.users) ? reg.users : [];
  return {
    users: users
      .filter((u) => u && typeof u.name === 'string' && u.name.trim())
      .map((u) => ({
        name: u.name.trim(),
        ids: Array.isArray(u.ids) ? [...new Set(u.ids.filter((x) => typeof x === 'string' && x))] : [],
        active: u.active !== false,
      })),
  };
}

let cache;
function get() {
  if (!cache) {
    try { cache = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
    catch { cache = normalize({ users: SEED }); }
  }
  return cache;
}

function save(reg) {
  cache = normalize(reg);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  return cache;
}

function lookup() {
  const nameById = new Map();
  const activeByName = new Map();
  for (const u of get().users) {
    activeByName.set(u.name, u.active);
    for (const id of u.ids) nameById.set(id, u.name);
  }
  return { nameById, activeByName };
}

// Resolve raw result rows to canonical identity for display/grouping. Known ids
// collapse onto the person's name; rows of inactive users are dropped; unknown
// ids stay distinct and get the "(user not registered yet)" tag.
function resolveRows(rows) {
  const { nameById, activeByName } = lookup();
  const out = [];
  for (const r of rows) {
    const name = nameById.get(r.player_id);
    if (name === undefined) {
      out.push({ ...r, player_name: `${r.player_name}${UNREGISTERED_SUFFIX}` });
    } else if (activeByName.get(name)) {
      out.push({ ...r, player_id: name, player_name: name });
    }
    // inactive user: skip
  }
  return out;
}

module.exports = { get, save, resolveRows, SEED, FILE, UNREGISTERED_SUFFIX };
