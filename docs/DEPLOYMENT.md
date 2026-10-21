# Deployment

This guide covers running the Email Outreach Platform in production. It assumes
you are comfortable with PostgreSQL, Docker, and a reverse proxy / load balancer.

The application has two runtime roles that share one image:

| Role       | Command                    | Purpose                                  |
| ---------- | -------------------------- | ---------------------------------------- |
| **app**    | `node server.js`           | Next.js server (UI + REST API + webhooks).|
| **worker** | `node worker/index.cjs`    | Claims and sends queued jobs, reconciles. |

You may run **multiple workers** concurrently; the queue is designed for it
(atomic `FOR UPDATE SKIP LOCKED` claiming, per-job leases).

> **Requires PostgreSQL.** MySQL is not supported — the schema uses enums,
> partial unique indexes, `FOR UPDATE SKIP LOCKED` and `gen_random_uuid()`.
> Managed PostgreSQL (Neon, Supabase, RDS) works; see
> [Managed Postgres notes](#managed-postgres-neonsupabase) for the connection
> settings that matter.

---

## 0. Quick path: shared hosting (Hostinger / cPanel / StackCP) without Docker

> **Deploying to Hostinger? Follow [`HOSTINGER.md`](HOSTINGER.md)** — it has
> the exact hPanel steps, the environment-variable list, and how to run the
> worker there.

If your host has **"Setup Node.js App"** (Node ≥ 20.9) you can deploy without
Docker at all:

```bash
# 1. Build a self-contained bundle (server + worker + migrations)
npm run build:deploy
# -> produces ./deploy/  (a .env is stripped automatically)

# 2. Upload the CONTENTS of deploy/ to your account, e.g. ~/outreach
#    (File Manager or FTP)

# 3. In the panel, create the Node.js application
#      Application root:    outreach
#      Startup file:        server/server.js
#      Node version:        20.x or 22.x
#    Add a SECOND application (or a background process / cron job) for the
#    worker:
#      Startup file:        worker/index.cjs

# 4. Set the environment variables in the panel (see section 3)

# 5. Run the migration ONCE over SSH
cd ~/outreach && npx prisma migrate deploy

# 6. Point outreach.growthleder.com at the Node.js application
```

`deploy/README.txt` repeats these steps inside the bundle.

**If your host has no Node.js support** (typical PHP-only shared hosting), you
cannot run this application there — deploy to Vercel, Railway, Render, Fly.io
or a VPS instead.

---

## 1. Prerequisites

- PostgreSQL **14+** (16 recommended).
- Node.js **≥ 20.9** if you are not using Docker.
- A reverse proxy terminating TLS (nginx, Caddy, a cloud LB…).
- Optional: a Google Cloud OAuth client for Gmail senders
  (see [`GOOGLE_OAUTH.md`](GOOGLE_OAUTH.md)).

## 2. Generate production secrets

Never reuse development values.

```bash
openssl rand -base64 64   # AUTH_SECRET    (>= 32 chars)
openssl rand -base64 32   # ENCRYPTION_KEY (exactly 32 bytes → base64)
```

- `AUTH_SECRET` signs session cookies. Rotating it logs everyone out.
- `ENCRYPTION_KEY` encrypts provider tokens at rest. **Rotating it makes existing
  encrypted tokens unreadable** — reconnect sender accounts afterwards. Back it
  up alongside the database.

## 2b. Start in dry-run mode

Before any real email goes out, verify the whole pipeline without touching a
provider:

```dotenv
DRY_RUN="true"
```

With `DRY_RUN=true` (or a campaign created with the dry-run flag) the worker
renders every message, reserves and settles the quota as usual, and marks the
job as delivered — but **no email is ever handed to the provider** and no
follow-up is scheduled. The provider message id is prefixed `dry-run:` so the
UI can say so plainly.

Checklist before turning it off:

1. `GET /api/health` returns `{"status":"ok","database":"up"}`.
2. A connected sender account passes `POST /api/senders/test`.
3. `GET /api/campaigns/:id/preview` shows the message you expect, and the
   personalisation report has no unexpected gaps.
4. The campaign's sending window, time-zone policy and daily limit are right.
5. The suppression list and the unsubscribe link work (the preview contains a
   real `/api/unsubscribe` URL).

Then set `DRY_RUN="false"` and restart the worker.

---

## 2c. Client portal and tracking

### Create the client accounts

```bash
# In the app: Clients -> Add client
# ...or directly:
node -e "..."   # see /api/clients
```

Each client gets its own password (at least 10 characters). The client signs
in at `/portal/login` and only sees the campaigns an administrator assigns
to them.

### Assignment

`Clients -> Campaigns` assigns a campaign to a client. Assignment is
explicit and is the only access rule; a client with no assignment sees an
empty portal, and a request for somebody else's campaign returns 404.

### Tracking

Tracking is **off by default**. Enable it per campaign
(`Settings -> Track opens / Track clicks`). It works with any provider
because the pixel and the click redirect are served by this application — but
it measures what the recipient's mail client chooses to report, so the open
rate is an approximation.

The **Gmail API and plain SMTP do not report per-message delivery**, so the
"Delivered" figure shows as *not available* and the open/click rate uses
*sent (accepted by the provider)* as the denominator. That is stated on every
screen and in the CSV export — no number is ever invented.

See [`TRACKING.md`](TRACKING.md) for the full support matrix, the privacy
requirements and how to verify the tracking works.

---

## 3. Environment

Set at minimum:

```dotenv
NODE_ENV="production"
APP_URL="https://outreach.example.com"          # must be the public HTTPS URL
DATABASE_URL="postgresql://user:pass@db-host:5432/outreach?schema=public"
AUTH_SECRET="<64-byte base64>"
ENCRYPTION_KEY="<32-byte base64>"

SENDER_DAILY_CAP_DEFAULT="100"
SENDER_QUOTA_TIMEZONE="UTC"
MAX_SENDER_ACCOUNTS="10"
MIN_DAYS_BETWEEN_CONTACTS="3"

GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="https://outreach.example.com/api/google/callback"

WORKER_POLL_INTERVAL_MS="2000"
WORKER_BATCH_SIZE="20"
WORKER_LEASE_SECONDS="120"
WORKER_MAX_ATTEMPTS="5"
WORKER_BACKOFF_BASE_MS="5000"

RATE_LIMIT_ENABLED="true"
LOG_LEVEL="info"
```

`APP_URL` matters for more than links: it is the base of OAuth redirect URIs, the
unsubscribe URL in outgoing mail, and the CSRF origin check. If it is wrong,
unsubscribe links and OAuth will break. Add any extra trusted origins (e.g. an
alternate domain) to `EXTRA_ALLOWED_ORIGINS` as a comma-separated list.

## 4. Options

### 4a. Docker Compose (single host)

```bash
cp .env.example .env      # then edit with production values
docker compose up -d --build
```

Compose starts `db`, a one-shot `migrate` service, `app`, and `worker`. The
`app`/`worker` both wait for `migrate` to succeed.

### 4b. Docker image (your own orchestrator)

```bash
docker build -t email-outreach-platform:latest .
```

- Web container: `command: ["node", "server.js"]`, expose port 3000.
- Worker container: `command: ["node", "worker/index.cjs"]` (no port).
- Run migrations **once per release** before starting the new version:

  ```bash
  docker run --rm -e DATABASE_URL=... email-outreach-platform:latest \
    npx prisma migrate deploy
  ```

### 4c. Node directly (no Docker)

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build && npm run build:worker
node .next/standalone/server.js     # app
node dist/worker/index.cjs          # worker (separate process/service)
```

Use a process manager (systemd, PM2) so both roles restart on failure.

## 5. Database

- Create a dedicated database and role; grant only what is needed.
- **Apply migrations as a release step**, never with `prisma db push` in
  production: `npx prisma migrate deploy` is idempotent and recorded in
  `_prisma_migrations`.
- Back up the database on a schedule. The backup plus `ENCRYPTION_KEY` is
  everything you need to recover.
- Pooled providers (PgBouncer, Neon, Supabase) are fine for the app. Use an
  unpooled connection for migrations; if your provider needs it, set `DIRECT_URL`
  and uncomment `directUrl` in `prisma/schema.prisma`.

### Managed Postgres (Neon/Supabase)

Two settings matter, because managed providers **suspend idle instances** and
use a **transaction pooler**:

| Problem                                            | Fix                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `Can't reach database server` right after an idle period | Add `connect_timeout=30` (or more) to `DATABASE_URL`.                 |
| `Timed out fetching a new connection from the connection pool` | Add `pool_timeout=30`; avoid double-pooling (Prisma pool + PgBouncer). |

`src/lib/db.ts` injects `connect_timeout=60`, `pool_timeout=60` and
`socket_timeout=60` automatically if they are missing, and retries transient
connection errors (model operations and raw SQL) up to 3 times.

**Recommended connection strings**

```
# Long-running Node server: use the DIRECT endpoint (no double pooling)
postgresql://user:pass@host/db?sslmode=require&connect_timeout=60&pool_timeout=60

# Serverless / many instances: use the POOLED endpoint with pgbouncer=true
postgresql://user:pass@host-pooler/db?sslmode=require&connect_timeout=60&pgbouncer=true&connection_limit=5
```

**Use a separate database for the integration tests.** The test suite
`TRUNCATE`s every table before each test, so pointing `TEST_DATABASE_URL` at
the application database would delete your data.

```bash
# One-time: create the test database and migrate it
psql "$DATABASE_URL" -c 'CREATE DATABASE outreach_test;'
DATABASE_URL=".../outreach_test" npx prisma migrate deploy
```

### Session middleware and the Edge Runtime

The middleware runs in the **Edge Runtime**, where `process.env` values are
inlined at **build time**. It therefore does **not** verify the JWT signature
(it only decodes the payload and checks `exp`). This is intentional:

- It is a *convenience gate* (redirect pages to `/login`, return 401 for
  `/api/*`).
- **Every route handler re-validates the token signature and the
  `sessionVersion` against the database** (`src/lib/auth/guards.ts`), so a
  forged token can never reach data.

This keeps the app working when the bundle is built on one machine and the
secrets are injected on another — a common self-hosting scenario.

## 6. Health checks

`GET /api/health` returns the service status and database connectivity. Use it
for the app's liveness/readiness probe. The worker exposes **no** HTTP port —
supervise it by process liveness and its log output.

## 7. Scaling

- **App:** stateless; scale horizontally behind the load balancer. Sessions are
  signed cookies, and rate-limit counters live in Postgres, so any instance can
  serve any request.
- **Worker:** scale horizontally too. More workers simply claim more jobs; the
  queue guarantees no job is claimed twice. Tune `WORKER_BATCH_SIZE` and
  `WORKER_POLL_INTERVAL_MS` per worker.
- **Database:** the queue polls, so watch for connection pressure as you add
  workers. A pooler in front of Postgres helps.

## 8. Operations

### Ambiguous jobs

If a provider call times out **after** submission, the job is marked
`AMBIGUOUS` and is **never retried automatically** (a retry could send twice).
The worker attempts reconciliation via the provider (e.g. Gmail message lookup).
Jobs that cannot be reconciled stay `AMBIGUOUS` for manual resolution:

- Inspect them in **Queue** in the UI, or `GET /api/jobs`.
- Resolve via `POST /api/jobs/:id/resolve`.

Check the Queue page periodically; a growing set of `AMBIGUOUS` jobs usually
means provider latency, not a bug.

### Monitoring

- Logs are structured JSON-ish lines (see `src/lib/logger.ts`), gated by
  `LOG_LEVEL`. Ship them to your log platform.
- Watch: queue depth, `AMBIGUOUS` count, sender-account errors, and
  `SenderDailyUsage` vs. cap.
- Every sensitive action is in `AuditLog` and surfaced on the **Audit** page.

### Emergency stop

Each campaign has `emergencyStopped`; the worker refuses to send while it is
set. Pause individual sender accounts from the **Senders** page.

## 9. Upgrades

1. Back up the database.
2. Pull the new code / image.
3. Run `npx prisma migrate deploy`.
4. Roll the `app`, then the `worker` (either order is safe — old and new
   versions coexist during a rolling deploy because the schema is additive within
   a release).
5. If `ENCRYPTION_KEY` changed, reconnect all sender accounts.

## 10. CI

`.github/workflows/ci.yml` runs on every push/PR:

1. Lint (`npm run lint`).
2. Typecheck (`npm run typecheck`).
3. Unit tests (`vitest run tests/unit`).
4. Provision PostgreSQL, `prisma migrate deploy`.
5. Integration tests (`vitest run tests/integration`, gated on
   `TEST_DATABASE_URL`).
6. Build the app + worker bundle.
7. Build the Docker image.

Treat a green CI run as the gate for deploying.

## 11. Security checklist

- [ ] `AUTH_SECRET` and `ENCRYPTION_KEY` are unique, random, and backed up.
- [ ] `APP_URL` is HTTPS and matches the OAuth redirect URI exactly.
- [ ] TLS terminates at the proxy; the app is not exposed directly.
- [ ] Database is not publicly reachable; credentials are least-privilege.
- [ ] `RATE_LIMIT_ENABLED=true`.
- [ ] `.env` is never committed and is readable only by the service user.
- [ ] Backups are encrypted and tested with a restore.
