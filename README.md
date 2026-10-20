# Email Outreach Platform

A production-oriented, self-hosted cold-email / outreach platform. It sends
personalised email from one or more Gmail or SMTP sender accounts, imports
contacts from CSV, and schedules every message into the **recipient's own local
business hours**.

The design goal is *correctness under concurrency and failure*: duplicates are
prevented by the database, quota is never exceeded, and a message that may or
may not have been sent is never blindly retried.

> **Status honesty.** Everything below is implemented and covered by unit tests
> or integration tests. See [What is verified](#what-is-verified-and-what-is-not)
> for the parts that could not be executed in this development environment
> (they are written and lint-clean, but run for real only in CI / on your
> machine with Docker).

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start (local, no Docker)](#quick-start-local-no-docker)
- [Quick start (Docker Compose)](#quick-start-docker-compose)
- [Environment variables](#environment-variables)
- [Connecting Gmail (OAuth)](#connecting-gmail-oauth)
- [Connecting SMTP](#connecting-smtp)
- [The worker](#the-worker)
- [Database design & duplicate prevention](#database-design--duplicate-prevention)
- [Scheduling model](#scheduling-model)
- [Compliance](#compliance)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security notes](#security-notes)
- [What is verified and what is not](#what-is-verified-and-what-is-not)
- [Project layout](#project-layout)

---

## Features

- **Multiple sender accounts** (up to `MAX_SENDER_ACCOUNTS`, default 10) per
  workspace — Gmail via the official API + OAuth 2.0, or any SMTP server.
- **CSV contact import** with validation, per-row error reporting and
  de-duplication.
- **Campaigns** with templates, `{{first_name}}`-style variables, an
  unsubscribe link, and pause/resume/emergency-stop.
- **Recipient-local scheduling.** Each message is timed to 09:00–17:00 on
  Mon–Fri *in the recipient's time zone* (DST-correct). Recipients with an
  unknown or invalid time zone are **held for review**, not guessed.
- **Database-enforced duplicate prevention.** A contact can belong to a
  campaign exactly once, forever — enforced with `UNIQUE (campaignId, contactId)`.
- **Quota-aware sending.** Per-sender daily caps (default 100/day), per-campaign
  daily limits, and per-contact frequency limits, all reserved transactionally.
- **Crash-safe queue.** Atomic claiming with `FOR UPDATE SKIP LOCKED`, leases and
  lease reclamation, and exponential backoff with jitter.
- **Never-blind-retry.** A timeout *after* the provider accepted a message leaves
  the job `AMBIGUOUS` and requires reconciliation before any resend.
- **Compliance:** one-click unsubscribe (`List-Unsubscribe` + RFC 8058), a
  suppression list (global and per-campaign), bounce/complaint webhook handling,
  consent tracking, and an audit log.
- **Security:** encrypted provider tokens at rest (AES-256-GCM), session
  cookies (HttpOnly, HMAC-signed JWT), CSRF origin checks, rate limiting, and
  header-injection guards.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture. In brief:

```
┌────────────┐      ┌──────────────────┐      ┌───────────────┐
│  Browser   │─────▶│  Next.js (app)   │─────▶│  PostgreSQL   │
│  (React)   │      │  App Router +    │      │  (Prisma)     │
└────────────┘      │  Route Handlers  │      └───────┬───────┘
                    └──────────────────┘              │  claims jobs
                                                       │  (SKIP LOCKED)
                                            ┌──────────▼──────────┐
                                            │   Worker process     │
                                            │  queue + providers   │
                                            └──────────┬──────────┘
                                                       │
                                        ┌──────────────┴──────────────┐
                                        │  Gmail API   /   SMTP        │
                                        └──────────────────────────────┘
```

The queue is **PostgreSQL only** — no Redis or other broker. The web app and one
or more workers can scale independently; correctness does not depend on there
being exactly one worker.

## Quick start (local, no Docker)

Requirements: **Node.js ≥ 20.9** and a **PostgreSQL** database.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# then edit .env and set:
#   DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY
#   Generate secrets:
#     openssl rand -base64 64   # AUTH_SECRET
#     openssl rand -base64 32   # ENCRYPTION_KEY

# 3. Create the schema
npx prisma migrate deploy     # apply committed migrations
# (or `npm run db:migrate` while iterating on the schema)

# 4. Generate the Prisma client (also done by `npm run build`)
npx prisma generate

# 5. (optional) Seed a demo workspace
SEED_USER_EMAIL=owner@example.com SEED_USER_PASSWORD='ChangeMe123!' npm run db:seed

# 6. Run the web app
npm run dev                   # http://localhost:3000

# 7. Run the worker (separate terminal) — this is what actually sends email
npm run worker
```

Register at `/register`, or log in with the seeded account.

## Quick start (Docker Compose)

```bash
# Put real values for AUTH_SECRET / ENCRYPTION_KEY in a `.env` file first.
cp .env.example .env

docker compose up --build
```

This starts four services:

| Service   | Purpose                                                        |
| --------- | -------------------------------------------------------------- |
| `db`      | PostgreSQL 16 with a persistent volume.                        |
| `migrate` | One-shot `prisma migrate deploy`, runs before app & worker.    |
| `app`     | Next.js server on <http://localhost:3000>.                      |
| `worker`  | Background sender (same image, `node worker/index.cjs`).        |

## Environment variables

All variables are validated at startup (see [`src/lib/env.ts`](src/lib/env.ts)).
In production, a missing required secret throws immediately. See
[`.env.example`](.env.example) for the annotated list. The essentials:

| Variable                          | Default                             | Notes                                                                 |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                    | —                                   | PostgreSQL connection string.                                         |
| `APP_URL`                         | `http://localhost:3000`             | Used for OAuth redirects, unsubscribe links, CSRF origin checks.       |
| `AUTH_SECRET`                     | — (dev fallback)                    | ≥ 32 chars. Signs session cookies.                                    |
| `ENCRYPTION_KEY`                  | — (dev fallback)                    | base64 of exactly 32 bytes. Encrypts provider tokens.                 |
| `SENDER_DAILY_CAP_DEFAULT`        | `100`                               | Hard per-sender daily cap. Only ever *lower* provider limits.          |
| `SENDER_QUOTA_TIMEZONE`           | `UTC`                               | Time zone used to roll over daily counters.                           |
| `MAX_SENDER_ACCOUNTS`             | `10`                                | Sender-account limit per workspace.                                   |
| `MIN_DAYS_BETWEEN_CONTACTS`       | `3`                                 | Default contact-frequency limit.                                      |
| `WORKER_*`                        | see `.env.example`                  | Poll interval, batch size, lease, attempts, backoff.                  |
| `GOOGLE_*`                        | —                                   | Gmail OAuth client + redirect URI + scopes.                           |

## Connecting Gmail (OAuth)

1. In **Google Cloud Console → APIs & Services**, enable the **Gmail API**.
2. Configure the **OAuth consent screen** (External; add yourself as a test user
   while in testing mode).
3. Create an **OAuth client ID** of type *Web application* and add the redirect
   URI `http://localhost:3000/api/google/callback` (or your `${APP_URL}` value).
4. Put the client ID/secret in `.env` and restart.
5. In the app, go to **Senders → Connect Google**, choose the account, and grant
   the requested scopes.

Details, including the exact scopes and the refresh-token flow, are in
[`docs/GOOGLE_OAUTH.md`](docs/GOOGLE_OAUTH.md). **Tokens are encrypted at rest
and are never returned by any API.**

## Connecting SMTP

Go to **Senders → Connect SMTP** and provide host, port, security mode, username
and password. The password is encrypted before it is written to the database.
Usable for services like Amazon SES, Postmark, Mailgun, or your own MTA.

## The worker

The worker (`src/worker/index.ts`) is a separate process. Every cycle it:

1. **Reclaims abandoned jobs** — claims whose lease expired (a crashed worker);
   sets them back to `QUEUED`, or to `AMBIGUOUS` if a provider call may have
   been in flight.
2. **Claims due jobs** atomically and processes each one.
3. **Reconciles ambiguous jobs** (bounded per cycle).

Run it with `npm run worker` in development, or `npm run worker:dev` to reload
on change. In Docker it is the `worker` service. You can run several workers
concurrently.

## Database design & duplicate prevention

The guarantees live in the schema and raw SQL, not in application code
(see [`prisma/schema.prisma`](prisma/schema.prisma)):

| Rule                                             | Enforced by                                                   |
| ------------------------------------------------ | ------------------------------------------------------------ |
| One contact per (user, email)                    | `UNIQUE (userId, emailNormalized)`                            |
| One contact per campaign, **ever**               | `UNIQUE (campaignId, contactId)` on `CampaignRecipient`       |
| One job per recipient                            | `UNIQUE (campaignRecipientId)` + deterministic `idempotencyKey` |
| One accounting row per attempt                   | `UNIQUE (jobId, attemptNumber)`                               |
| One suppression per (scope, target, email)       | Partial unique indexes in the SQL migration                    |
| Never two workers on one job                     | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`       |
| Never exceed the daily cap                       | Row-locked counter reservation in the same transaction         |

Email addresses are normalised before comparison (lowercased, trimmed;
`googlemail.com` folded to `gmail.com`; Gmail dot/plus-tags stripped only for
Gmail-family domains).

## Scheduling model

- Each campaign defines a local sending window (default **09:00–17:00**) and
  sending days (default **Mon–Fri**).
- For each recipient the platform computes the next UTC instant that falls
  inside *that recipient's* local window, using their IANA time zone. DST
  transitions are handled by recomputing from local wall-clock parts.
- Recipients with an **unknown or invalid** time zone are set to `HELD_TZ` and
  are **not sent**. The campaign may opt into a fallback zone
  (`timeZoneFallback: FALLBACK` + `fallbackTimeZone`).

## Compliance

- **Unsubscribe:** every message carries a `List-Unsubscribe` /
  `List-Unsubscribe-Post` header (RFC 8058) and an in-body link. `POST
  /api/unsubscribe` is idempotent and forgery-proof (HMAC token bound to the
  contact and campaign).
- **Suppression:** unsubscribes, bounces and complaints create `Suppression`
  rows; the worker checks them before sending. Suppression is global and/or
  campaign-scoped.
- **Consent:** `Contact.consentAt` / `consentSource` record the lawful basis.
- **Audit:** every meaningful action is written to `AuditLog`.
- **Webhooks:** `POST /api/webhooks/gmail` ingests bounce/complaint events with
  provider-id-based idempotency.

## API

Full reference: [`docs/API.md`](docs/API.md). Route handlers live under
`src/app/api/**`. Highlights:

| Method & path                              | Purpose                                  |
| ------------------------------------------ | ---------------------------------------- |
| `POST /api/auth/register`, `/login`, `/logout` | Session management (cookie-based).   |
| `GET /api/auth/me`                          | Current user.                           |
| `GET/POST /api/senders`                     | List / create sender accounts.          |
| `POST /api/google/connect`, `/callback`     | Gmail OAuth.                            |
| `GET/POST /api/contacts`, `POST /api/contacts/import` | Contacts & CSV import.        |
| `GET/POST /api/campaigns`                   | Campaign CRUD.                          |
| `POST /api/campaigns/:id/{start,pause,resume,schedule,test-send,duplicate}` | Lifecycle. |
| `GET /api/jobs`, `POST /api/jobs/:id/resolve` | Queue inspection & ambiguous resolution. |
| `GET /api/suppressions`, `/analytics`, `/audit` | Reporting.                          |
| `POST /api/unsubscribe`                     | Public one-click unsubscribe.           |
| `POST /api/webhooks/gmail`                  | Provider event ingestion.               |
| `GET /api/health`                           | Liveness/readiness.                     |

Mutating endpoints accept an optional `Idempotency-Key` header; replays with the
same key and body return the original response.

## Testing

```bash
npm run test            # all tests (integration auto-skips without a DB)
npx vitest run tests/unit   # unit tests only — no database required
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run build           # next build + prisma generate
```

**Unit tests** (no database) cover the deterministic core: email
normalisation, crypto (AES-256-GCM), scheduling/DST maths, template rendering,
CSV parsing, and retry/backoff classification.

**Integration tests** (`tests/integration/**`) run against a real PostgreSQL and
are **opt-in**. They `TRUNCATE` every table before each test, so never point
them at production:

```bash
docker compose up -d db
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/outreach_test?schema=public" \
  npx prisma migrate deploy
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/outreach_test?schema=public" \
  npx vitest run tests/integration
```

They cover: unique-constraint duplicate prevention, concurrent duplicate
imports, deterministic idempotency keys, disjoint concurrent claiming,
lease reclaim vs. ambiguous, per-attempt accounting, reschedule/cancel rules,
quota reservation under concurrency, tz-correct quota days, unsubscribe →
suppression idempotency and forged-token rejection, and authentication /
authorisation / session-invalidation / CSRF.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The short version:

1. Build the image: `docker compose build` (or `docker build -t eop .`).
2. Run `prisma migrate deploy` as a release step (the `migrate` service does it).
3. Run the **app** and at least one **worker** as separate, restartable
   services.
4. Set `APP_URL` to your public HTTPS URL, and regenerate `AUTH_SECRET` /
   `ENCRYPTION_KEY` for production.

`.github/workflows/ci.yml` lints, typechecks, runs unit tests, spins up
PostgreSQL, applies migrations, runs the integration suite, builds the app, and
builds the Docker image.

## Security notes

- Provider tokens and SMTP passwords are encrypted with AES-256-GCM and are
  never serialised to API responses.
- Session cookies are HttpOnly, `SameSite=Lax`, `Secure` in production, and
  carry a `sessionVersion` that can be bumped to invalidate every session.
- State-changing requests verify the `Origin` header (CSRF).
- Header values are sanitised against CRLF injection before they reach a
  provider.
- Rate limiting is a fixed-window counter stored in Postgres so it works across
  instances.
- No secrets are committed; `.env`, `.env.*` (except the examples) are ignored.

## What is verified and what is not

**Verified in this environment** (Windows, portable Node 22, no local Postgres):

- `npx tsc --noEmit` — clean.
- `npx eslint .` — clean.
- `npx vitest run tests/unit` — all unit tests pass.
- `npx next build` — succeeds (all routes).
- `npm run build:worker` — produces the worker bundle.

**Written but not executed here** (need a real PostgreSQL / Docker):

- `prisma migrate deploy` and the seed script against a live database.
- The entire `tests/integration/**` suite (it skips automatically when
  `TEST_DATABASE_URL` is unset — which is why `npm run test` is green locally).
- The end-to-end Gmail OAuth flow and any real send (no credentials, no network
  egress to Google).

These are exercised by CI (`.github/workflows/ci.yml`), which provisions
PostgreSQL. If you run them locally and something fails, it is a real bug — fix
it rather than assuming the code is right.

## Project layout

```
src/
  app/                 Next.js App Router
    api/               Route handlers (REST)
    (dashboard pages)  Senders, contacts, campaigns, queue, analytics, …
  lib/
    auth/              password hashing, sessions, guards
    email/             provider abstraction, gmail, smtp
    scheduling.ts      recipient-local window / DST maths
    queue.ts           PostgreSQL job queue (atomic claim, leases)
    quota.ts           transactional quota reservation
    suppression.ts     suppression checks
    crypto.ts          AES-256-GCM helpers
    env.ts             validated environment
  worker/              background sender + reconciliation
prisma/
  schema.prisma        data model & constraints
  migrations/          committed SQL migrations
  seed.ts              idempotent demo seed
tests/
  unit/                no-database unit tests
  integration/         opt-in, real-PostgreSQL tests
docs/                  architecture, API, deployment, Google OAuth
```

## License

Provided as-is for internal/self-hosted use. Review your local anti-spam and
privacy regulations before sending to real recipients.
