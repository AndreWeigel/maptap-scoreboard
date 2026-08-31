const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseResult } = require('../src/parser');

const NOW = new Date('2026-07-20T10:00:00');

test('canonical example', () => {
  const r = parseResult('www.maptap.gg July 20\n88🎉 96🔥 97🔥 97🔥 7😱\nFinal score: 690', NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rounds, [88, 96, 97, 97, 7]);
  assert.equal(r.finalScore, 690);
  assert.equal(r.playDate, '2026-07-20');
});

test('mixed emojis after numbers still parse', () => {
  const r = parseResult('www.maptap.gg July 20\n90✨ 85🏆 100👑 60😭 99🏅\nFinal score: 434', NOW);
  assert.deepEqual(r.rounds, [90, 85, 100, 60, 99]);
});

test('trailing reaction on its own line is ignored', () => {
  const r = parseResult('www.maptap.gg July 20\n80🔥 95🔥 98🔥 92🔥 6😱\nFinal score: 665\n😂', NOW);
  assert.deepEqual(r.rounds, [80, 95, 98, 92, 6]);
  assert.equal(r.finalScore, 665);
});

test('trailing shout text is ignored', () => {
  const r = parseResult('www.maptap.gg July 20\n94🔥 97🔥 97🔥 93🔥 84\nFinal score: 916\nyeeeeeeeaaaahh', NOW);
  assert.equal(r.finalScore, 916);
  assert.deepEqual(r.rounds, [94, 97, 97, 93, 84]);
});

test('localized German month resolves same as English', () => {
  const r = parseResult('www.maptap.gg Juli 20\n88 96 97 97 7\nFinal score: 690', NOW);
  assert.equal(r.playDate, '2026-07-20');
});

test('diacritics in month tolerated', () => {
  const r = parseResult('www.maptap.gg März 5\n88 96 97 97 7\nFinal score: 690', new Date('2026-03-05T10:00:00'));
  assert.equal(r.playDate, '2026-03-05');
});

test('extra whitespace and blank lines tolerated', () => {
  const r = parseResult('\n  www.maptap.gg July 20 \n\n  88🎉  96🔥 97🔥 97🔥 7😱  \n\n Final score:  690 \n', NOW);
  assert.deepEqual(r.rounds, [88, 96, 97, 97, 7]);
  assert.equal(r.finalScore, 690);
});

test('only four rounds -> parse failure', () => {
  const r = parseResult('www.maptap.gg July 20\n88 96 97 97\nFinal score: 690', NOW);
  assert.equal(r.ok, false);
});

test('non-result message -> not parsed', () => {
  assert.equal(parseResult('who won yesterday?', NOW).ok, false);
});

test('post just after midnight keeps header date', () => {
  const r = parseResult('www.maptap.gg July 20\n88 96 97 97 7\nFinal score: 690', new Date('2026-07-21T00:14:00'));
  assert.equal(r.playDate, '2026-07-20');
});

test('header date in the future -> previous year', () => {
  const r = parseResult('www.maptap.gg December 31\n88 96 97 97 7\nFinal score: 690', new Date('2026-01-01T09:00:00'));
  assert.equal(r.playDate, '2025-12-31');
});

test('header date is tomorrow (player timezone ahead of server) -> same year', () => {
  // Player east of the server already sees Aug 27 while the server is on Aug 26.
  const r = parseResult('www.maptap.gg August 27\n91 92 59 100 93\nFinal score: 880', new Date('2026-08-26T22:55:00'));
  assert.equal(r.playDate, '2026-08-27');
});

test('January 1 header posted on December 31 -> next year', () => {
  const r = parseResult('www.maptap.gg January 1\n88 96 97 97 7\nFinal score: 690', new Date('2026-12-31T23:30:00'));
  assert.equal(r.playDate, '2027-01-01');
});

test('unknown month word falls back to server date', () => {
  const r = parseResult('www.maptap.gg Julio 20\n88 96 97 97 7\nFinal score: 690', new Date('2026-07-21T00:14:00'));
  assert.equal(r.ok, true);
  assert.equal(r.playDate, '2026-07-21');
});
