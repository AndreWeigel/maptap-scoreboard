# MapTap WhatsApp Scoreboard

An always-on bot that watches one WhatsApp group, parses the daily
[maptap.gg](https://www.maptap.gg) results people post, and serves a live
scoreboard: wins, podiums, streaks, and the odd 🔥/😱 badge.

It's one Node process the whole way down — Baileys for WhatsApp (as a linked
device), SQLite for storage, Express for the web bit, node-cron for the daily
scoring.

## Setup

```sh
npm install
npm test        # parser/scoring/ingest tests
npm start
```

First run prints a QR code in the terminal. Scan it from your phone under
WhatsApp → Settings → Linked devices → Link a device. The session is saved to
`data/auth/`, so you only do this once; restarts reconnect on their own.

### Finding the group JID

Leave `GROUP_ID` empty in `config.js` and start the bot. Post anything in the
group you want to track — the bot logs `group message seen — JID: 1234...@g.us`.
Copy that JID into `config.js` and restart.

## Config

Everything lives in [config.js](config.js): group JID, timezone, season start,
cron time, port, and the 🔥/😱 thresholds. A few are env-overridable for Docker
(see [.env.example](.env.example)) — notably `ADMIN_TOKEN` (the admin password)
and `DAILY_SUMMARY` / `WEEKLY_SUMMARY` (the digests' starting state, then
toggled live at `/summary`).

Seasons are just a date filter — every query uses `play_date >= SEASON_START`.
To start a new season, bump `SEASON_START`; nothing gets deleted. If you want an
arbitrary range, the API takes one:
`GET /api/standings?from=YYYY-MM-DD&to=YYYY-MM-DD`.

## How the bot reads messages

The bot only records messages from the configured group. A message counts as a
result when it has a `Final score: N` line, with the five round scores on the
last line of numbers before it. Emojis, reactions, and shouts are ignored, so a
normal post just works:

```
www.maptap.gg July 20
88🎉 96🔥 97🔥 97😱 7😱
Final score: 690
```

- **Which day it counts for** — the header date (`July 20`) wins, not the clock,
  so a score posted at 00:10 still lands on the right day. Month names resolve in
  English and German; an unknown word falls back to the server date.
- **Who posted it** — live posts are keyed by WhatsApp ID, so a display-name
  change never splits someone's history. [`src/users.js`](src/users.js) maps each
  person's IDs to one canonical name; a new phone shows up as
  "(user not registered yet)" until it's added there.
- **Fixing a score** — post again for the same day and the new result replaces
  the old one (`UNIQUE(play_date, player_id)`; logged as "replaced").
- **When nothing shows up** — malformed results land in the `parse_failures`
  table and the log. First place to look.

## Endpoints

Public:

- `GET /` — the scoreboard page (Leaderboard ⟷ Daily winners toggle), auto-refreshes every 5 min
- `GET /api/standings` — leaderboard, badges, and per-day `history` as JSON
- `GET /healthz` — `{ whatsappConnected, lastMessageAt }`

Admin — HTTP Basic Auth, any username, password is `ADMIN_TOKEN` (unset ⇒ locked):

- `GET /summary` — toggle the daily/weekly digests and post one on demand
- `GET` / `POST /api/settings` — read/write those toggles (persisted to `data/settings.json`)
- `GET /admin/summary?kind=daily|weekly[&send=1]` — preview, or post a digest now

The public pages carry no auth of their own — keep the site behind your own
TLS/reverse proxy (Basic Auth assumes HTTPS in transit).

## Scripts

```sh
node scripts/backfill.js export.txt        # ingest an exported WhatsApp chat (.txt)
node scripts/delete-player.js "Alice"      # remove a player by display name
```

Standings are always computed from the `results` table directly, so there's no
cache to rebuild after edits.

One gotcha with backfills: chat exports have display names, not WhatsApp IDs, so
those rows use the name as `player_id`. When that same person later posts live
(under a real JID), add both ids under one entry in [`src/users.js`](src/users.js);
the scoreboard collapses them to one canonical name at read time.

## Running in production (Docker)

Runs on the personal-cloud server, with nginx proxying
`maptap.andreweigel.me` → `127.0.0.1:3000` (that config lives in the
`personal-cloud` repo as `nginx/maptap.conf`).

