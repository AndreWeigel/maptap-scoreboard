// Known-player registry. Storage stays raw (real WhatsApp ids), and only the
// display reads collapse a person's several identities into one canonical name.
//
// Each person gets every id they've posted under: backfill exports use the
// display name as the id, live WhatsApp uses an @lid. When someone posts from a
// new device, add that @lid here — until then their scores show up under their
// WhatsApp name tagged "(user not registered yet)".

// WhatsApp renders non-contacts as "~" + U+202F (narrow no-break space) + name,
// so that exact id is how "Dennis" arrives. Build it from a code point to keep
// this source file pure ASCII.
const DENNIS_ID = '~' + String.fromCharCode(0x202F) + 'dela nesto';

const USERS = [
  { name: 'Andre',      ids: ['16046064955519@lid', 'Andre'] },
  { name: 'Bodan',      ids: ['215942399299697@lid', 'Bodan Andonov'] },
  { name: 'Mila',       ids: ['173104512901278@lid', 'Mila Andonova'] },
  { name: 'Jan-Niklas', ids: ['95670480408676@lid', 'Jan-Niklas C.', 'Jan-Niklas'] },
  { name: 'Daniel',     ids: ['59777438757039@lid', 'Daniel Couvinha'] },
  { name: 'Fernando',   ids: ['Fernando Zu'] },
  { name: 'Afroze',     ids: ['Afroze Ibrahim'] },
  { name: 'Dennis',     ids: [DENNIS_ID] },
];

const NAME_BY_ID = new Map();
for (const u of USERS) for (const id of u.ids) NAME_BY_ID.set(id, u.name);

const UNREGISTERED_SUFFIX = ' (user not registered yet)';

// Map raw result rows to canonical identity. Known ids collapse onto the
// person's name (used as both grouping key and label); unknown ids stay
// distinct and get the "(user not registered yet)" tag.
// ponytail: if one person ever posts under two ids on the SAME day they'd count
// twice — can't happen today (one post/day), revisit if multi-device same-day appears.
function resolveRows(rows) {
  return rows.map((r) => {
    const name = NAME_BY_ID.get(r.player_id);
    return name
      ? { ...r, player_id: name, player_name: name }
      : { ...r, player_name: `${r.player_name}${UNREGISTERED_SUFFIX}` };
  });
}

module.exports = { USERS, NAME_BY_ID, UNREGISTERED_SUFFIX, resolveRows };
