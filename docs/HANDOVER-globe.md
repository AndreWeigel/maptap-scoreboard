# Handover: the globe stack (people album)

Custom games moved to the `quiz` repo on 2026-10-23 — see its `docs/HANDOVER-globe.md`.

2026-09-07. This is the "what we actually use and why" reference for anything
that renders a globe.

## One line

**MapLibre GL 6.6.0, loaded from jsdelivr as ESM, no build step, not an npm
dependency** — with `projection: { type: 'globe' }`, Esri World Imagery raster
tiles, and a hand-written sky/atmosphere block.

## Where the globe appears

| Page | File | Route | Projection | MapLibre load |
|---|---|---|---|---|
| People album | `views/globe.html` | `GET /globe` (friends password, [web.js:231](src/web.js#L231)) | globe | static namespace import |

## The shared recipe

Copy this if you ever add another globe.

```js
import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.6.0/dist/maplibre-gl.mjs';

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false, // a hand-written .credit line carries the Esri notice
  minZoom: 1, maxZoom: 17, center: [10, 35], zoom: 1.8,
  style: {
    version: 8,
    projection: { type: 'globe' },
    sources: { sat: { type: 'raster', tileSize: 256, maxzoom: 17,
      attribution: 'Imagery © Esri & contributors',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] } },
    layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    sky: { 'sky-color': '#02040f', 'horizon-color': '#0e5d7a', 'fog-color': '#070b1c',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 1, 8, 0.1] } },
});
window.map = map; // console/debug handle — the screenshot driver steers the camera with it
```

CSS comes from the same CDN path
(`.../maplibre-gl@6.6.0/dist/maplibre-gl.css`). Tiles need no API key; keep
the "Imagery © Esri & contributors" credit visible.

## Geocoding: Nominatim, no key

- **Search** — `views/users.html:243`:
  `search?format=jsonv2&addressdetails=1&accept-language=en&limit=5&q=…`,
  user picks from a top-5 list, structured `city/country/lat/lng` stored.
- City field is always
  `a.city || a.town || a.village || a.hamlet || a.municipality || a.county || h.name`.
- Rate-limited and keyless — every call is wrapped in `try {} catch {}` and
  failure just leaves the ⚠ marker. Never make it a hard dependency.

## `/globe` — the people album

Data: `GET /api/globe` ([web.js:238](src/web.js#L238)), behind the same friends password →
`{ layers: [{ id, label, points: [{ label, city, country, lat, lng, story, photos }] }] }`.
The `layers` array is deliberately extensible (more layers could be added one
day) — **don't break the shape**. Points come from
`data/users.json` via `src/users.js`, filtered to `active` users with a finite
`lat`.

The interesting parts, all in [globe.html](views/globe.html):

- **Two rendering systems on purpose.** The exact birthplace is a MapLibre
  `circle` layer (`dots`) — a real map layer, so the horizon occludes it for
  free. The name card is a DOM `Marker` — which is **not** occluded, hence the
  manual limb check.
- **`LIMB = 78`** ([globe.html:145](views/globe.html#L145)): a card whose point
  is more than 78° from the view centre is on the far side of the sphere and
  gets hidden. Skipped entirely above zoom 5.5, where the horizon can't hide
  anyone.
- **`MINI = 4`**: below zoom 4 cards shrink to name-only chips.
- **Declutter** ([`layout()`, globe.html:158](views/globe.html#L158)): every
  card starts above its dot, then up to 30 iterations of screen-space
  push-apart on whichever axis overlaps least. The final position is applied
  with `marker.setOffset()` and an SVG leader line is drawn back to the true
  dot. Runs on every `move` and `resize` — keep it cheap.
- **Same-coordinate merge**: players sharing a lat/lng become one card
  ("Ana & Ben") with both stories in the panel.
- **Auto-spin** until the first `mousedown`/`touchstart`/`wheel`; off under
  `prefers-reduced-motion`; stops itself above zoom 4.
- **Story panel** is built with `createElement`/`textContent` only — the text
  is user-entered. Never `innerHTML` there.

## Photos

`POST /api/upload` (Basic Auth, raw `image/*`, 8 MB cap) writes a random
16-hex filename; `/uploads` is static with `maxAge: 365d, immutable`, behind
`friendsAuth` (`FRIENDS_TOKEN` or the admin password; unset = admin-only).

## Gotchas — do not rediscover these

1. **MapLibre 6.6.0 is ESM-only with no default export.** `import * as
   maplibregl from …mjs`. A default import silently gives you `undefined`.
2. **Never load three.js-family libs via jsdelivr `/+esm`.** The bundle graph
   pulled three separate three.js copies and the globe rendered black. If ever
   needed: esm.sh with `?deps=three@<ver>`. Nothing here uses three today.
3. **DOM markers are not occluded by the sphere.** That's the entire reason
   `degFromCenter`/`LIMB` exists. If you add a new marker type, it needs the
   same treatment — or make it a map layer instead.
4. **Screenshot verification**: `--virtual-time-budget` is unreliable for
   tile-loading pages (nondeterministic half-loaded frames). The working trick
   is a stub server route `/slow?ms=25000` (a 1×1 gif delayed N ms) embedded in
   a driver page, so headless Chrome's shutter waits in *real* time. The driver
   iframes the target and steers it via `window.map` / `window.playState`.
5. **Node version.** Production is `node:20-bookworm-slim` (Dockerfile). This
   machine currently runs Node 26.3.0, and **better-sqlite3 11.x will not build
   against it** — no prebuild for the v147 ABI, and the source fails on removed
   V8 APIs (`GetPrototype`, `Context::GetIsolate`, `PropertyCallbackInfo::This`).
   Use nvm to drop to Node 20/22 for local work, or bump better-sqlite3.
   Right now `node_modules/better-sqlite3` on this machine is unbuilt — any
   test touching a DB fails until that's resolved.
6. **`node --test test/` no longer works on Node ≥26** (the directory arg is
   treated as a module path). Use `node --test test/*.test.js`.

## State of play

The people album on `/globe` is shipped, plus two UI/accessibility polish
passes (`8d28518`, `f4f9a6d`). Specs and plans are in `docs/superpowers/`.

Deploy: pushing to `main` runs `.github/workflows/deploy.yml`, which SSHes in and
runs `cd /root/maptap-scoreboard && git pull --ff-only && docker compose up -d --build`.
Keep that checkout clean: a hand edit to a tracked file aborts the pull, which
blocked every deploy from 7 to 15 Sep. Manual fallback is the same command over
`ssh root@46.224.233.5`, then `curl localhost:3000/healthz`.
