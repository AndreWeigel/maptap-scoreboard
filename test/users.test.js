const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const users = require('../src/users');

const DENNIS_ID = '~' + String.fromCharCode(0x202F) + 'dela nesto';
const row = (id, name) => ({ play_date: '2026-07-21', player_id: id, player_name: name, final_score: 1 });

test('resolveRows: known ids collapse to canonical name, unknown ids dropped', () => {
  try {
    users.save({ users: [
      { name: 'Daniel', ids: ['59777438757039@lid', 'Daniel Couvinha'] },
      { name: 'Dennis', ids: [DENNIS_ID] },
    ] });
    const out = users.resolveRows([
      row('59777438757039@lid', 'dan'),
      row('Daniel Couvinha', 'Daniel Couvinha'),
      row(DENNIS_ID, 'whatever'),
      row('99999@lid', 'Newbie'),
    ]);
    assert.deepEqual(out.map((r) => r.player_id), ['Daniel', 'Daniel', 'Dennis']);
    assert.ok(!out.some((r) => r.player_id === '99999@lid'), 'unassigned id must not reach the board');
  } finally { fs.rmSync(users.FILE, { force: true }); }
});

test('resolveRows: rows of inactive users are dropped entirely', () => {
  try {
    users.save({ users: [
      { name: 'Gone', ids: ['g@lid'], active: false },
      { name: 'Here', ids: ['h@lid'], active: true },
    ] });
    const out = users.resolveRows([row('g@lid', 'Gone'), row('h@lid', 'Here')]);
    assert.deepEqual(out.map((r) => r.player_id), ['Here']);
  } finally { fs.rmSync(users.FILE, { force: true }); }
});

test('save normalizes: drops nameless, dedups ids, defaults active true', () => {
  try {
    const saved = users.save({ users: [
      { name: '  Bob ', ids: ['a', 'a', 'b'] },
      { name: '', ids: ['x'] },
      { ids: ['y'] },
    ] });
    assert.equal(saved.users.length, 1);
    assert.deepEqual(saved.users[0], { name: 'Bob', ids: ['a', 'b'], active: true });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});
