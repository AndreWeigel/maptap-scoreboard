# Handover: finishing the quiz repo split

2026-10-27. For the agent picking this up as macOS user `andre` (the one whose
`gh` is logged in as **AndreWeigel** and whose `ssh root@46.224.233.5` works).
Everything in the repos is done and reviewed; what remains is server work, a
verification pass, and the scoreboard cutover. Read this whole file first.

Authority: `docs/superpowers/specs/2026-10-23-quiz-repo-split-design.md` (decisions)
and `docs/superpowers/plans/2026-10-23-quiz-repo-split.md` (Tasks 1–9). Tasks 1–5
and 8 are complete; 6 is half done; 7 is mid-way; 9 is untouched. The execution
ledger (what was ruled, what is deferred) is
`/Users/Shared/Project/maptap-scoreboard/.superpowers/sdd/2026-10-23-quiz-repo-split/progress.md`.

## The three places

| What | Where | State |
|---|---|---|
| New quiz repo | `/Users/Shared/Project/quiz` ↔ github.com/AndreWeigel/quiz | `main` = `origin/main` at `39ac779` ("deploy: host port 3002"). 60/60 tests. Nothing to push. |
| Scoreboard cleanup | `/Users/Shared/Project/maptap-scoreboard`, worktree `.claude/worktrees/quiz-split`, branch `quiz-split`, exactly one commit ("refactor: custom games moved to the quiz repo…") on top of main's head (this handover's commit) | Reviewed clean, 64/64 tests. **NOT merged, NOT deployed** — must wait until the quiz is verified live (cutover order is a spec decision). |
| Server | `root@46.224.233.5`, quiz cloned at `~/quiz` | Container built and started on `127.0.0.1:3002`; `game.db` + 3 photos migrated; `.env` written. nginx vhost file written but **not yet active**; **no TLS yet**. |

Files under `/Users/Shared/Project/quiz` and the `quiz-split` worktree were
created by the other macOS user (`job`) and chmod'ed `a+rwX`. If git complains
about "dubious ownership", run
`git config --global --add safe.directory <that path>` and carry on.

## What already happened on the server (so you don't redo it)

- `git clone https://github.com/AndreWeigel/quiz.git ~/quiz`, `.env` created
  with `ADMIN_TOKEN` and `TZ`. The password contains `$` characters, which
  Docker Compose interpolates; they were doubled to `$$` with
  `sed -i 's/\$/$$/g' .env`. **Check `grep ADMIN_TOKEN ~/quiz/.env` shows `$$`
  and not `$$$$`** (a second run of that sed would double them again). The
  password the browser wants is the original one with single `$`.
- Data: `sqlite backup` of the scoreboard's live `game.db` → `~/quiz/data/game.db`;
  `scripts/import-photos.js` reported `3 referenced, 3 copied, 0 missing`.
- First `docker compose up` failed: **3001 is Uptime Kuma**. The repo was changed
  to host port **3002** (commit `39ac779`), pulled on the server, and
  `docker compose up -d --build` then printed `Container quiz Started`. The
  immediate `curl localhost:3002/healthz` got "connection reset" (ran before
  node was listening); it was never re-checked.
- nginx: there is **no `~/personal-cloud` checkout on the server**, so the
  vhost was written directly to `/etc/nginx/sites-available/quiz.conf` with a
  placeholder `proxy_pass http://127.0.0.1:PORT;` and a symlink in
  `sites-enabled`. The line `sed -i 's/127.0.0.1:PORT/127.0.0.1:3002/' …` and
  `nginx -t && systemctl reload nginx` were given to André but their output was
  never seen. From outside, `http://quiz.andreweigel.me/healthz` returns
  **nginx's default 404 page**, which means the vhost is not active yet (if
  `PORT` is still in the file, `nginx -t` fails and the reload never happens).
- DNS: `dig +short quiz.andreweigel.me A` → `46.224.233.5`. Done.
- certbot: not run. `https://` does not connect.

## Step A — bring the quiz up on its domain (server)

```bash
ssh root@46.224.233.5
curl localhost:3002/healthz                                   # expect {"ok":true}
docker compose -f ~/quiz/docker-compose.yml logs --tail=5 quiz # expect "[quiz] listening on http://localhost:3000"
grep proxy_pass /etc/nginx/sites-available/quiz.conf           # must say 127.0.0.1:3002 — if it says PORT:
sed -i 's/127.0.0.1:PORT/127.0.0.1:3002/' /etc/nginx/sites-available/quiz.conf
ls -l /etc/nginx/sites-enabled/quiz.conf                       # symlink → sites-available/quiz.conf
nginx -t && systemctl reload nginx
curl -H 'Host: quiz.andreweigel.me' http://127.0.0.1/healthz   # expect {"ok":true} through nginx
certbot --nginx -d quiz.andreweigel.me --agree-tos --no-eff-email --redirect   # = personal-cloud's scripts/ssl-setup.sh
curl -sI https://quiz.andreweigel.me/healthz | head -1          # expect HTTP/2 200
```

