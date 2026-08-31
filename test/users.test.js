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

test('save keeps city and coords, drops junk, coords only as a pair', () => {
  try {
    const saved = users.save({ users: [
      { name: 'Ana',  ids: [], city: ' Porto ', country: ' Portugal ', lat: 41.15, lng: -8.61 },
      { name: 'Bob',  ids: [], city: 42, country: 7, lat: 'x', lng: -8 }, // junk city, country, lat
      { name: 'Cara', ids: [], lat: 50.1 },                              // lat without lng
    ] });
    assert.deepEqual(saved.users[0], { name: 'Ana', ids: [], active: true, city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61 });
    assert.deepEqual(saved.users[1], { name: 'Bob', ids: [], active: true });
    assert.deepEqual(saved.users[2], { name: 'Cara', ids: [], active: true });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});

test('save keeps story and valid photos, drops junk photos and captions', () => {
  try {
    const saved = users.save({ users: [
      { name: 'Ana', ids: [], story: '  Loves maps.  ', photos: [
        { file: 'a1b2c3d4e5f60718.jpg', caption: ' At the beach ' },
        { file: 'a1b2c3d4e5f60718.png' },                    // no caption: fine
        { file: '../../etc/passwd' },                        // traversal: dropped
        { file: 'a1b2c3d4e5f60718.svg' },                    // bad ext: dropped
        { file: 'a1b2c3d4e5f60718.jpg', caption: 42 },       // junk caption: kept, caption dropped
        'nope',                                              // not an object: dropped
      ] },
      { name: 'Bob', ids: [], story: '   ', photos: 'nope' }, // blank story + junk photos: both dropped
    ] });
    assert.deepEqual(saved.users[0].story, 'Loves maps.');
    assert.deepEqual(saved.users[0].photos, [
      { file: 'a1b2c3d4e5f60718.jpg', caption: 'At the beach' },
      { file: 'a1b2c3d4e5f60718.png' },
      { file: 'a1b2c3d4e5f60718.jpg' },
    ]);
    assert.deepEqual(saved.users[1], { name: 'Bob', ids: [], active: true });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});
