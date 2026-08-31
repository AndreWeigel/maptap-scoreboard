# Spec: People stories on the globe (slice 1 of the game project)

2026-08-31. Feature A from `docs/HANDOVER-globe-game.md`. Decisions there are
final; this spec only pins down slice-1 mechanics.

## What it does

Click a player's card on `/globe` → a panel shows that person's photo(s) with
captions and a short story. Photos + story are entered on the existing
`/users` admin page, uploaded from the phone, stored on the server.

## Data model

`data/users.json` entries gain two optional fields (whitelisted in
`src/users.js normalize()`, like city/country/lat/lng):

- `story`: trimmed non-empty string, else omitted.
- `photos`: array of `{ file, caption? }`. `file` must match
  `^[a-f0-9]{16}\.(jpg|png|webp|gif)$` (exactly what the upload endpoint
  generates — anything else is dropped). `caption` kept only as trimmed
  non-empty string.

## Server (all in `src/web.js` — feature A belongs to the host app)

- `POST /api/upload` (Basic Auth): raw image body via
  `express.raw({ type: 'image/*', limit: '8mb' })`. Content-type must be
  image/jpeg|png|webp|gif → else 400. Saved to `data/uploads/` as
  `<crypto.randomBytes(8) hex>.<ext>` — client filename never used.
  Response: `{ "file": "a1b2c3d4e5f60718.jpg" }`.
- `GET /uploads/*` (public): `express.static` over `data/uploads/`,
  `maxAge 365d, immutable` (random names never change content).
- `GET /api/globe`: points additionally carry `story` and `photos` when the
  user has them. Shape of `{ layers: [...] }` unchanged.
- `basicAuth` exported from `src/web.js` (handover directive, slice 2 needs it).

## Admin UI (`views/users.html`)

Per player card, under the city row:
- Story textarea (edits `u.story`).
- Photo strip: thumbnail + caption input + ✕ per photo, and an "+ photo"
  file input (`accept="image/*"`). Choosing a file POSTs it to `/api/upload`
  immediately (content-type = file type), then pushes `{ file }` into
  `u.photos` locally. Everything else persists via the existing Save button →
  `POST /api/users`. An upload abandoned before Save leaves an orphan file in
  `data/uploads/` — accepted, not worth a GC.

## Globe UI (`views/globe.html`)

- Card click: existing flyTo stays, plus a panel opens (right side desktop,
  bottom sheet on small screens; ✕ to close).
- Panel lists each person merged into that card: name + city/country, story
  text, photos with captions under them. People with no story/photos just
  show name + place.
- All user text escaped; photos `src="/uploads/<file>"`.

## Security boundaries

Upload behind Basic Auth; type whitelist + 8MB cap at the endpoint; random
server-side filenames; `normalize()` re-validates filenames so a hand-edited
users.json can't point outside `/uploads`; all strings HTML-escaped in both
pages.

## Out of scope (later slices / never)

Image resizing (phone jpegs served as-is), HEIC (iOS converts on upload),
upload GC, game builder (slices 2–4).

## Verification

- `node --test test/` for normalize, upload endpoint, /api/globe.
- Headless-Chrome screenshots of both pages via a scratchpad stub server
  (handover lesson 3: real-time `/slow` image delay, no virtual-time budget).
