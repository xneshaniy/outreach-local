# Go-live runbook

Everything that has to be true before this application sends real email, and
how to get there. The steps are ordered: do not skip ahead.

---

## 0. What is deployed where

| Piece | Where | Notes |
| --- | --- | --- |
| Application | Hostinger | `https://ghostwhite-parrot-522091.hostingersite.com` |
| Database | Supabase PostgreSQL | project `outreach-local`, region `ap-northeast-1` |
| Sender accounts | Your own Gmail / SMTP | connected inside the app |
| Source | GitHub `xneshaniy/outreach-local` | every push redeploys |

The application talks to PostgreSQL **directly**, through Prisma. It does not
use the Supabase REST API, so it needs **no Supabase API key at all** — only
`DATABASE_URL`. Keeping the secret API key out of the hosting panel is one
less credential to leak.

---

## 1. The database is ready

The Supabase project has the full schema: 33 application tables, 24 enums,
86 indexes (including the two *partial* unique indexes that MySQL cannot
express), 62 foreign keys, and all 6 migrations recorded in
`_prisma_migrations` with the checksums Prisma expects.

Check it at any time:

```bash
node scripts/verify-supabase-schema.mjs     # needs SUPABASE_SECRET_KEY
```

or with SQL:

```sql
SELECT
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tables,
    (SELECT count(*) FROM pg_type WHERE typtype = 'e') AS enums,
    (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') AS indexes,
    (SELECT count(*) FROM _prisma_migrations) AS migrations;
```

Expected: `33 | 24 | 86 | 6`.

**Row Level Security is enabled on every table and there are no policies.**
That is deliberate: it means the *publishable* API key — which is designed to
be public — cannot read or write anything. The application connects as the
table owner, which bypasses RLS, and that is the only credential that can.

Do not enable "Force RLS" on these tables: the application would then be
subject to the (empty) policy set and see nothing.

---

## 2. The environment variables

