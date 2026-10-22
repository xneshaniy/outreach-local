# Deploying to Hostinger

This guide is the exact, click-by-click path for putting the Email Outreach
Platform on Hostinger shared hosting.

It covers **Route A** — connecting the GitHub repository directly from hPanel,
which is the recommended path — and **Route B** — building over SSH.

> **The one thing to know up front:** this application requires
> **PostgreSQL**. Hostinger's shared hosting only offers MySQL, and the
> schema uses PostgreSQL enums, partial unique indexes, `gen_random_uuid()`
> and `FOR UPDATE SKIP LOCKED`. **Use Supabase** (or any managed
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
| Install command | `npm ci --include=dev` |
| **Build command** | **`npm run build:host`** |
| **Output directory** | **`deploy`** |
| **Entry file** | **`start.js`** |
| **Start command** | **`node deploy/start.js`** |

> If the form only offers a **Start command** and no Entry file, use
> `node deploy/start.js` on its own.

**What each of these does**

- `npm ci --include=dev` matters: hosting platforms set `NODE_ENV=production`,
  and npm then omits devDependencies — which is where the Prisma CLI and
  esbuild live. Without them the build cannot run.
- `npm run build:host` runs `scripts/build-on-host.mjs`, which generates the
  Prisma client **for the server's own platform** and assembles the
  self-contained bundle in `deploy/`. This step is not optional: the Prisma
  query engine is a native binary, and one built for the wrong OS will not
  start. It is written in Node, so it needs no shell, no `nvm` and no PATH
  juggling — it only needs `node`.
- `deploy` is the output directory, so the app's files are `deploy/server`,
  `deploy/worker` and `deploy/node_modules`.
- `start.js` is a small launcher that starts **both** the web server and the
  sender worker from this single entry point — so Hostinger's restart button
  restarts the whole application and you never have to supervise a second
  process by hand. It finds the bundle itself, so it works whether Hostinger
  starts it from the application root or from the output directory.

### If the platform insists on its own build command

Some panels have a fixed "Build command" field, or a Next.js preset they
apply on their own. Two things make that work:

- **`npm run build`** is now a Node script (`scripts/build.mjs`) that
  generates the Prisma client with `npx prisma generate` — so it works even
  when the platform omitted devDependencies — then builds the worker and the
  app, and assembles the standalone output.
- **The launcher finds the application by itself.** `start.js` looks for
  `server/server.js` and `worker/index.cjs` in the directory it is in, in
  `./deploy`, and in the working directory — so it works whether the panel
  runs the repository root, the output directory, or one inside the other.

All of these are verified to serve the app with the database up and the
worker running (`scripts/simulate-hostinger-layouts.cjs`):

| Entry file | Start command |
| --- | --- |
| `start.js` | `node start.js` |
| `start.js` | `node deploy/start.js` |
| `deploy/start.js` | `node deploy/start.js` |
| `deploy/start.js` | `node start.js` (from inside `deploy/`) |

The port is taken from `PORT`, and `-p <port>` on the command line is also
accepted — so a panel that runs `npm run start -- -p $PORT` works too. The
launcher does not need `HOSTNAME` to be set.

**If the log says `Cannot find module .../deploy/deploy/start.js`**

That means the platform ran the command with the working directory already
set to the output directory. Change the **Start command** to `node start.js`
and redeploy — the launcher now resolves the application by itself, so it
works in every layout. (`scripts/simulate-hostinger-layouts.cjs` verifies all
five.)

## A3. Environment variables

Hostinger reads the keys from `.env.example` and asks for each value.

> **If the "Finish" button stays greyed out**, it is almost always because a
> variable has an **empty value** — Hostinger will not accept a blank field.
> Delete the rows for the optional Google OAuth variables if you do not have a
> Google Cloud client yet, and make sure the field you were last editing has
> lost focus (click elsewhere) before checking the button.
>
> The fastest, most reliable route is the **"Import .env"** button next to
> "Add more": upload `.env.hostinger` from the project root on your machine.
> It holds every non-empty production value already filled in. (It is
> gitignored, so it is on your disk and not in the GitHub repo.) Then press
> Finish. Add the Google OAuth variables by hand later if you need Gmail
> senders.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres.rkxohuoiggoxgpbcgoda:YOUR_PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60` |
| `APP_URL` | `https://ghostwhite-parrot-522091.hostingersite.com` *(see A4)* |
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
| `GOOGLE_REDIRECT_URI` | `https://ghostwhite-parrot-522091.hostingersite.com/api/google/callback` *(see A4)* |
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
deploy), and the Supabase project starts out **completely empty** — no tables
at all.

