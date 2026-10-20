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