The hosting panel needs these. The values live in `.env.hostinger` on the
workstation (gitignored) and are pasted through the panel's **Import .env**
button.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | the Supabase **session pooler** URL |
| `APP_URL` | ✅ | must match the browser address **exactly** |
| `NODE_ENV` | ✅ | `production` |
| `AUTH_SECRET` | ✅ | 64 random bytes, base64 |
| `ENCRYPTION_KEY` | ✅ | 32 random bytes, base64 |
| `HOSTNAME` | ✅ | `0.0.0.0` |
| `DRY_RUN` | ✅ | `true` until the checklist in section 5 passes |
| `SESSION_TTL_SECONDS` | recommended | `604800` |
| `RATE_LIMIT_*` | recommended | the defaults in `.env.hostinger` |
| `SENDER_DAILY_CAP_DEFAULT` | recommended | `100` — never exceed the provider limit |
| `MIN_DAYS_BETWEEN_CONTACTS` | recommended | `3` |
| `WORKER_*` | recommended | the defaults in `.env.hostinger` |
| `LOG_LEVEL` | recommended | `info` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | only for Gmail | see section 4 |
| `GOOGLE_REDIRECT_URI` | only for Gmail | `<APP_URL>/api/google/callback` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` | only for SMTP | optional |

**`APP_URL` is the one that breaks things silently.** It is the base of the
unsubscribe link, the OAuth redirect, *and* the CSRF origin check. If it does
not match the address in the browser bar, every write is rejected with
*"Request origin not allowed"* and nobody can sign in.

### The DATABASE_URL

```
postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60
```

Use the **session pooler** (port 5432), not the transaction pooler (6543):

- the direct host `db.<PROJECT_REF>.supabase.co` is **IPv6-only** — it has no
  A record, so IPv4-only hosting cannot reach it;
- the transaction pooler breaks Prisma's interactive transactions, which the
  queue depends on.

---

## 3. The hosting build

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Branch | `main` |
| Node.js | `22.x` |
| Install command | `npm ci --include=dev` |
| Build command | `npm run build:host` |
| Output directory | `deploy` |
| Entry file | `start.js` |
| Start command | `node deploy/start.js` |

`npm ci --include=dev` is not optional. A hosting panel that sets
`NODE_ENV=production` makes npm omit the devDependencies, and everything the
build needs is one of them: the Tailwind PostCSS plugin (without it the build
dies with *"Cannot find module '@tailwindcss/postcss'"*), the Prisma CLI, and
esbuild. The build also detects a production-only install and repairs it.

`npm run build:host` has to run **on the server**: the Prisma query engine is
a native binary compiled for the platform it will run on.

---

## 4. Connect a sender account

The application refuses to send without one.

**Gmail (recommended).** Create a Google Cloud OAuth client (Web application),
add the redirect URI `<APP_URL>/api/google/callback`, and put the client id
and secret in the panel. Then in the app: **Sender accounts → Connect Google**
→ sign in and grant access.

**SMTP.** Create a sender account with the host, port, username and
password. The password is encrypted at rest with `ENCRYPTION_KEY`.

Each account has a daily cap. The effective cap is
`MIN(account cap, SENDER_DAILY_CAP_DEFAULT)` and it must never exceed the
provider's own limit.

---

## 5. The dry-run checklist

`DRY_RUN=true` means the whole pipeline runs — scheduling, quota
reservation, rendering, tracking, follow-up scheduling — but **no email is
ever handed to a provider** and no provider quota is consumed.

Run through all of it before going live:

- [ ] `GET /api/health` → `{"status":"ok","database":"up"}`
- [ ] the sender account is connected and its test passes
- [ ] a campaign preview shows the message you expect, with a working
      `/api/unsubscribe` link
- [ ] the sending window, the time-zone policy and the daily limit are right
- [ ] the **Audit & health** page shows no errors
- [ ] the **Send queue** shows the recipients scheduled, and the times are
      inside each recipient's local window
- [ ] an unsubscribe from a rendered message removes the recipient
- [ ] a contact that unsubscribed is skipped by the next send

Then set `DRY_RUN=false` and restart the app and the worker.

---

## 6. After going live

1. **Send one real message to yourself.** Confirm it arrives, that the open
   pixel fires, and that the click redirect works.
2. **Check the client portal.** Assign the campaign to a client, then sign in
   at `/portal/login` — the portal shows only the assigned campaigns.
3. **Watch the first hour.** Queue depth, failed jobs, and the worker log.

---

## 7. Turning a production incident into a non-event

```bash
# Stop sending, without stopping the app
#   -> Campaigns -> pause the campaign, or
#   -> Sender accounts -> pause the account

# Everything queued but not yet sent can be cancelled
#   -> Campaigns -> Emergency stop

# The queue is visible at
#   -> Queue
```

Ambiguous jobs — a provider call that timed out *after* submission — are
never retried automatically, because a retry could send twice. They appear in
the **Queue** page and can be resolved by hand.

---

## 8. Credentials that were exposed and must be rotated

These appeared in a conversation and must be treated as compromised.

| Credential | Where to rotate | Effect of rotating |
| --- | --- | --- |
| **Supabase personal access token** (`sbp_…`) | Supabase → Account → Personal Access Tokens | none on the running app |
| **Supabase secret API key** (`sb_secret_…`) | Supabase → Project → Settings → API Keys | none on the running app — the app does not use it |
| **Supabase publishable key** (`sb_publishable_…`) | optional | it is designed to be public |
| **Database password** | already rotated | sessions survive, data survives |
| **`AUTH_SECRET` / `ENCRYPTION_KEY`** | already rotated | no live sessions and no stored sender tokens existed, so nothing was invalidated |
| **Hostinger API token** (`mlEx…`) | Hostinger → API tokens | none on the running app |
| **Hostinger MySQL password** | the MySQL database is unused — delete it | none |

**The database password, `AUTH_SECRET` and `ENCRYPTION_KEY` have already been
rotated** and the new values are in `.env.hostinger` and `.env.supabase` on
the workstation. Paste the current values into the hosting panel.

The Supabase personal access token, the Supabase secret key and the Hostinger
token still need rotating — they are account-level credentials, and the
application does not need any of them.