### Option 1 — one command from your own machine (recommended)

If you have the database password, this is the simplest and the most reliable
route. Nothing is pasted anywhere:

```bash
cd <the project folder>
export DATABASE_URL='postgresql://postgres.rkxohuoiggoxgpbcgoda:YOUR_PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60'
npx prisma migrate deploy
```

Expected output:

```
Your database is now in sync with your Prisma schema.
```

**Seed the demo workspace** the same way, so you can sign in immediately:

```bash
DATABASE_URL="$DATABASE_URL" npx tsx prisma/seed.ts
```

It creates the owner account (`owner@example.com` / `ChangeMe123!`), a
client account, the service profiles, the pipeline stages, a template and a
demo campaign with contacts.

### Option 2 — the Supabase SQL Editor (no password needed)

Supabase → your project → **SQL Editor** → **New query**. Paste the contents
of `scripts/supabase-bootstrap.sql` and press **Run**.

> **This script rebuilds the `public` schema.** It drops it and recreates it
> from the committed migrations. That is what makes it reliable — the result
> is always exactly the schema `prisma migrate deploy` produces, including the
> two partial unique indexes that MySQL cannot express, and it can be run more
> than once without failing.
>
> If the database already holds data you want to keep, **do not run it** —
> use Option 1 (`npx prisma migrate deploy`), which never drops anything.

That file is generated from the committed migrations, so it can never drift
from them:

```bash
npm run db:bootstrap        # writes scripts/supabase-bootstrap.sql
```

It creates the whole schema **and** records the migrations in
`_prisma_migrations` with the exact checksums Prisma uses, so a later
`npx prisma migrate deploy` reports *"No pending migrations to apply"*
instead of trying to apply them a second time. It ends with a `SELECT` that
counts the tables, enums, indexes and migration records, so you can see at a
glance that it worked.

> If you see `ERROR: 42710: type "Role" already exists`, the schema was
> **already created** — a previous run succeeded and this one is a repeat.
> Run the verification `SELECT` below to confirm, and move on.
>
> ```sql
> SELECT
>     (SELECT count(*) FROM information_schema.tables
>       WHERE table_schema = 'public') AS tables,
>     (SELECT count(*) FROM pg_type WHERE typtype = 'e') AS enums,
>     (SELECT count(*) FROM pg_indexes
>       WHERE schemaname = 'public') AS indexes,
>     (SELECT count(*) FROM _prisma_migrations) AS migrations;
> ```
>
> The application tables are 33, the enums 24, the indexes 86 and the
> migration records 6.

**If the editor reports a syntax error**, the text was mangled on the way in
— usually a long line was re-wrapped and a quote was lost. Every string
literal in the file sits on its own line and the file is plain ASCII, so the
generator refuses to produce a file that is easy to break; if you still hit
it, use Option 1.

This was verified end to end: the script was applied to an empty database and
`prisma migrate deploy` then reported no pending migrations, with the
columns, indexes, enums and migration records identical to a database built
by `prisma migrate deploy`.

### Option 3 — the Supabase CLI

```bash
supabase login
supabase init
supabase link --project-ref rkxohuoiggoxgpbcgoda
supabase db push
```

### Applying it over SSH instead

If you would rather use the normal workflow on the server, find the database
password (Supabase → your project → **Settings → Database → Database
password**) and run:

```bash
source ~/.nvm/nvm.sh && nvm use 22
find ~/domains -maxdepth 4 -type d -name prisma 2>/dev/null
```

That prints the directory that holds `schema.prisma` and `migrations/`.
`cd` into it and run the migration:

```bash
cd <the directory the find command printed>

export DATABASE_URL='postgresql://postgres.rkxohuoiggoxgpbcgoda:YOUR_PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60'

npx prisma migrate deploy
```

> `npx prisma` needs the `prisma` CLI, which the build's `npm ci --include=dev`
> already installed in the repository — so run this **in the repository
> directory**, not in the `deploy/` folder.
>
> `DATABASE_URL` is not in your SSH shell: the hPanel environment variables
> only apply to the app process, which is why you export it above.
>
> Keep `connect_timeout=60&pool_timeout=60` in the URL. The instance suspends
> when idle and the app retries transient connection errors, but the timeout
> is what turns a cold start into a fast one.

