// The notification must never cost us the report. If SMTP is down, misconfigured
// or just slow, the row is already committed and the sender still sees "thanks" —
// otherwise a dead mail server silently turns into lost bug reports.
process.env.ADMIN_TOKEN = 's3cret';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/web');
const { openDb } = require('../src/db');
const mail = require('../src/mail');

async function post(base, body) {
  return fetch(`${base}/api/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const report = (over = {}) =>
  ({ kind: 'bug', message: 'globe spins backwards', sender: 'Hen', email: 'hen@example.com', ...over });

async function withServer(db, fn) {
  const server = createApp(db, { whatsappConnected: true, lastMessageAt: null }).listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

test('a failing mail send still stores the feedback and returns ok', async () => {
  const db = openDb(':memory:');
  const original = mail.sendFeedbackMail;
  mail.sendFeedbackMail = async () => { throw new Error('smtp is on fire'); };
  try {
    await withServer(db, async (base) => {
      const res = await post(base, report());
      assert.strictEqual(res.status, 200, 'sender should still be thanked');
      assert.deepStrictEqual(await res.json(), { ok: true });
    });
    assert.strictEqual(db.listFeedback().length, 1, 'the report must survive a mail failure');
  } finally {
    mail.sendFeedbackMail = original;
  }
});

test('a valid report is handed to the mailer with a reply-to address', async () => {
  const db = openDb(':memory:');
  const original = mail.sendFeedbackMail;
  const seen = [];
  mail.sendFeedbackMail = async (row) => { seen.push(row); return { sent: true }; };
  try {
    await withServer(db, async (base) => { await post(base, report()); });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].email, 'hen@example.com');
    assert.strictEqual(seen[0].kind, 'bug');
    assert.strictEqual(seen[0].message, 'globe spins backwards');
  } finally {
    mail.sendFeedbackMail = original;
  }
});

test('rejected submissions never reach the mailer', async () => {
  const db = openDb(':memory:');
  const original = mail.sendFeedbackMail;
  let calls = 0;
  mail.sendFeedbackMail = async () => { calls += 1; return { sent: true }; };
  try {
    await withServer(db, async (base) => {
      assert.strictEqual((await post(base, report({ email: 'nope' }))).status, 400);
      assert.strictEqual((await post(base, report({ sender: '' }))).status, 400);
    });
    assert.strictEqual(calls, 0);
  } finally {
    mail.sendFeedbackMail = original;
  }
});

test('mail is off until both SMTP credentials are set', () => {
  assert.strictEqual(mail.enabled(), false, 'no SMTP_USER/SMTP_PASS in the test env');
});
