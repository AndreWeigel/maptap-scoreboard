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

Hey Fernando 👋 — here's the whole thing in plain words, no tech needed.

You already play [maptap.gg](https://www.maptap.gg) every day and paste your
result into the group. That's the entire job. A little bot lives in the chat and
quietly writes down every score it sees — no command, no tagging anyone. Post
like you always do and you're on the board.

See the standings here: **https://maptap.andreweigel.me**

- There are **two views**, flipped with the little spinning 🌍 switch at the top:
  **Leaderboard** (wins, averages, streaks, the all-time record) and
  **Daily winners** (who took each day).
- Your name shows as just **Fernando**, even though WhatsApp calls you "Fer" —
  the bot knows both are you, so all your games count as one player. If you ever
  switch phones you might briefly show up twice; just tell André and it gets
  stitched back together.
- **Messed up a score?** Post that day's result again — the newer one quietly
  replaces the old one. No harm done.
- The **🔥 badge** is for monster rounds, **😱** for the painful ones. "Most
  consistent 📅" goes to whoever plays the most days — and so far that's *you*,
  more days than anyone. Keep it up.

No app to install, no login, nothing to remember. Play, paste, glance at the
site. That's the game. 🌍
