# MapTap WhatsApp Scoreboard

A bot that watches one WhatsApp group, parses the daily
[maptap.gg](https://www.maptap.gg) scores people post, and serves a scoreboard:
wins, podiums, streaks, and 🔥/😱 badges.

Node, with Baileys for WhatsApp (a linked device), SQLite for storage, Express
for the web server, node-cron for the digests.

## Setup

```sh
npm install
npm test
npm start
```

First run prints a QR code. Scan it from your phone: WhatsApp → Settings →
Linked devices → Link a device. The session is saved to `data/auth/`, so you
only do this once; restarts reconnect by themselves.

### Finding the group JID

Leave `GROUP_ID` empty in `config.js` and start the bot. Post anything in the
group you want to track. The bot logs `group message seen — JID: 1234...@g.us`.
Put that JID in `config.js` and restart.

## Config

Settings live in [config.js](config.js): group JID, timezone, season start, cron
times, port, and the 🔥/😱 thresholds. Some can be set via env for Docker (see
[.env.example](.env.example)): `ADMIN_TOKEN` (the admin password) and
`DAILY_SUMMARY` / `WEEKLY_SUMMARY` (the digests' starting state, which you then
toggle at `/summary`).

Seasons are a date filter. Every query uses `play_date >= SEASON_START`. Bump
`SEASON_START` to start a new one; nothing is deleted. For an arbitrary range the
API takes `from`/`to`: `GET /api/standings?from=YYYY-MM-DD&to=YYYY-MM-DD`.

## How the bot reads messages

It records messages from the configured group only. A message is a result if it
has a `Final score: N` line, with the five round scores on the last line of
numbers before it. Emoji, reactions, and shouts are ignored, so a normal post
works:

```
www.maptap.gg July 20
88🎉 96🔥 97🔥 97😱 7😱
Final score: 690
```

Day: taken from the header date (`July 20`), not the clock, so a score posted at
00:10 still counts for the right day. Months resolve in English and German; an
unknown word falls back to the server date.

Player: keyed by WhatsApp ID, so renaming yourself doesn't split your history.
the registry maps each person's IDs to one name. A new phone shows as
`Name (user not registered yet)` until you claim it on the `/users` admin page
(drag its id onto the player). The registry lives in `data/users.json`, seeded
from the `SEED` list in [`src/users.js`](src/users.js).

Corrections: post again for the same day and the new result replaces the old one
(`UNIQUE(play_date, player_id)`).

Nothing showing up: malformed results go to the `parse_failures` table and the
log.

## Endpoints

Public:

- `GET /` — scoreboard page (Leaderboard / Daily winners toggle), refreshes every 5 min
- `GET /api/standings` — leaderboard, badges, and per-day `history` as JSON
- `GET /healthz` — `{ whatsappConnected, lastMessageAt }`

Admin (HTTP Basic Auth, any username, password is `ADMIN_TOKEN`; unset means locked):

- `GET /summary` — toggle the digests, or send one now
- `GET /users` — manage the player registry: drag ids onto players, create players, switch them on/off
- `GET` / `POST /api/settings` — read/write the digest toggles (`data/settings.json`)
- `GET` / `POST /api/users` — read/write the registry (`data/users.json`)
- `GET /admin/summary?kind=daily|weekly[&send=1]` — preview or post a digest

The public pages have no auth. Keep the site behind your own TLS/proxy; Basic
Auth assumes HTTPS.

## Scripts

```sh
node scripts/backfill.js export.txt        # ingest an exported WhatsApp chat (.txt)
node scripts/delete-player.js "Alice"      # remove a player by display name
```

Standings are computed from `results` on read, so there's no cache to rebuild
after edits.

Backfill note: chat exports have display names, not WhatsApp IDs, so those rows
use the name as `player_id`. When that person later posts live, open `/users`
and drag both ids onto one player.

## Running in production (Docker)

Runs on the personal-cloud server; nginx proxies `maptap.andreweigel.me` →
`127.0.0.1:3000` (config in the `personal-cloud` repo, `nginx/maptap.conf`).

```sh
git clone https://github.com/AndreWeigel/maptap-scoreboard.git ~/maptap-scoreboard
cd ~/maptap-scoreboard
cp .env.example .env          # leave GROUP_ID empty for the first run
docker compose up -d --build
docker compose logs -f        # QR prints here; scan it, then grab the group JID
```

Put the group JID in `.env` and run `docker compose up -d` again. To update:
`git pull && docker compose up -d --build`.

Notes:

- `data/` holds the DB and the WhatsApp session. `data/scores.db` is the whole
  history, so back it up.
- Reconnects are automatic. Re-scan only if WhatsApp logs the device out (the
  log says so): delete `data/auth/` and restart.
- Missing results usually mean format drift. Check `parse_failures` and the log.

## Read this, Fernando

The architecture, end to end.

Stack: one Node process. [Baileys](https://github.com/WhiskeySockets/Baileys)
runs a WhatsApp Web session as a linked device (the same thing as your phone's
"Linked devices", not the Business API). better-sqlite3 for storage, Express for
HTTP, node-cron for the digests. Docker behind nginx on André's server.

Ingest: Baileys fires a `messages.upsert` event per message
([whatsapp.js](src/whatsapp.js)). The handler keeps only the configured group,
reads `player_id = key.participant` (your `…@lid`, not your display name) and
`player_name = pushName`, and passes the text to the parser. Your own posts
count. Messages that fail to decrypt are logged and skipped instead of
disappearing.

Parsing ([parser.js](src/parser.js)): no rigid template. It matches
`Final score:\s*(\d+)`, then scans backwards to the first line with exactly five
integers (your rounds). Everything else is ignored, so appended emoji or text
won't break it. The date comes from the `maptap.gg <Month> <Day>` header rather
than the clock, so a post at 00:10 lands on the right day. Month words are
lowercased and stripped of diacritics, then matched against an English+German
table; a future date rolls back a year; an unknown month falls back to the
server date.

Storage: a `results` table with `UNIQUE(play_date, player_id)`. Re-posting the
same day does `ON CONFLICT DO UPDATE`, so fixing a score is just posting again.
Failed parses go to `parse_failures`. There's no standings table; it's all
derived on read.

Identity: backfilled history keyed players by display name, live messages key by
`…@lid`, so one person can show up under several IDs.
[`src/users.js`](src/users.js) maps each person's IDs to one name, applied on
read via `resolveRows()`; the raw rows aren't touched. That's why you're
"Fernando" and not "Fer": your `…@lid` and your old export name resolve to the
same entry. An unknown ID shows as `Name (user not registered yet)` until it's
added, which is what you were until your first live post.

Standings ([scoring.js](src/scoring.js)): pure functions over the rows. `rankDay`
handles ties (shared rank, next rank skips), `computeStandings` does
wins/podiums/averages/streaks/records, `dailyHistory` does per-day rankings.
`GET /api/standings` returns the lot; the page
([scoreboard.html](views/scoreboard.html)) toggles Leaderboard / Daily winners
and repolls every 5 min.

Digests: two cron jobs (nightly, Monday), always scheduled but gated on a flag in
`data/settings.json` that you toggle at `/summary` (Basic Auth). The same page
has Send-now buttons for `/admin/summary?send=1`.

Short version: post your result as usual. The parser takes the five rounds and
final, dedupes by day, and your `…@lid` folds into "Fernando". Standings rebuild
from raw rows on every load. Board's at https://maptap.andreweigel.me. And Most
consistent 📅 is you right now, the most play-days of anyone.
