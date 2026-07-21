const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRows, NAME_BY_ID } = require('../src/users');

const row = (id, name) => ({ play_date: '2026-07-21', player_id: id, player_name: name, final_score: 1 });

test('known ids collapse onto the canonical name, across both id forms', () => {
  const out = resolveRows([row('59777438757039@lid', 'dan'), row('Daniel Couvinha', 'Daniel Couvinha')]);
  assert.deepEqual(out.map((r) => r.player_id), ['Daniel', 'Daniel']);
  assert.deepEqual(out.map((r) => r.player_name), ['Daniel', 'Daniel']);
});

test('the U+202F "~ dela nesto" id resolves to Dennis', () => {
  const dennisId = '~' + String.fromCharCode(0x202F) + 'dela nesto';
  assert.equal(NAME_BY_ID.get(dennisId), 'Dennis');
  assert.equal(resolveRows([row(dennisId, 'whatever')])[0].player_name, 'Dennis');
});

test('unknown ids are kept but tagged, and never collide with a known name', () => {
  const [out] = resolveRows([row('99999@lid', 'Newbie')]);
  assert.equal(out.player_id, '99999@lid');
  assert.equal(out.player_name, 'Newbie (user not registered yet)');
});
