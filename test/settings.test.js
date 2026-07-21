const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const settings = require('../src/settings');

test('set persists only known boolean keys, ignoring junk', () => {
  try {
    const out = settings.set({ dailySummary: true, weeklySummary: false, bogus: 1, weeklySummary_typo: true });
    assert.deepStrictEqual(out, { dailySummary: true, weeklySummary: false });
    // round-trips through the file
    const onDisk = JSON.parse(fs.readFileSync(settings.FILE, 'utf8'));
    assert.strictEqual(onDisk.dailySummary, true);
    assert.strictEqual(onDisk.bogus, undefined);
    // a non-boolean value for a known key is ignored, keeping the prior value
    assert.strictEqual(settings.set({ dailySummary: 'yes' }).dailySummary, true);
  } finally {
    fs.rmSync(settings.FILE, { force: true });
  }
});
