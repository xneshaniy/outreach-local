# Deploying to Hostinger

This guide is the exact, click-by-click path for putting the Email Outreach
Platform on Hostinger shared hosting.

It covers **Route A** — connecting the GitHub repository directly from hPanel,
which is the recommended path — and **Route B** — building over SSH.

> **The one thing to know up front:** this application requires
> **PostgreSQL**. Hostinger's shared hosting only offers MySQL, and the
> schema uses PostgreSQL enums, partial unique indexes, `gen_random_uuid()`
> and `FOR UPDATE SKIP LOCKED`. **Keep using Neon** (or any managed
> PostgreSQL) and point `DATABASE_URL` at it. Do not try to switch the app to
> MySQL.

---

## 0. What you need

| Thing | Requirement |
| --- | --- |
| Hostinger plan | Any plan with **"Setup Node.js App"** (Business, Cloud, or Premium) |
| Node.js | **22.x** (20.9+ also works) |
| Database | A **PostgreSQL** database — Neon is already configured |
| SSH access | hPanel → **Advanced → SSH Access** (needed for the migrations) |

---

# ROUTE A — Connect the GitHub repository from hPanel

This is the fastest path and it gives you **automatic deploys on every push**.

## A1. Start the import

hPanel → **Websites** → **Add Website** → **Node.js web app** → **Import Git
repository**.

Or, from an existing site's dashboard: **Advanced → Git**.

Click **Connect with GitHub**. A popup opens where you install the
**Hostinger GitHub App** on your GitHub account. Grant it access to
`xneshaniy/outreach-local` (you can pick just that one repository).

## A2. Review build settings

This is the screen you are looking at. Fill it in exactly like this:

| Field | Value |
| --- | --- |
| Framework preset | **Next.js** (keep it — we override the details below) |
| Branch | **main** |
| Node version | **22.x** (20.x works too) |
| Root directory | `./` |

### Build and output settings → click **Change**

The Next.js default **will not work** — it assumes `next start` serves the
app, but this application ships a standalone bundle and a separate worker.
Use these values:

| Setting | Value |
| --- | --- |
| Install command | `npm ci` |
| **Build command** | **`npm run build:host`** |
| **Output directory** | **`deploy`** |
| **Entry file** | **`start.js`** |
| Start command | `node start.js` *(if the form shows one)* |

> If the form only offers a **Start command** and no Entry file, use
> `node deploy/start.js` instead.

**What each of these does**

- `npm run build:host` runs `scripts/build-on-host.sh`, which generates the
  Prisma client **for the server's own platform** and assembles the
  self-contained bundle in `deploy/`. This step is not optional: the Prisma
  query engine is a native binary, and one built for the wrong OS will not
  start.
- `deploy` is the output directory, so the app's files are `deploy/server`,
  `deploy/worker` and `deploy/node_modules`.
- `start.js` is a small launcher that starts **both** the web server and the
  sender worker from this single entry point — so Hostinger's restart button
  restarts the whole application and you never have to supervise a second
  process by hand.

## A3. Environment variables

Hostinger reads the keys from `.env.example` and asks for each value.

> **If the "Finish" button stays greyed out**, it is almost always because a
> variable has an **empty value** — Hostinger will not accept a blank field.
> Delete the rows for the optional Google OAuth variables if you do not have a
> Google Cloud client yet, and make sure the field you were last editing has
> lost focus (click elsewhere) before checking the button.
>
> The fastest, most reliable route is the **"Import .env"** button next to
> "Add more": upload `.env.hostinger` from the repository root (it holds
> every non-empty production value already filled in), then press Finish.
> Add the Google OAuth variables by hand later if you need Gmail senders.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://neondb_owner:YOUR_PASSWORD@ep-sweet-truth-ahx828x4.c-3.us-east-1.aws.neon.tech/neondb?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60` |
| `APP_URL` | `https://silver-sparrow-530238.hostingersite.com` *(see A4)* |
| `NODE_ENV` | `production` |
| `AUTH_SECRET` | *your existing value* — see below |
| `ENCRYPTION_KEY` | *your existing value* — see below |
| `SESSION_TTL_SECONDS` | `604800` |
| `RATE_LIMIT_ENABLED` | `true` |
| `RATE_LIMIT_AUTH_MAX` | `10` |
| `RATE_LIMIT_AUTH_WINDOW_SECONDS` | `60` |
| `RATE_LIMIT_API_MAX` | `120` |
| `RATE_LIMIT_API_WINDOW_SECONDS` | `60` |
| `GOOGLE_CLIENT_ID` | your Google OAuth client id (or leave empty) |
| `GOOGLE_CLIENT_SECRET` | your Google OAuth client secret (or leave empty) |
| `GOOGLE_REDIRECT_URI` | `https://silver-sparrow-530238.hostingersite.com/api/google/callback` *(see A4)* |
| `GOOGLE_SCOPES` | `https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile` |
| `DRY_RUN` | `true` *(keep it on until everything is verified — see A6)* |
| `MOCK_PROVIDER` | `false` |
| `SENDER_DAILY_CAP_DEFAULT` | `100` |
| `SENDER_QUOTA_TIMEZONE` | `UTC` |
| `MAX_SENDER_ACCOUNTS` | `10` |
| `MIN_DAYS_BETWEEN_CONTACTS` | `3` |
| `WORKER_POLL_INTERVAL_MS` | `2000` |
| `WORKER_BATCH_SIZE` | `20` |
| `WORKER_LEASE_SECONDS` | `120` |
| `WORKER_MAX_ATTEMPTS` | `5` |
| `WORKER_BACKOFF_BASE_MS` | `5000` |
| `LOG_LEVEL` | `info` |

