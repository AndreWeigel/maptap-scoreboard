# People Stories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a player card on `/globe` → panel with their photos, captions and story; all entered on the `/users` admin page with phone upload.

**Architecture:** Media fields (`story`, `photos`) ride on `data/users.json` via the existing `normalize()` whitelist. One new upload endpoint + one static mount in `src/web.js`. Both pages extend in place — no new modules, no new dependencies.

**Tech Stack:** Express 4 (`express.raw`, `express.static`), node:test, vanilla JS pages, MapLibre GL 6.6.0 (already on the globe page).

## Global Constraints

- Work happens in worktree `.claude/worktrees/people-stories` (branch `people-stories`).
- Run tests as `node --test test/` (bare `node --test` picks up stray worktrees).
- Upload whitelist: content-types image/jpeg, image/png, image/webp, image/gif; limit `8mb`; filename `crypto.randomBytes(8).toString('hex') + '.' + ext`.
- Photo filename pattern everywhere: `/^[a-f0-9]{16}\.(jpg|png|webp|gif)$/`.
- `/api/globe` response stays `{ layers: [{ id, label, points }] }` — additive only.
- Escape every user string rendered into HTML (`esc()` on /users; build DOM with `textContent` on /globe).
- UI changes are verified with real headless-Chrome screenshots before shipping.

---

### Task 1: `normalize()` keeps story + photos

**Files:**
- Modify: `src/users.js:33-48` (the `normalize` function)
- Test: `test/users.test.js`

**Interfaces:**
- Produces: saved user objects may carry `story: string` and `photos: [{ file, caption? }]`. Tasks 3–5 rely on exactly these key names.

- [ ] **Step 1: Write the failing test** — append to `test/users.test.js`:

```js
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
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node --test test/users.test.js`
Expected: new test fails (`story`/`photos` missing from saved output).

- [ ] **Step 3: Implement** — in `src/users.js`, add above `normalize`:

```js
// Photo files are exactly what POST /api/upload generates — anything else
// (traversal, foreign paths) is dropped on save.
const PHOTO_FILE = /^[a-f0-9]{16}\.(jpg|png|webp|gif)$/;
function cleanPhotos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.file === 'string' && PHOTO_FILE.test(p.file))
    .map((p) => ({
      file: p.file,
      ...(typeof p.caption === 'string' && p.caption.trim() ? { caption: p.caption.trim() } : {}),
    }));
}
```

and change the `.map((u) => ({ ... }))` body to compute photos first:

```js
      .map((u) => {
        const photos = cleanPhotos(u.photos);
        return {
          name: u.name.trim(),
          ids: Array.isArray(u.ids) ? [...new Set(u.ids.filter((x) => typeof x === 'string' && x))] : [],
          active: u.active !== false,
          // birth city for the /globe page; keys omitted entirely when unset
          ...(typeof u.city === 'string' && u.city.trim() ? { city: u.city.trim() } : {}),
          ...(typeof u.country === 'string' && u.country.trim() ? { country: u.country.trim() } : {}),
          ...(Number.isFinite(u.lat) && Number.isFinite(u.lng) ? { lat: u.lat, lng: u.lng } : {}),
          // people-stories media (photos validated against PHOTO_FILE)
          ...(typeof u.story === 'string' && u.story.trim() ? { story: u.story.trim() } : {}),
          ...(photos.length ? { photos } : {}),
        };
      }),
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test test/users.test.js` → all pass. Then `node --test test/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/users.js test/users.test.js
git commit -m "feat: users.json entries can carry story + photos"
```

---

### Task 2: upload endpoint + /uploads static serving

