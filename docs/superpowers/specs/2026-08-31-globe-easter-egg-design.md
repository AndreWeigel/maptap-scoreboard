# Globe Easter Egg — design

2026-08-31

## What

A hidden page at `/globe`: a spinning low-poly 3D globe (globe.gl via CDN)
with one glowing dot per player at their birth city. Drag to spin, scroll to
zoom, click a dot → small card with the player's name and city. A tiny 🌍 in
the scoreboard footer is the only way in.

## Why

Fun Easter egg — explore the world through where the group's players were
born. Also the first slice of a possible bigger "our own MapTap" idea later.

## How

1. **Data** — players live in `data/users.json` (not the DB), so each user
   entry gains optional `city`, `country`, `lat`, `lng`. `normalize()` in
   `src/users.js` carries them through; players without coords just don't
   appear on the globe. No DB change.
2. **Admin entry** — the existing `/users` page gets a "Birth city" field
   per player card. On change, the page queries Nominatim (OpenStreetMap,
   free, no key) for the top 5 matches and shows them as a pick-list;
   picking one stores that match's structured city name, country, and
   coordinates — typed text is never trusted as data. No match / offline →
   raw text kept as city, coords empty, a small ⚠ on the card.
3. **API** — `GET /api/globe` (public, like `/api/standings`). Extensible
   shape: `{ layers: [{ id, label, points: [{label, sublabel, lat, lng}] }] }`.
   Today one layer, `birthplaces`; future point sets (custom places, visited
   cities…) are just more layers — the page renders whatever it gets. No
   auth because the scoreboard already shows names publicly; city
   granularity only, never exact addresses.
4. **Page** — `views/globe.html`, served at `GET /globe` (public). MapLibre
   GL (pinned 6.6.0) globe projection with Esri satellite tiles. Players
   render as canvas-drawn map symbols: always-visible cards (name + city ·
   country) anchored to the surface; the engine handles collision (crowded
   ones auto-hide), horizon occlusion, and per-frame tracking. Same-city
   players merge into one card; below zoom 3.6 cards become name-only
   chips. Slow auto-rotate until first interaction; click → fly to the
   spot. Dark space styling to match the scoreboard.
5. **Door** — 🌍 link in `views/scoreboard.html` footer.

## Not doing (on purpose)

- No editable map / custom places / gameplay — future project.
- No WhatsApp bot flow for collecting cities — André types them in.
- No npm deps or build step — CDN script tags only.

## Testing

- `node --test`: normalize keeps/drops city+coords correctly; `/api/globe`
  returns only active players with coords, in the layers shape.
- Manual: load `/globe`, spin, click a dot.
