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

1. **DB** — add columns to `players`: `birth_city TEXT`, `lat REAL`,
   `lng REAL` (nullable; players without a city just don't appear on the
   globe).
2. **Admin entry** — the existing `/users` page gets a "Birth city" text
   field per player. On save, if the city changed, the server geocodes it
   once via Nominatim (OpenStreetMap, free, no key) and stores lat/lng.
   Geocode failure → save the city anyway, leave coords null, report it in
   the save response so André can fix the spelling.
3. **API** — `GET /api/globe` (public, like `/api/standings`): players with
   coords, as `[{name, city, lat, lng}]`. No auth because the scoreboard
   already shows names publicly; city granularity only, never exact
   addresses.
4. **Page** — `views/globe.html`, served at `GET /globe` (public). globe.gl
   + three.js from CDN, hex-polygon country look, slow auto-rotate, dots
   from `/api/globe`, click → name card. Dark background to match the
   scoreboard.
5. **Door** — 🌍 link in `views/scoreboard.html` footer.

## Not doing (on purpose)

- No editable map / custom places / gameplay — future project.
- No WhatsApp bot flow for collecting cities — André types them in.
- No npm deps or build step — CDN script tags only.

## Testing

- `node --test` unit test for the geocode-on-save logic (mock the fetch).
- Manual: load `/globe`, spin, click a dot.