**Files:**
- Modify: `src/web.js` (new routes inside `createApp`, new requires at top, export `basicAuth`)
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /api/upload` (Basic Auth, raw image body) → `{ file: "<16 hex>.<ext>" }`; `GET /uploads/<file>` (public) serves it. `module.exports = { createApp, basicAuth }`. Tasks 4–5 use these routes; slice 2 uses `basicAuth`.

- [ ] **Step 1: Write the failing tests** — append to `test/web.test.js`:

```js
test('upload: auth required, images only, random name, served back', async () => {
  await withServer(async (base) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // fake png bytes
    assert.strictEqual((await fetch(`${base}/api/upload`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
    })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: authHeader('s3cret'), 'content-type': 'text/html' },
      body: 'nope',
    })).status, 400);
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: authHeader('s3cret'), 'content-type': 'image/png' },
      body: png,
    });
    assert.strictEqual(res.status, 200);
    const { file } = await res.json();
    assert.match(file, /^[a-f0-9]{16}\.png$/);
    try {
      const got = await fetch(`${base}/uploads/${file}`);
      assert.strictEqual(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    } finally { fs.rmSync(`data/uploads/${file}`, { force: true }); }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node --test test/web.test.js`
Expected: FAIL — `/api/upload` returns 404.

- [ ] **Step 3: Implement** — in `src/web.js`:

Top of file, next to the other requires:

```js
const fs = require('node:fs');
```

Inside `createApp`, after the `app.use(express.json(...))` line:

```js
  // ---- Photo uploads (people stories). Random server-side names; client names never used.
  const UPLOADS = path.join(path.dirname(config.DB_PATH), 'uploads');
  const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  // Random names never change content, so cache forever.
  // ponytail: photos served at original size; add resizing if page weight ever hurts.
  app.use('/uploads', express.static(UPLOADS, { maxAge: '365d', immutable: true }));

  app.post('/api/upload', basicAuth, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
    const ext = IMG_EXT[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'jpeg/png/webp/gif only' });
    }
    const file = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, file), req.body);
    res.json({ file });
  });
```

Bottom of file:

```js
module.exports = { createApp, basicAuth };
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test test/web.test.js` → pass. Then `node --test test/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/web.js test/web.test.js
git commit -m "feat: photo upload endpoint + /uploads static serving"
```

---

### Task 3: /api/globe points carry story + photos

**Files:**
- Modify: `src/web.js:125-136` (the `/api/globe` handler)
- Test: `test/web.test.js` (extend the existing `/api/globe` test)

**Interfaces:**
- Consumes: `story`/`photos` from Task 1's saved shape.
- Produces: globe points may carry `story: string` and `photos: [{ file, caption? }]`. Task 5 renders exactly these.

- [ ] **Step 1: Extend the failing test** — in the existing `'/api/globe: only active players with coords, layers shape'` test, give Ana media and assert it round-trips:

```js
      { name: 'Ana',  ids: [], city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61,
        story: 'Loves maps.', photos: [{ file: 'a1b2c3d4e5f60718.jpg', caption: 'Beach' }] },
```

and the matching expectation:

```js
        { label: 'Ana', city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61,
          story: 'Loves maps.', photos: [{ file: 'a1b2c3d4e5f60718.jpg', caption: 'Beach' }] },
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node --test test/web.test.js` — deepStrictEqual fails (no story/photos on the point).

- [ ] **Step 3: Implement** — in the `/api/globe` points map, after the lat/lng lines:

```js
        ...(u.story ? { story: u.story } : {}),
        ...(u.photos ? { photos: u.photos } : {}),
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test test/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/web.js test/web.test.js
git commit -m "feat: globe points carry story + photos"
```

---

### Task 4: /users admin page — story + photo strip

**Files:**
- Modify: `views/users.html`

**Interfaces:**
- Consumes: `POST /api/upload` → `{ file }` (Task 2); `story`/`photos` fields (Task 1). Persistence rides the existing Save → `POST /api/users`.

- [ ] **Step 1: CSS** — add to the `<style>` block:

```css
  .story { width: 100%; margin: 0 0 8px; background: rgba(10,14,34,.72); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font: .82rem/1.45 var(--body); padding: 6px 8px; resize: vertical; min-height: 34px; }
  .story:focus { outline: none; border-color: rgba(34,211,238,.4); }
  .photos { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 8px; }
  .ph { position: relative; width: 96px; }
  .ph img { width: 96px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); display: block; }
  .ph input { width: 100%; margin-top: 3px; background: rgba(10,14,34,.72); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font: .68rem var(--mono); padding: 3px 5px; }
  .ph .del { position: absolute; top: 2px; right: 2px; background: rgba(7,11,28,.75); border-radius: 6px; }
  .addph { width: 96px; height: 72px; display: flex; align-items: center; justify-content: center; cursor: pointer;
    border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); font: .78rem var(--mono); }
  .addph:hover { border-color: rgba(34,211,238,.4); color: var(--cyan); }
  .addph.busy { opacity: .5; pointer-events: none; }