```sh
git clone https://github.com/AndreWeigel/maptap-scoreboard.git ~/maptap-scoreboard
cd ~/maptap-scoreboard
cp .env.example .env          # leave GROUP_ID empty for the first run
docker compose up -d --build
docker compose logs -f        # the QR prints here — scan it, then grab the group JID
```

The QR shows up in the container log, so `docker compose logs -f` is where you
scan it. Once you've got the group JID, drop it in `.env` and run
`docker compose up -d` again.

To update: `git pull && docker compose up -d --build`.

A few things worth knowing:

- **Backups.** `data/` (the mounted volume) holds both the DB and the WhatsApp
  session. `data/scores.db` is your entire history — copy it somewhere safe now
  and then.
- **Reconnects** happen on their own. You only need to re-scan if WhatsApp
  actually logs the device out, and the bot says so in the log when that
  happens — delete `data/auth/` and restart.
- **Missing results?** Parse failures (usually format drift) land in the
  `parse_failures` table and the log. That's the first place to look.

## Read this, Fernando

Hey Fernando — you'll want the actual architecture, so here it is end to end.

**Stack.** One Node process. [Baileys](https://github.com/WhiskeySockets/Baileys)
holds a WhatsApp Web session as a *linked device* (not the Business API — it's
the same protocol your phone's "Linked devices" uses), `better-sqlite3` for
storage, Express for HTTP, `node-cron` for the scheduled digests. It runs in
Docker behind nginx (TLS + reverse proxy) on André's box.

**Ingest path.** Baileys emits a `messages.upsert` event per incoming message
([whatsapp.js](src/whatsapp.js)). The handler filters to the one configured group
JID, pulls `player_id = key.participant` (your stable WhatsApp id — a
`…@lid`, *not* your display name) and `player_name = pushName`, then hands the
text to the parser. `fromMe` posts count; undecryptable messages (no `.message`
payload) are logged and skipped so they don't vanish silently.

**Parsing** ([parser.js](src/parser.js)) is anchor-based, not a rigid template.
It regexes `Final score:\s*(\d+)`, then walks *backwards* from that line to the
first line containing exactly five integers — those are your rounds. Everything
else (emoji, reactions, trailing shouts) is noise by construction, so the format
is robust to the junk people append. The play-date comes from the
`maptap.gg <Month> <Day>` header, not the wall clock — the header wins so a
00:10 post belongs to the correct day. Month words are normalized (lowercased,
diacritics stripped via NFD) and matched against an EN+DE table; a future-dated
header rolls back a year; an unknown month falls back to the server date.

**Storage.** Immutable append-ish `results` table with
`UNIQUE(play_date, player_id)` — a re-post for the same day does an
`ON CONFLICT … DO UPDATE`, so correcting a score is just posting again. Failed
parses go to `parse_failures`. There is **no** precomputed standings table:
everything is derived on read.

**Identity.** This is the interesting bit. Backfilled history (imported chat
exports) keyed players by *display name*; live messages key by `…@lid`. So one
human can arrive under several ids. [`src/users.js`](src/users.js) is a hardcoded
registry mapping each person's ids → one canonical name, applied at read time via
`resolveRows()` — raw rows are never mutated. That's why you're **"Fernando"**
and not "Fer": your `…@lid` and your old export name both resolve to the same
entry. An id not in the registry renders as `Name (user not registered yet)`
until it's added. (You were one of these until you first posted live.)

**Standings** ([scoring.js](src/scoring.js)) are pure functions over the rows:
`rankDay` does competition ranking (ties share rank, next rank skips),
`computeStandings` aggregates wins/podiums/averages/streaks/records, and
`dailyHistory` yields per-day rankings. `GET /api/standings` returns all of it as
JSON; the front-end ([scoreboard.html](views/scoreboard.html)) is a single page
that toggles Leaderboard ⟷ Daily winners and repolls every 5 min.

**Digests.** Two cron jobs (nightly, Monday) are always scheduled but gated on a
runtime flag in `data/settings.json`, toggled from `/summary` (HTTP Basic Auth).
That page also has "Send now" buttons hitting `/admin/summary?send=1`.

**TL;DR for you:** paste your maptap result in the group like normal; the parser
grabs the five rounds + final, dedupes by day, and your `…@lid` folds into the
"Fernando" identity. Standings recompute from raw rows on every page load — no
caches to bust. Board's at **https://maptap.andreweigel.me**. And yes, "Most
consistent 📅" is currently you: more play-days than anyone.
