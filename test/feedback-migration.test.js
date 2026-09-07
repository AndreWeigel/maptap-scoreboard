// The email column is added to feedback tables that predate it. This path only
// runs against a DB that already exists on disk, so :memory: never exercises it
// — and it's the one that runs on the server, where getting it wrong means the
// container crashloops on boot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');

test('an old feedback table gains the email column, keeping its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maptap-'));
  const file = path.join(dir, 'scores.db');

  // The shape shipped before email existed: sender nullable, no email at all.
  const old = new Database(file);
  old.exec(`CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, message TEXT NOT NULL,
    sender TEXT, created_at TEXT NOT NULL)`);
  old.prepare('INSERT INTO feedback (kind, message, sender, created_at) VALUES (?,?,?,?)')
    .run('bug', 'written before the email field', null, '2026-09-07T10:00:00.000Z');
  old.close();

  const db = openDb(file);
  const cols = db.raw.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name);
  assert.ok(cols.includes('email'), 'email column should have been added');

  // The pre-existing row survives with a null email, and new rows still write.
  db.addFeedback({ kind: 'feature', message: 'after', sender: 'Hen', email: 'hen@example.com', created_at: '2026-09-07T11:00:00.000Z' });
  const rows = db.listFeedback();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find((r) => r.message === 'written before the email field').email, null);
  assert.strictEqual(rows.find((r) => r.message === 'after').email, 'hen@example.com');

  // Opening again must not try to add the column a second time.
  assert.doesNotThrow(() => openDb(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