```

- [ ] **Step 2: Card template** — in `render()`, between the `cityrow` div and the `zone dropzone` div, insert:

```js
      <textarea class="story" data-story="${i}" placeholder="Their story — shows on the globe">${esc(u.story || '')}</textarea>
      <div class="photos">
        ${(u.photos || []).map((p, j) => `
        <div class="ph">
          <img src="/uploads/${esc(p.file)}" alt="">
          <input data-cap="${i}:${j}" placeholder="Caption" value="${esc(p.caption || '')}">
          <button class="del" data-delphoto="${i}:${j}" title="Remove photo">✕</button>
        </div>`).join('')}
        <label class="addph">+ photo<input type="file" accept="image/*" data-photo="${i}" hidden></label>
      </div>
```

- [ ] **Step 3: Wire events** — extend the existing `board` `change` listener: at its top, before the `[data-city]` branch, add:

```js
  const st = e.target.closest('[data-story]');
  if (st) { const u = state.users[+st.dataset.story]; u.story = st.value; dirty = true; render(); return; }
  const cap = e.target.closest('[data-cap]');
  if (cap) {
    const [i, j] = cap.dataset.cap.split(':').map(Number);
    state.users[i].photos[j].caption = cap.value;
    dirty = true; render(); return;
  }
  const ph = e.target.closest('[data-photo]');
  if (ph && ph.files[0]) {
    const u = state.users[+ph.dataset.photo], f = ph.files[0];
    ph.closest('.addph').classList.add('busy');
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': f.type }, body: f });
      if (!r.ok) throw new Error(r.status);
      (u.photos ||= []).push({ file: (await r.json()).file });
      dirty = true; render();
    } catch { alert('Upload failed — jpeg/png/webp/gif up to 8 MB.'); render(); }
    return;
  }
```

and extend the existing `board` `click` listener with photo delete, next to the other branches:

```js
  const dp = e.target.closest('[data-delphoto]');
  if (dp) {
    const [i, j] = dp.dataset.delphoto.split(':').map(Number);
    state.users[i].photos.splice(j, 1);
    dirty = true; render();
  }
```

Also update the `p.hint` text to mention photos: append `Add photos + a story and they show when someone clicks the player on the globe.`

- [ ] **Step 4: Screenshot verification** (handover lesson 3)

Build a stub in the scratchpad: `stub.js` — express-less `node:http` or reuse express from the worktree's node_modules; serves `views/users.html` at `/users` (no auth), a seeded `/api/users` JSON (one user with a photo + caption + story, one without), `/api/upload` returning `{ file: 'a1b2c3d4e5f60718.jpg' }`, `/uploads/a1b2c3d4e5f60718.jpg` returning a generated PNG, and `/slow?ms=...` (1×1 gif delayed) for shutter timing. Screenshot:

```bash
chrome --headless=new --screenshot=/path/users.png --window-size=1200,900 http://127.0.0.1:3101/users
```

Check: story textarea filled, photo thumbnail + caption visible, `+ photo` tile present, nothing overlapping.

- [ ] **Step 5: Run all tests, commit**

```bash
node --test test/
git add views/users.html
git commit -m "feat: story + photo management on the players admin page"
```

---

### Task 5: /globe page — story panel on card click

**Files:**
- Modify: `views/globe.html`

**Interfaces:**
- Consumes: `/api/globe` points with optional `story`/`photos` (Task 3); `/uploads/<file>` (Task 2).

- [ ] **Step 1: CSS + markup** — add to `<style>`:

```css
  #panel { position: fixed; top: 60px; right: 14px; bottom: 14px; z-index: 4; width: min(340px, calc(100vw - 28px));
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px;
    overflow-y: auto; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #panel[hidden] { display: none; }
  #panel .close { position: sticky; top: 0; float: right; background: rgba(7,11,28,.75); border: 1px solid var(--border);
    border-radius: 8px; color: var(--muted); cursor: pointer; font-size: 1rem; padding: 2px 8px; }
  #panel .close:hover { color: var(--cyan); }
  #panel h2 { font: 700 1.05rem/1.3 var(--body); margin: 0 0 2px; }
  #panel .place { font: .72rem var(--mono); color: var(--muted); margin: 0 0 8px; }
  #panel .story { font-size: .88rem; margin: 0 0 10px; white-space: pre-wrap; }
  #panel img { width: 100%; border-radius: 10px; border: 1px solid var(--border); display: block; }
  #panel .cap { font: .72rem var(--mono); color: var(--muted); margin: 4px 0 12px; }
  #panel .person + .person { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 14px; }