### Supabase specifics

**Your project.** Project ref `rkxohuoiggoxgpbcgoda`, region `ap-northeast-1`
(Northeast Asia / Tokyo). Use the **session pooler**, not the direct host:

| Supabase option | Host | Use it? |
| --- | --- | --- |
| **Session pooler** | `aws-0-ap-northeast-1.pooler.supabase.com:5432` | ✅ **Use this** — IPv4, real sessions |
| Direct connection | `db.rkxohuoiggoxgpbcgoda.supabase.co:5432` | ❌ IPv6-only (no A record) — unreachable from IPv4-only hosting |
| Transaction pooler | `aws-0-ap-northeast-1.pooler.supabase.com:6543` | ⚠️ Needs `pgbouncer=true`, and Prisma's interactive transactions do not work with it |

The direct host has **no IPv4 address** — it resolves to an IPv6 address only.
Shared hosting is IPv4, so the direct host cannot be used.

The **database password** is not an API key. It is in Supabase → your project
→ **Settings → Database → Database password** (or press "Reset database
password" to set a new one).

**The API keys are not used by this application.** `sb_publishable_…` is the
public browser key and `sb_secret_…` is the server-side key; they
authenticate to the Supabase REST/Auth API. This app talks to PostgreSQL
directly through Prisma, so it needs neither — and it deliberately does not
ship a browser-side Supabase client, because that would expose the database
to anyone holding the publishable key.

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

# Moving the DATABASE onto Hostinger

> This is only possible with a **Hostinger VPS**. Shared hosting has no
> PostgreSQL, and the MySQL database you can create there **cannot** run this
> application — see [Why not MySQL](#why-not-mysql).

Shared hosting's MySQL cannot be used because the schema is PostgreSQL
(`provider = "postgresql"` in `prisma/schema.prisma`) and it relies on
features MySQL does not have:

| Feature the app needs | Where | MySQL |
| --- | --- | --- |
| **Partial unique indexes** | 2 migrations | not supported at all |
| `ON CONFLICT` upserts | 8 places in `src/` | different syntax |
| `gen_random_uuid()::text` | 4 places in `src/` | no `::` casts |
| `FOR UPDATE SKIP LOCKED` | `src/lib/queue.ts` | different semantics |
| Postgres enums | 24 types | mapped differently by Prisma |

The partial unique indexes are the decisive one: they are what enforces
"one global suppression per email, and one per campaign per email". MySQL has
no filtered indexes, so that guarantee would have to move into application
code — reintroducing exactly the race the database-level design prevents.

## Option A — a VPS running the whole stack (recommended)

One server, everything on Hostinger, and the worker is supervised for you.

1. Buy a **VPS** with at least 2 GB RAM.
2. SSH in and install Docker (Hostinger's VPS image has it, or use
   `get.docker.com`).
3. Clone and start:

   ```bash
   git clone https://github.com/xneshaniy/outreach-local.git ~/outreach
   cd ~/outreach
   cp .env.example .env
   nano .env          # DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY, APP_URL, DRY_RUN=false
   docker compose up -d --build
   ```

   `docker compose` starts `db` (PostgreSQL 16, persistent volume), a one-shot
   `migrate` service, `app` and `worker`.
4. Put nginx or Caddy in front for TLS, and point the domain at the VPS.

## Option B — a VPS with hPanel PostgreSQL, app on shared hosting

1. VPS → hPanel → **Databases → PostgreSQL** → create the database and user.
2. **Move the data across** with the dump script:

   ```bash
   # On your machine: export the live database
   DATABASE_URL="postgresql://...your-neon-url..." npm run db:export -- outreach-dump.sql

   # Copy it to the VPS, then restore it
   scp outreach-dump.sql root@YOUR-VPS:/root/
   ssh root@YOUR-VPS
   psql "postgresql://user:pass@127.0.0.1:5432/outreach?sslmode=disable" -f /root/outreach-dump.sql
   ```

   The dump contains the schema (replayed from the committed migrations) and
   every row, so the target database is an exact copy.
3. Put the new `DATABASE_URL` in the Hostinger app's environment variables
   and restart.

## If you would rather stay on shared hosting

Keep using **Neon**. It needs no server, it is already migrated and seeded,
and it is what the current deployment is verified against. The only thing
"on Hostinger" then means is the app itself, which is exactly what the
GitHub integration in Route A does.

---

## Why not MySQL

<details>
<summary>Why not MySQL?</summary>

The application is PostgreSQL-only, and not by a small margin:

- `prisma/schema.prisma` declares `provider = "postgresql"`. The schema, the
  Prisma client and every migration are Postgres.
- **2 partial (filtered) unique indexes** — MySQL has no equivalent at all.
- **8 `ON CONFLICT` clauses** — Postgres upsert syntax.
- **4 `gen_random_uuid()` calls** with `::text` casts — Postgres-only syntax.
- **3 `FOR UPDATE SKIP LOCKED`** sites — the atomic job-claiming mechanism.
- **24 Postgres enums** and **38 foreign-key constraints**.
- **17 raw-SQL call sites** in `src/` would each need rewriting.

Porting would mean rewriting the schema, both migrations, every raw query and
the concurrency semantics — and re-validating the duplicate-prevention and
quota guarantees that the whole design rests on. That is a large, risky
project, and it would replace a setup that already works.

</details>

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '@tailwindcss/postcss'` | The install step omitted the **devDependencies**, so the Tailwind PostCSS plugin was not installed | Set the install command to `npm ci --include=dev`. The build also detects this and repairs it itself, failing with a clear message if it cannot |
| `Cannot find module '@prisma/client'` | The same — the Prisma CLI was not installed | `npm ci --include=dev` |
| `Cannot find module 'esbuild'` | The same — the worker could not be bundled | `npm ci --include=dev` |
| `Invalid platform for prisma query engine` | The bundle was built on Windows | Build on the server (`npm run build:host`) |
| The build log ends without "Bundle ready" | The build command is wrong | It must be `npm run build:host` |
| `node: command not found` over SSH | nvm is not loaded | `source ~/.nvm/nvm.sh && nvm use 22` |
| `Can't reach database server` | The database suspended the idle instance | Add `connect_timeout=60&pool_timeout=60` |
| `relation "_prisma_migrations" does not exist` | Migrations were never applied | `npx prisma migrate deploy` |
| *"Request origin not allowed"* on every action | `APP_URL` does not match the browser's origin | Fix `APP_URL`, then restart |
| `AUTH_SECRET is not set` | Env vars not saved in hPanel | Add them, then redeploy / restart |
| The app 502s | The app crashed at startup | Check the deployment log for the first error |
| Emails never send | The worker is not running | Look for `[launcher] starting the sender worker...` in the log |
| Unsubscribe links point at localhost | `APP_URL` is wrong | Fix `APP_URL`, restart |
| `ENCRYPTION_KEY` changed by accident | Stored provider tokens are unreadable | Restore the old key, or reconnect every sender account |

### Why the install command matters

A hosting platform that sets `NODE_ENV=production` makes **npm omit
devDependencies** — and everything the build needs is a devDependency:

| Package | Needed by |
| --- | --- |
| `@tailwindcss/postcss`, `tailwindcss` | the PostCSS config, which `next build` loads |
| `prisma` | `prisma generate` |
| `esbuild` | the worker bundle |
| `typescript` | the type check inside `next build` |

So the install command must be `npm ci --include=dev`.

`prisma` is the awkward one: it is an *optional peer dependency* of
`@prisma/client`, which is a production dependency — so npm installs it even
in a production-only install. That makes it useless as a signal for "are the
build dependencies present?", which is why the build checks for **every
package it actually loads** instead of for a proxy.

The build is safe either way: it lists the packages it needs, installs them
with `--include=dev` when any are missing, and refuses to continue with a
half-installed tree — so a production-only install produces a clear error
instead of `Cannot find module '@tailwindcss/postcss'`.

---

## Security checklist

- [ ] `AUTH_SECRET` and `ENCRYPTION_KEY` are unique, random, and backed up.
- [ ] `APP_URL` is HTTPS and matches the address in the browser bar exactly.
- [ ] `DRY_RUN=false` only after the full dry-run checklist passes.
- [ ] The database credentials are least-privilege and not reachable publicly.
- [ ] `.env` is never committed to Git (it is in `.gitignore`).
- [ ] The hPanel environment variables are not shared in a screenshot.