If the container is crash-looping, the logs will say why; the likely culprits
are a mangled `ADMIN_TOKEN` (see `$$` note) or `data/game.db` permissions
(`ls -l ~/quiz/data`; the container runs as root, so it should be fine).

The vhost content, if it needs rewriting (port 3002 is the only change from
`personal-cloud/nginx/maptap.conf`):

```nginx
server {
    listen 80;
    server_name quiz.andreweigel.me;
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

The live-session event stream needs no nginx tweak (app sends
`X-Accel-Buffering: no` and pings every 25 s).

## Step B — verify end to end (spec §6)

In a browser:
1. `https://quiz.andreweigel.me/admin` (any username, the password) lists the
   games; a round card shows its photo (`/uploads/<16hex>.jpg`, public).
2. Open a game's share link (`/<slug>`) in a private window, play a round, see
   the reveal with its photo.
3. In the builder press **Go live** → host page `/host/<code>` → open the join
   link `/live/<code>` in a private window → Start round → tap → Reveal →
   both screens show the pins → Show final scoreboard.
If anything fails, fix it in `/Users/Shared/Project/quiz`, commit (plain
subject, **no Co-Authored-By trailer** — André's rule), push, and on the server
`cd ~/quiz && git pull --ff-only && docker compose up -d --build`.

## Step C — the scoreboard cutover (only after B passes)

The branch removes `src/game/`, `views/game/`, the game tests and design docs
from the scoreboard and adds
`app.get(['/game', '/game/*'], …)` → 301 to `https://quiz.andreweigel.me` with
the `/game` prefix stripped (query kept). Test in `test/web.test.js`.

```bash
cd /Users/Shared/Project/maptap-scoreboard
git status --short                       # must be clean on main
git merge --ff-only quiz-split           # quiz-split is one commit ahead of main; if ff fails, someone moved main — rebase quiz-split onto it first
node --test test/                        # needs node_modules: see "Node 26" below
git push                                 # main has ~30 unpushed commits (live sessions, shape targets, split docs) — this is the first push of all of them
git worktree remove .claude/worktrees/quiz-split && git branch -d quiz-split
```

Then on the server:

```bash
cd ~/maptap-scoreboard && git pull --ff-only && docker compose up -d --build
curl -sI https://maptap.andreweigel.me/game/anything | grep -i location   # → https://quiz.andreweigel.me/anything
```

The scoreboard's `.github/workflows/deploy.yml` exists but its `DEPLOY_*`
secrets were never set, so pushing does not deploy; the manual pull above is
the deploy. Same for the quiz repo (workflow copied, inert).

## Step D — leftovers

- **personal-cloud**: `nginx/quiz.conf` should live there as documentation
  (`nginx/maptap.conf` pattern). If André ran the block that pushed it, it says
  3001 — change to 3002 and push. If not, add it (content above). It is not
  used by the server directly (no checkout there).
- **Memory for future sessions** (project memory dir
  `/Users/job/.claude/projects/-Users-Shared-Project-maptap-scoreboard/memory/`
  belongs to the `job` user; write the equivalent in your own memory): quiz
  lives at `/Users/Shared/Project/quiz` ↔ `AndreWeigel/quiz`, deployed at
  `~/quiz` on the server, host port **3002**, nginx conf written directly in
  `/etc/nginx/sites-available/quiz.conf`; the scoreboard no longer contains
  the game module; `/game/*` redirects.
- Delete the ledger workspace when everything is merged:
  `rm -rf /Users/Shared/Project/maptap-scoreboard/.superpowers/sdd/2026-10-23-quiz-repo-split`
  (git-ignored scratch).

## Follow-ups André should decide (not part of this cutover)

- Both Dockerfiles use `node:20-bookworm-slim`; Node 20 is EOL since
  2026-04-30. `node:22-bookworm-slim` builds better-sqlite3 11 fine. One-line
  change per repo; record it in the specs' decision tables.
- Deferred minors from the reviews are listed in the ledger (`Task N: minor
  (deferred)` lines): all triaged "can wait". Two cheap ones in the scoreboard
  branch: `docs/superpowers/specs/2026-08-31-people-stories.md:3` and
  `.gitignore:26` still mention the deleted `docs/HANDOVER-globe-game.md`.
- Git identity on this Mac is unset for the `job` user, so its commits are
  authored `job <job@Mac.fritz.box>`. Rewrite only if André cares.

## Environment gotchas

- **Node 26 only on this Mac.** `npm install` fails to build better-sqlite3 11.
  Recipe in any fresh checkout/worktree:
  `npm install --ignore-scripts && npm install --no-save better-sqlite3@13`.
  Never commit a package.json/lock change from that. Production is Node 20 in
  Docker where 11 builds.
- Headless Chrome screenshot method for UI checks: `docs/HANDOVER-globe.md`
  in the quiz repo ("lesson 3"); never pass `--disable-gpu`.
- Commit messages: plain subject, no attribution trailers (André rejected one).
- Stage explicit paths; never `git add -A`/`.`/`-u`.