```

After the `#status` div in `<body>`:

```html
<div id="panel" hidden><button class="close" title="Close">✕</button><div id="pbody"></div></div>
```

- [ ] **Step 2: Group full point objects** — in the merge loop, also keep each person:

```js
      if (!byCoord.has(k)) byCoord.set(k, { ...p, names: [], people: [] });
      byCoord.get(k).names.push(p.label);
      byCoord.get(k).people.push(p);
```

- [ ] **Step 3: Panel logic** — near the top of the module script:

```js
const panel = document.getElementById('panel');
const pbody = document.getElementById('pbody');
panel.querySelector('.close').addEventListener('click', () => { panel.hidden = true; });

// All content is untrusted user text — build with createElement/textContent, never innerHTML.
function openPanel(g) {
  pbody.replaceChildren(...g.people.map((p) => {
    const d = document.createElement('div');
    d.className = 'person';
    const add = (tag, cls, text) => {
      const el = document.createElement(tag);
      el.className = cls; el.textContent = text;
      d.appendChild(el); return el;
    };
    add('h2', '', p.label);
    add('p', 'place', [p.city, p.country].filter(Boolean).join(' · '));
    if (p.story) add('p', 'story', p.story);
    for (const ph of p.photos || []) {
      const img = document.createElement('img');
      img.src = `/uploads/${ph.file}`; img.alt = ph.caption || p.label; img.loading = 'lazy';
      d.appendChild(img);
      add('p', 'cap', ph.caption || '');
    }
    return d;
  }));
  panel.hidden = false;
}
```

and in the card click handler, after the `flyTo` call: `openPanel(g);`

- [ ] **Step 4: Screenshot verification**

Extend the Task 4 stub: `/globe` serves `views/globe.html`, `/api/globe` returns two people sharing one coordinate (one with story + 2 photos, one bare) plus one solo person; `/uploads/*` returns the stub PNG. Use the `/drive` iframe pattern with `window.map` if the camera needs jumping. Screenshots: (a) globe with cards, (b) after clicking a card — panel showing both people, photos, captions. Click via Chrome `--headless=new` needs the drive page (dispatch a click on the card element through the iframe) or temporarily auto-open: simplest is the drive page calling `document.querySelector('.pcard').click()` inside the iframe after load. Verify: panel readable, photos sized right, no overlap with status/credit, mobile width (`--window-size=420,800`) shows the panel usable.

- [ ] **Step 5: Run all tests, commit**

```bash
node --test test/
git add views/globe.html
git commit -m "feat: player story panel on the globe"
```

---

### Task 6: ship it

**Files:** none new.

- [ ] **Step 1: Full verification in the worktree**

```bash
node --test test/
```
Expected: all pass, zero failures.

- [ ] **Step 2: Merge to local main, re-test**

```bash
cd /Users/andre/Projects/maptap-scoreboard
git merge --no-ff people-stories -m "feat: people stories on the globe (slice 1)"
node --test test/
```

- [ ] **Step 3: Push + manual deploy** (CI deploy has no secrets — never deploys)

```bash
git push
ssh root@46.224.233.5 'cd /root/maptap-scoreboard && git pull --ff-only && docker compose up -d --build'
ssh root@46.224.233.5 'curl -s localhost:3000/healthz'
```
Expected: healthz `{"status":"ok"...}` (or `degraded` if WhatsApp is down — that's pre-existing, not this slice).

- [ ] **Step 4: Clean up worktree**

```bash
git worktree remove .claude/worktrees/people-stories
git branch -d people-stories
```
