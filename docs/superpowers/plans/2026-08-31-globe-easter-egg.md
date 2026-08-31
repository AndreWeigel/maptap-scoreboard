# Globe Easter Egg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hidden `/globe` page — spinning low-poly 3D globe with a dot per player at their birth city, entered on the existing `/users` admin page.

**Architecture:** Player city + coords ride along in `data/users.json` (the existing registry in `src/users.js`); the admin page geocodes in the browser via Nominatim. One public JSON route serves generic point *layers* (extensible: more layers later = zero rework), one static page renders them with globe.gl from a CDN.

**Tech Stack:** Node 20 + Express (existing), `node:test` (existing), globe.gl 2.46.2 UMD via jsdelivr (bundles three.js — no npm install, no build step).

**Spec:** `docs/superpowers/specs/2026-08-31-globe-easter-egg-design.md`

## Global Constraints

- No new npm dependencies; browser libraries via pinned CDN URLs only.
- globe.gl pinned: `https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js` (verified 200).
- Countries GeoJSON pinned: `https://cdn.jsdelivr.net/gh/vasturiano/globe.gl@2.44.0/example/datasets/ne_110m_admin_0_countries.geojson` (verified 200).
- `/globe` and `/api/globe` are public (no basicAuth) — same exposure level as `/` and `/api/standings`: names + city only.
- All work happens in a git worktree (create via superpowers:using-git-worktrees before the first code change).
- `node --test` must pass after every task.
- Dark-UI styling matches the existing pages (see `:root` palette in `views/users.html:8-14`).

---

### Task 1: users.js carries city + coords

**Files:**
- Modify: `src/users.js:33-44` (the `normalize` function)
- Test: `test/users.test.js`

**Interfaces:**
- Produces: user objects from `users.get()`/`users.save()` may now carry `city` (trimmed non-empty string), `lat`, `lng` (finite numbers, only ever present as a pair). Absent when unset — keys are omitted, never `null`/`undefined`, so existing `deepEqual` tests stay green.

- [ ] **Step 1: Write the failing test** — append to `test/users.test.js`:

```js
test('save keeps city and coords, drops junk, coords only as a pair', () => {
  try {
    const saved = users.save({ users: [
      { name: 'Ana',  ids: [], city: ' Porto, Portugal ', lat: 41.15, lng: -8.61 },
      { name: 'Bob',  ids: [], city: 42, lat: 'x', lng: -8 },      // junk city, junk lat
      { name: 'Cara', ids: [], lat: 50.1 },                        // lat without lng
    ] });
    assert.deepEqual(saved.users[0], { name: 'Ana', ids: [], active: true, city: 'Porto, Portugal', lat: 41.15, lng: -8.61 });
    assert.deepEqual(saved.users[1], { name: 'Bob', ids: [], active: true });
    assert.deepEqual(saved.users[2], { name: 'Cara', ids: [], active: true });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/users.test.js`
Expected: FAIL — saved users have no `city` property (deepEqual mismatch on user 0).

- [ ] **Step 3: Minimal implementation** — in `src/users.js`, the `.map()` inside `normalize` becomes:

```js
      .map((u) => ({
        name: u.name.trim(),
        ids: Array.isArray(u.ids) ? [...new Set(u.ids.filter((x) => typeof x === 'string' && x))] : [],
        active: u.active !== false,
        ...(typeof u.city === 'string' && u.city.trim() ? { city: u.city.trim() } : {}),
        ...(Number.isFinite(u.lat) && Number.isFinite(u.lng) ? { lat: u.lat, lng: u.lng } : {}),
      })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS (including the three pre-existing users tests — key omission keeps their `deepEqual` exact).

- [ ] **Step 5: Commit**

```bash
git add src/users.js test/users.test.js
git commit -m "feat: player registry carries birth city + coordinates"
```

---

### Task 2: /globe and /api/globe routes

**Files:**
- Modify: `src/web.js` (after the `/api/standings` route, `src/web.js:104-115`)
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: `users.get()` users with optional `city`/`lat`/`lng` (Task 1).
- Produces: `GET /api/globe` → `{ layers: [{ id: 'birthplaces', label: 'Born in', points: [{ label, sublabel, lat, lng }] }] }` where `label` = player name, `sublabel` = city (may be undefined). `GET /globe` → serves `views/globe.html` (Task 3 creates it; sendFile of a missing file just 404s, so this task's page test asserts the route exists via a stub check — see Step 1).

- [ ] **Step 1: Write the failing tests** — append to `test/web.test.js`:

```js
test('/api/globe: only active players with coords, layers shape', async () => {
  try {
    users.save({ users: [
      { name: 'Ana',  ids: [], city: 'Porto', lat: 41.15, lng: -8.61 },
      { name: 'Gone', ids: [], city: 'Berlin', lat: 52.5, lng: 13.4, active: false },
      { name: 'Nocity', ids: [] },
    ] });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/globe`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.layers.length, 1);
      assert.strictEqual(body.layers[0].id, 'birthplaces');
      assert.deepStrictEqual(body.layers[0].points,
        [{ label: 'Ana', sublabel: 'Porto', lat: 41.15, lng: -8.61 }]);
    });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web.test.js`
Expected: FAIL — `/api/globe` returns 404.

- [ ] **Step 3: Minimal implementation** — in `src/web.js`, insert after the `/api/standings` route (before the `/admin/summary` comment block):

```js
  // ---- Globe easter egg (public — same exposure as the scoreboard: names + city only). ----
  app.get('/globe', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'globe.html'));
  });

  // Point layers for the globe page. One layer today; future point sets
  // (custom places, visited cities, …) are just more entries in `layers` —
  // the page renders whatever arrives.
  app.get('/api/globe', (_req, res) => {
    const points = users.get().users
      .filter((u) => u.active && Number.isFinite(u.lat))
      .map((u) => ({ label: u.name, sublabel: u.city, lat: u.lat, lng: u.lng }));
    res.json({ layers: [{ id: 'birthplaces', label: 'Born in', points }] });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web.js test/web.test.js
git commit -m "feat: public /globe page route and layered /api/globe endpoint"
```

---

### Task 3: the globe page

**Files:**
- Create: `views/globe.html`

**Interfaces:**
- Consumes: `GET /api/globe` layers shape (Task 2). Renders ALL layers generically — nothing player-specific in the page.

- [ ] **Step 1: Create `views/globe.html`** with exactly this content:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapTap · Globe</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #070b1c; --bg-2: #0a1030; --panel: rgba(16,22,52,.9); --border: rgba(130,155,255,.16);
    --text: #eaf0ff; --muted: #98a4d4; --cyan: #22d3ee;
    --body: "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; overflow: hidden; color: var(--text); font: 15px/1.5 var(--body);
    background: radial-gradient(1200px 800px at 50% -5%, var(--bg-2), var(--bg) 70%); }
  #globe { position: fixed; inset: 0; }
  .top { position: fixed; top: 0; left: 0; right: 0; padding: 14px 18px; display: flex; gap: 12px;
    align-items: baseline; z-index: 2; pointer-events: none; }
  .top a { color: var(--muted); text-decoration: none; font-family: var(--mono); font-size: .95rem; pointer-events: auto; }
  .top a:hover { color: var(--cyan); }
  .top h1 { font-family: var(--mono); font-size: 1rem; letter-spacing: .12em; text-transform: uppercase;
    color: var(--cyan); margin: 0; }
  #card { position: fixed; left: 18px; bottom: 18px; z-index: 2; background: var(--panel);
    border: 1px solid var(--border); border-radius: 14px; padding: 12px 16px; max-width: 280px; }
  #card .who { font-weight: 700; font-size: 1.05rem; }
  #card .where { font-family: var(--mono); font-size: .82rem; color: var(--muted); }
  #card:empty { display: none; }
</style>
</head>
<body>
<div class="top"><a href="/">← Scoreboard</a><h1>Where we're from</h1></div>
<div id="globe"></div>
<div id="card"></div>
<script src="https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js"></script>
<script>
const COUNTRIES = 'https://cdn.jsdelivr.net/gh/vasturiano/globe.gl@2.44.0/example/datasets/ne_110m_admin_0_countries.geojson';
const card = document.getElementById('card');
// ponytail: one palette entry per layer, extend when a second layer exists
const LAYER_COLORS = { birthplaces: '#22d3ee' };

const globe = Globe()(document.getElementById('globe'))
  .backgroundColor('rgba(0,0,0,0)')
  .showGlobe(true)
  .globeMaterial(new THREE.MeshPhongMaterial({ color: 0x0a1030, transparent: true, opacity: .95 }))
  .showAtmosphere(true)
  .atmosphereColor('#22d3ee')
  .atmosphereAltitude(0.18)
  .pointAltitude(0.02)
  .pointRadius(0.55)
  .pointColor((p) => LAYER_COLORS[p.layer] || '#ffd15c')
  .pointLabel((p) => `<b>${p.label}</b>${p.sublabel ? ' · ' + p.sublabel : ''}`)
  .onPointClick((p) => {
    card.innerHTML = `<div class="who">${p.label}</div><div class="where">${p.sublabel || ''}</div>`;
    globe.pointOfView({ lat: p.lat, lng: p.lng, altitude: 1.6 }, 800);
  });

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.55;

// Low-poly country look. Cosmetic — if the CDN fetch fails, the globe still works.
fetch(COUNTRIES).then((r) => r.json()).then((geo) => {
  globe.hexPolygonsData(geo.features)
    .hexPolygonResolution(3)
    .hexPolygonMargin(0.4)
    .hexPolygonColor(() => 'rgba(130,155,255,.30)');
}).catch(() => {});

fetch('/api/globe').then((r) => r.json()).then(({ layers }) => {
  const points = layers.flatMap((l) => l.points.map((p) => ({ ...p, layer: l.id })));
  globe.pointsData(points);
  if (!points.length) card.innerHTML = '<div class="who">Nobody here yet</div><div class="where">add birth cities on /users</div>';
}).catch(() => { card.innerHTML = '<div class="who">Could not load players</div>'; });

function fit() { globe.width(innerWidth).height(innerHeight); }
fit();
addEventListener('resize', fit);
</script>
</body>
</html>
```

Note: globe.gl's UMD bundle exposes both `Globe` and `THREE` globals — the `MeshPhongMaterial` line relies on that. If `THREE` turns out not to be global in this build, drop the `.globeMaterial(...)` line entirely (default material is fine) rather than adding a three.js script tag.

- [ ] **Step 2: Verify in the running app**

Run: `ADMIN_TOKEN=x node src/index.js` (or `npm start`) and open `http://localhost:3000/globe`.
Expected: dark page, spinning hex-country globe, drag/scroll works. With no cities saved yet: "Nobody here yet" card. Then add a city for yourself on `/users` (Task 4 — if doing tasks in order, temporarily hand-edit `data/users.json` to give one user `"city": "Porto, Portugal", "lat": 41.15, "lng": -8.61`), reload `/globe`, see the dot, hover it, click it → card + camera glide.

- [ ] **Step 3: Run the test suite (regression only)**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add views/globe.html
git commit -m "feat: /globe — spinning birth-city globe (globe.gl, hex-poly look)"
```

---

### Task 4: birth-city field on /users

**Files:**
- Modify: `views/users.html` (card template in `render()` at `views/users.html:91-101`, plus styles and one event handler)

**Interfaces:**
- Consumes: user objects may carry `city`/`lat`/`lng` (Task 1); the existing Save button already POSTs the whole `state.users` array, so no save-path change.
- Produces: user card UI writes `u.city`, `u.lat`, `u.lng` (or deletes all three).

- [ ] **Step 1: Add styles** — in the `<style>` block after the `.del` rules:

```css
  .cityrow { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .cityrow input { flex: 1; min-width: 0; background: rgba(10,14,34,.72); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font: .82rem var(--mono); padding: 6px 8px; }
  .cityrow input:focus { outline: none; border-color: rgba(34,211,238,.4); }
  .cityrow .geo { font-size: .78rem; flex: none; font-family: var(--mono); color: var(--muted); }
```

- [ ] **Step 2: Add the field to the card template** — in `render()`, after the closing `</div>` of `card-head` and before the `.zone` div, insert:

```js
      <div class="cityrow">
        <input class="city" data-city="${i}" placeholder="Birth city — e.g. Porto, Portugal" value="${esc(u.city || '')}">
        <span class="geo">${Number.isFinite(u.lat) ? '📍' : (u.city ? '⚠' : '')}</span>
      </div>
```

(⚠ = city text saved but not geocoded yet / not found.)

- [ ] **Step 3: Geocode on change** — after the existing `board.addEventListener('click', …)` block, add:

```js
board.addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-city]');
  if (!inp) return;
  const u = state.users[+inp.dataset.city];
  const city = inp.value.trim();
  delete u.city; delete u.lat; delete u.lng;
  if (city) {
    u.city = city;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`);
      const hit = (await r.json())[0];
      if (hit) { u.lat = +hit.lat; u.lng = +hit.lon; }
    } catch {} // offline/rate-limited: keep the city text, ⚠ shows, retype later to retry
  }
  dirty = true; render();
});
```

- [ ] **Step 4: Update the hint text** — extend the `p.hint` sentence: after "Click a name to rename." add "Type a birth city to put them on the secret globe."

- [ ] **Step 5: Verify in the running app**

Run: `ADMIN_TOKEN=x node src/index.js`, open `http://localhost:3000/users` (password `x`).
Expected: each card has a city input. Type "Porto, Portugal", tab out → 📍 appears, Save enables. Save, reload → city persists with 📍. Type gibberish ("xyzzyq") → ⚠. Clear the field → icon gone, coords removed after Save. Open `/globe` → the saved player's dot is there.

- [ ] **Step 6: Run the test suite (regression only)**

Run: `node --test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add views/users.html
git commit -m "feat: birth-city field with in-browser geocoding on /users"
```

---

### Task 5: the Easter egg door

**Files:**
- Modify: `views/scoreboard.html` (footer at `views/scoreboard.html:247-250`, one style rule)

- [ ] **Step 1: Add the link** — the footer becomes:

```html
  <footer>
    <span id="updated"></span>
    <a class="egg" href="/globe" aria-label="A little globe">🌍</a>
    <button onclick="load()">↻ Reload</button>
  </footer>
```

- [ ] **Step 2: Add the style** — next to the existing `footer` rule:

```css
  footer .egg { text-decoration: none; opacity: .35; transition: opacity .2s; }
  footer .egg:hover { opacity: 1; }
```

- [ ] **Step 3: Verify + regression**

Open `http://localhost:3000/` → faint 🌍 in the footer, brightens on hover, click → `/globe`.
Run: `node --test` — all PASS.

- [ ] **Step 4: Commit**

```bash
git add views/scoreboard.html
git commit -m "feat: scoreboard footer easter-egg link to /globe"
```

---

### Task 6: finish

- [ ] **Step 1: Full suite + manual smoke** — `node --test` all green; walk `/` → 🌍 → `/globe` → spin/zoom/click; `/users` → edit a city → Save → dot moves.
- [ ] **Step 2:** Use superpowers:finishing-a-development-branch (merge back to `main` from the worktree).
