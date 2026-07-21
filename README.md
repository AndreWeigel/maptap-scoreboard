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
cron time, port, and the 🔥/😱 thresholds.

Seasons are just a date filter — every query uses `play_date >= SEASON_START`.
To start a new season, bump `SEASON_START`; nothing gets deleted. If you want an
arbitrary range, the API takes one:
`GET /api/standings?from=YYYY-MM-DD&to=YYYY-MM-DD`.

## Endpoints

- `GET /` — the scoreboard page, auto-refreshes every 5 min
- `GET /api/standings` — leaderboard + badges as JSON
- `GET /healthz` — `{ whatsappConnected, lastMessageAt }`

There's no auth. Put it behind whatever reverse proxy you already run.

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