### Two values that must be exactly right

**`AUTH_SECRET` / `ENCRYPTION_KEY`** — use the **same values you already run
on Vercel**. They are secrets, so they are deliberately not written in this
repository; copy them from your own `.env` (or from the Vercel project's
environment settings) into the hPanel field.

> If you have to generate them fresh:
> ```bash
> openssl rand -base64 64   # AUTH_SECRET
> openssl rand -base64 32   # ENCRYPTION_KEY
> ```
> Changing `ENCRYPTION_KEY` makes every stored provider token unreadable, so
> you would have to reconnect all your sender accounts. Changing `AUTH_SECRET`
> logs everyone out.

**`APP_URL`** — this is not just a link. It is the base of the unsubscribe URL
in every email, the OAuth redirect URI, **and the CSRF origin check**. If
`APP_URL` does not match the address in the browser bar exactly, every
state-changing request is rejected with *"Request origin not allowed"* and you
cannot log in.

> If you later attach your own domain (`outreach.growthleder.com`), update
> `APP_URL` **and** `GOOGLE_REDIRECT_URI` to that domain and restart. To keep
> both addresses working at once, add the old one to `EXTRA_ALLOWED_ORIGINS`
> as a comma-separated list.

## A4. Deploy

Click **Deploy**. Hostinger clones the repository, runs `npm ci`, runs
`npm run build:host`, and starts `deploy/start.js`.

Watch the progress on the deployment details page — the build output streams
live. A successful build ends with:

```
==> Bundle ready: .../deploy
    Prisma engine for: Linux/x64
```

## A5. Apply the database migrations

The build does **not** run migrations (a database outage should never fail a
deploy). Do it once over SSH.

Hostinger clones the repository somewhere under your domain folder, and the
exact path depends on how you set up the app. Find it instead of guessing:

```bash
source ~/.nvm/nvm.sh && nvm use 22
find ~/domains -maxdepth 4 -type d -name prisma -path "*prisma" 2>/dev/null
```

That prints the directory that holds `schema.prisma` and `migrations/`.
`cd` into it and run the migration:

```bash
cd <the directory the find command printed>

export DATABASE_URL='postgresql://neondb_owner:YOUR_PASSWORD@ep-sweet-truth-ahx828x4.c-3.us-east-1.aws.neon.tech/neondb?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60'

npx prisma migrate deploy
```

Expected output:

```
Your database is now in sync with your Prisma schema.
```

> `npx prisma` needs the `prisma` CLI, which the build's `npm ci` already
> installed in the repository — so run this **in the repository directory**,
> not in the `deploy/` folder.
>
> `DATABASE_URL` is not in your SSH shell: the hPanel environment variables
> only apply to the app process, which is why you export it above.

> Keep `connect_timeout=60&pool_timeout=60` in the URL. Neon suspends idle
> instances and the app retries transient connection errors, but the timeout
> is what turns a cold start into a fast one.

## A6. Verify

```bash
curl -s https://silver-sparrow-530238.hostingersite.com/api/health
```

Expected:

```json
{"status":"ok","database":"up"}
```

Then check in the browser:

| URL | What to check |
| --- | --- |
| `/login` | The sign-in page renders |
| `/dashboard` | Sign in as the owner — the dashboard loads with real numbers |
| `/portal/login` | The client portal login renders |

Also confirm the **worker** is running. In the deployment log you should see
both lines:

```
[launcher] starting the sender worker...
[launcher] starting the web server on port ... 
```

**Before turning `DRY_RUN` off:**

1. `/api/health` returns `database: up`.
2. A connected sender account passes its test on the **Sender accounts** page.
3. A campaign preview shows the message you expect, with a working
   `/api/unsubscribe` link in it.
4. The sending window, time-zone policy and daily limit are right.
5. The **Audit & health** page shows no errors.

