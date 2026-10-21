# Deploying to Hostinger

This guide is the exact, click-by-click path for putting the Email Outreach
Platform on Hostinger shared hosting, including the sender worker.

It assumes you are deploying to `outreach.growthleder.com`.

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
| Node.js | **22.x** (20.9+ works) |
| Database | A **PostgreSQL** database — Neon is already configured |
| SSH access | hPanel → **Advanced → SSH Access** (needed to build and to run the worker) |

---

## 1. Connect to the server

hPanel → **Advanced → SSH Access**. Copy the command it shows, e.g.

```bash
ssh root@YOUR-SERVER-IP -p 65002
```

You can also open a terminal from hPanel (**Advanced → Terminal**).

### Make Node available in your SSH session

Hostinger installs Node with **nvm**, which is *not* on the `PATH` in a fresh
SSH session. Run this once:

```bash
source ~/.nvm/nvm.sh
nvm use 22
node -v     # -> v22.x.x
```

`scripts/build-on-host.sh` does this for you automatically, but it is handy to
have it in your shell.

---

## 2. Get the code onto the server

```bash
cd ~
git clone https://github.com/xneshaniy/outreach-local.git outreach
cd outreach
```

If Git asks for credentials, use a [personal access token](https://github.com/settings/tokens)
as the password. If `git` is not installed, download the ZIP from GitHub and
unzip it into `~/outreach` instead.

---

## 3. Build on the server

> **This step is not optional.** The Prisma query engine is a native binary
> compiled for one operating system. A bundle built on Windows contains the
> Windows engine and the app will not start on Linux. Building here removes
> the problem entirely.

```bash
cd ~/outreach
source ~/.nvm/nvm.sh && nvm use 22
bash scripts/build-on-host.sh
```

The script installs dependencies, generates the Prisma client for **this**
platform, and produces `~/outreach/deploy/` containing:

```
deploy/
  server/          the Next.js standalone server
  worker/          the background sender
  node_modules/    the worker's runtime dependencies (incl. the Prisma engine)
  prisma/          schema + migrations
  .env.example     the variables you must set
  .htaccess        Apache/LiteSpeed proxy rules (only needed for the pm2 route)
  start.sh         start/stop script for pm2
```

---

## 4. Apply the database migrations

Run this **once** per release, with `DATABASE_URL` pointing at your
PostgreSQL database:

```bash
cd ~/outreach
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/neondb?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60'
npx prisma migrate deploy
```

Expected output:

```
Your database is now in sync with your Prisma schema.
```

> Keep `connect_timeout=60&pool_timeout=60` in the URL. Neon suspends idle
> instances and the app retries transient connection errors, but the timeout
> is what turns a cold start into a fast one.

---

## 5. Install the bundle into the Node.js app root

Hostinger serves Node apps from `~/domains/<your-domain>/nodejs`. Copy the
bundle there:

```bash
bash scripts/build-on-host.sh --install-to ~/domains/outreach.growthleder.com/nodejs
```

(If the directory does not exist yet, create the Node.js app in hPanel first —
step 6 — and then re-run this command.)

---

## 6. Create the Node.js application in hPanel

hPanel → **Websites** → click **outreach.growthleder.com** → **Setup Node.js App**.

Fill in:

| Field | Value |
| --- | --- |
| Node.js version | **22.x** |
| Application mode | **Production** |
| Application root | `nodejs` |
| Application URL (entry point) | `server/server.js` |

Press **Create Application**, then press **Restart Application**.

> **The entry point must be `server/server.js`, not `server.js`.** The
> standalone server lives inside the `server/` folder of the bundle.

### Environment variables

In the same panel, under **Environment variables**, add these. Use
**Advanced** mode (the "Add variable" toggle) so you can paste raw values.

**Required**

| Name | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@HOST/neondb?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60` |
| `AUTH_SECRET` | 64 random bytes, base64 — `openssl rand -base64 64` |
| `ENCRYPTION_KEY` | 32 random bytes, base64 — `openssl rand -base64 32` |
| `APP_URL` | `https://outreach.growthleder.com` |
| `HOSTNAME` | `0.0.0.0` |
| `NODE_ENV` | `production` |
| `DRY_RUN` | `true` — **keep this on until you have verified everything** |

**Recommended**

| Name | Value |
| --- | --- |
| `SESSION_TTL_SECONDS` | `604800` |
| `SENDER_DAILY_CAP_DEFAULT` | `100` |
| `SENDER_QUOTA_TIMEZONE` | `UTC` |
| `MAX_SENDER_ACCOUNTS` | `10` |
| `MIN_DAYS_BETWEEN_CONTACTS` | `3` |
| `WORKER_POLL_INTERVAL_MS` | `2000` |
| `WORKER_BATCH_SIZE` | `20` |
| `WORKER_LEASE_SECONDS` | `120` |
| `WORKER_MAX_ATTEMPTS` | `5` |
| `WORKER_BACKOFF_BASE_MS` | `5000` |
| `RATE_LIMIT_ENABLED` | `true` |
| `LOG_LEVEL` | `info` |

**If you use Gmail senders**, also add:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from the Google Cloud console |
| `GOOGLE_CLIENT_SECRET` | from the Google Cloud console |
| `GOOGLE_REDIRECT_URI` | `https://outreach.growthleder.com/api/google/callback` |

> `AUTH_SECRET` and `ENCRYPTION_KEY` must be **exactly** the same values you
> use everywhere else for this deployment. Changing `ENCRYPTION_KEY` makes
> existing encrypted sender tokens unreadable — reconnect your sender accounts
> afterwards. Changing `AUTH_SECRET` logs everyone out.
>
> `APP_URL` is not just a link: it is the base of the unsubscribe URL in every
> email, the OAuth redirect URI, and the CSRF origin check. If it is wrong,
> unsubscribe links and Google sign-in break.

---

## 7. Start the sender worker

**The worker is a separate process. Without it, no email is ever sent.** The
app serves the UI; the worker claims queued jobs and hands them to the mail
provider.

Hostinger's Node.js app panel is for HTTP applications, so the worker is run
with **pm2** over SSH instead.

```bash
cd ~/domains/outreach.growthleder.com/nodejs
source ~/.nvm/nvm.sh && nvm use 22

npm install -g pm2          # only if pm2 is not already installed

# Load the same variables the app uses.
set -a
. ./.env                   # if you saved them to a .env file in this folder
set +a

pm2 start worker/index.cjs --name outreach-worker --time
pm2 save
pm2 status
```

> **Where do the variables come from?** The hPanel environment variables apply
> to the Node.js *web app* process. `pm2` is a separate process and does not
> inherit them. Either:
> - save them in `~/domains/outreach.growthleder.com/nodejs/.env` and source
>   that file before starting pm2 (as above), **or**
> - pass them inline: `DATABASE_URL='...' AUTH_SECRET='...' pm2 start ... --update-env`
>
> The worker needs at least `DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY`
> and `APP_URL`.

### Make the worker survive a reboot

Hostinger shared hosting does not run systemd, so `pm2 startup` will not work.
Use a hPanel cron job instead:

hPanel → **Advanced → Cron Jobs** → **Add Cron Job**

| Field | Value |
| --- | --- |
| Command | `cd ~/domains/outreach.growthleder.com/nodejs && source ~/.nvm/nvm.sh && nvm use 22 && pm2 resurrect` |
| Frequency | **Once an hour** |

An hourly resurrect is enough: if the container restarted and pm2 lost its
process list, this brings the worker back within the hour. The web app does
not need this — Hostinger restarts it automatically.

---

## 8. Point the domain at the app

hPanel → **Websites** → **Domains** → find `outreach.growthleder.com` →
**Manage**. Make sure the website it points at is the one that has the Node.js
application, and that the document root is the `nodejs` folder's parent
(Hostinger handles this automatically when the app is created from the
domain's page).

Then enable HTTPS:

hPanel → **Security** → **SSL** → **Install Let's Encrypt** for
`outreach.growthleder.com` (and `www` if you use it).

---

## 9. Verify

```bash
# 1. The app answers locally
curl -s http://127.0.0.1:3000/api/health

# 2. It answers on the public domain
curl -s https://outreach.growthleder.com/api/health
```

Expected:

```json
{"status":"ok","database":"up"}
```

Then open the site:

| URL | What to check |
| --- | --- |
| `https://outreach.growthleder.com/login` | Sign in as the owner |
| `https://outreach.growthleder.com/dashboard` | The dashboard loads with real numbers |
| `https://outreach.growthleder.com/portal/login` | The client portal login loads |
| `https://outreach.growthleder.com/api/health` | `{"status":"ok","database":"up"}` |

**Before turning off `DRY_RUN`:**

1. `/api/health` returns `database: up`.
2. A connected sender account passes its test on the **Sender accounts** page.
3. A campaign preview shows the message you expect, with a working
   `/api/unsubscribe` link in it.
4. The sending window, time-zone policy and daily limit are right.
5. The worker is running (`pm2 status` shows `outreach-worker` **online**) and
   the **Audit & health** page shows no errors.

Then set `DRY_RUN=false` in the hPanel environment variables and press
**Restart Application**, and restart the worker:

```bash
pm2 restart outreach-worker --update-env
```

---

## 10. Updating to a new version

```bash
cd ~/outreach
git pull
source ~/.nvm/nvm.sh && nvm use 22

export DATABASE_URL='postgresql://...'
npx prisma migrate deploy

bash scripts/build-on-host.sh --install-to ~/domains/outreach.growthleder.com/nodejs
```

Then, in hPanel: **Restart Application** (the web app), and over SSH:

```bash
pm2 restart outreach-worker --update-env
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '@prisma/client'` | The bundle was built on Windows | Rebuild on the server: `bash scripts/build-on-host.sh` |
| `Invalid platform for prisma query engine` | Same as above | Rebuild on the server |
| `node: command not found` over SSH | nvm is not loaded | `source ~/.nvm/nvm.sh && nvm use 22` |
| `Can't reach database server` | Neon suspended the idle instance | Add `connect_timeout=60&pool_timeout=60` to `DATABASE_URL` |
| `relation "_prisma_migrations" does not exist` | Migrations were never applied | `npx prisma migrate deploy` |
| The app 502s in the browser | The app crashed at startup | hPanel → the app → **Logs**; check `HOSTNAME=0.0.0.0` is set |
| `AUTH_SECRET is not set` | Env vars not saved in hPanel | Add them, then **Restart Application** |
| Emails never send | The worker is not running | `pm2 status` → start `outreach-worker` |
| Unsubscribe links point at localhost | `APP_URL` is wrong | Set `APP_URL=https://outreach.growthleder.com`, restart |
| The app works on `http://IP:3000` but not on the domain | The domain is not bound to the app | hPanel → Websites → Domains → Manage |
| `ENCRYPTION_KEY` changed by accident | Existing sender tokens are unreadable | Restore the old key, or reconnect every sender account |

---

## Security checklist

- [ ] `AUTH_SECRET` and `ENCRYPTION_KEY` are unique, random, and backed up.
- [ ] `APP_URL` is HTTPS and matches the OAuth redirect URI exactly.
- [ ] `DRY_RUN=false` only after the full dry-run checklist passes.
- [ ] The database credentials are least-privilege and not reachable publicly.
- [ ] `.env` is never committed to Git (it is in `.gitignore`).
- [ ] The hPanel environment variables are not shared in a screenshot.
