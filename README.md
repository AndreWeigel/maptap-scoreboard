# MapTap WhatsApp Scoreboard

Always-on bot that listens to one WhatsApp group, parses daily [maptap.gg](https://www.maptap.gg)
results, and serves a live scoreboard (wins, podiums, streaks, 🔥/😱 badges).
Single Node process: Baileys (WhatsApp linked device) + SQLite + Express + node-cron.

## Setup

```sh
npm install
npm test        # parser/scoring/ingest tests
npm start
```

On first run a QR code prints in the terminal — scan it from your phone:
**WhatsApp → Settings → Linked devices → Link a device.** Auth is persisted in
`data/auth/`, so this is a one-time step; restarts reconnect silently.

### Finding the group JID

Leave `GROUP_ID` empty in `config.js` and start the bot. Post anything in the target
group — the bot logs `group message seen — JID: 1234...@g.us`. Copy that JID into
`config.js` and restart.

## Config

Everything lives in [config.js](config.js): group JID, timezone, season start,
cron time, port, 🔥/😱 thresholds.

- **Seasons:** all queries filter `play_date >= SEASON_START`. To reset for a new
  season, change `SEASON_START` — no data is deleted.
- The API accepts `GET /api/standings?from=YYYY-MM-DD&to=YYYY-MM-DD` for any range.

## Scoreboard

- `GET /` — the scoreboard page (auto-refreshes every 5 min)
- `GET /api/standings` — leaderboard + badges JSON
- `GET /healthz` — `{ whatsappConnected, lastMessageAt }`

No auth — run it behind your existing reverse proxy.

## Scripts

```sh
node scripts/backfill.js export.txt   # ingest an exported WhatsApp chat (.txt)
node scripts/recompute.js             # rebuild daily_results cache from results
node scripts/score-day.js 2026-07-20  # (re)score one date
```

**Backfill note:** chat exports contain display names, not WhatsApp IDs, so backfilled
rows use the name as `player_id`. If the same player later posts live (JID id), merge once:

```sh
sqlite3 data/scores.db "UPDATE results SET player_id='4917...@s.whatsapp.net' WHERE player_id='Alice';"
node scripts/recompute.js
```

## Running in production

Use a process manager with auto-restart, e.g. pm2:

```sh
pm2 start src/index.js --name maptap && pm2 save
```

- **Backups:** `data/scores.db` is the entire history — copy it periodically.
- **Reconnects** are automatic; a re-scan is only needed if WhatsApp logs the device
  out (the bot logs this explicitly — then delete `data/auth/` and restart).
- Parse failures (format drift) land in the `parse_failures` table and the log —
  check it if someone's result doesn't show up.