Then set `DRY_RUN=false` and redeploy (or press **Restart** in hPanel).

## A7. Every later update

Push to `main` and Hostinger redeploys automatically:

```bash
git push
```

If a new release adds a migration, run `npx prisma migrate deploy` over SSH
again (step A5). The guide above is the whole cycle.

---

# ROUTE B — Build over SSH (no Git integration)

Use this if the GitHub app is not an option.

## B1. Connect

hPanel → **Advanced → SSH Access**. Copy the command it shows:

```bash
ssh root@YOUR-SERVER-IP -p 65002
```

Hostinger installs Node with **nvm**, which is *not* on the `PATH` in a fresh
SSH session:

```bash
source ~/.nvm/nvm.sh
nvm use 22
```

## B2. Clone and build on the server

> Building **on the server** is not optional — the Prisma query engine is a
> native binary compiled for one operating system.

```bash
cd ~
git clone https://github.com/xneshaniy/outreach-local.git outreach
cd outreach
bash scripts/build-on-host.sh --install-to ~/domains/<your-domain>/nodejs
```

The script installs dependencies, generates the Prisma client for **this**
platform, and copies the finished bundle into the app root.

## B3. Point the Node.js app at it

hPanel → **Websites** → your domain → **Setup Node.js App**:

| Field | Value |
| --- | --- |
| Node.js version | `22.x` |
| Application mode | `Production` |
| Application root | `nodejs` |
| Application URL (entry point) | `start.js` |

Add the environment variables (same table as A3), then **Restart
Application**.

## B4. Migrations

Same as step A5.

---

## How the two processes are run

The application needs two processes:

| Process | Job |
| --- | --- |
| `deploy/server/server.js` | The Next.js server — UI, API, webhooks |
| `deploy/worker/index.cjs` | Claims queued jobs and hands them to the provider |

**Without the worker, nothing is ever sent.**

`deploy/start.js` starts the worker as a child process and then brings up the
web server in the same process, so a platform that supervises one entry point
(Hostinger, Railway, Fly) runs the whole application. The worker inherits the
same environment, and it is stopped when the launcher stops.

To run the web app on its own (for debugging), set `RUN_WORKER=false`.

If you prefer to supervise the worker separately with pm2:

```bash
cd ~/domains/<your-domain>/nodejs
npm install -g pm2
set -a; . ./.env; set +a
pm2 start worker/index.cjs --name outreach-worker --time && pm2 save
```

> pm2 does **not** inherit the environment variables you set in hPanel — that
> is why the `.env` step matters. The worker needs at least `DATABASE_URL`,
> `AUTH_SECRET`, `ENCRYPTION_KEY` and `APP_URL`.

Shared hosting does not run systemd, so `pm2 startup` will not work. To bring
the worker back after a container restart, add an hPanel cron job
(**Advanced → Cron Jobs**):

| Field | Value |
| --- | --- |
| Command | `cd ~/domains/<your-domain>/nodejs && source ~/.nvm/nvm.sh && nvm use 22 && pm2 resurrect` |
| Frequency | **Once an hour** |

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '@prisma/client'` | The bundle was built on Windows | Build on the server (`npm run build:host`) |
| `Invalid platform for prisma query engine` | Same as above | Build on the server |
| The build log ends without "Bundle ready" | The build command is wrong | It must be `npm run build:host` |
| `node: command not found` over SSH | nvm is not loaded | `source ~/.nvm/nvm.sh && nvm use 22` |
| `Can't reach database server` | Neon suspended the idle instance | Add `connect_timeout=60&pool_timeout=60` |
| `relation "_prisma_migrations" does not exist` | Migrations were never applied | `npx prisma migrate deploy` |
| *"Request origin not allowed"* on every action | `APP_URL` does not match the browser's origin | Fix `APP_URL`, then restart |
| `AUTH_SECRET is not set` | Env vars not saved in hPanel | Add them, then redeploy / restart |
| The app 502s | The app crashed at startup | Check the deployment log for the first error |
| Emails never send | The worker is not running | Look for `[launcher] starting the sender worker...` in the log |
| Unsubscribe links point at localhost | `APP_URL` is wrong | Fix `APP_URL`, restart |
| `ENCRYPTION_KEY` changed by accident | Stored provider tokens are unreadable | Restore the old key, or reconnect every sender account |

---

## Security checklist

- [ ] `AUTH_SECRET` and `ENCRYPTION_KEY` are unique, random, and backed up.
- [ ] `APP_URL` is HTTPS and matches the address in the browser bar exactly.
- [ ] `DRY_RUN=false` only after the full dry-run checklist passes.
- [ ] The database credentials are least-privilege and not reachable publicly.
- [ ] `.env` is never committed to Git (it is in `.gitignore`).
- [ ] The hPanel environment variables are not shared in a screenshot.
