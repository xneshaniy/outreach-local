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
- [Client portal](#client-portal)
- [Pipeline & CRM](#pipeline--crm)
- [Notifications](#notifications)
- [Campaign pre-flight](#campaign-pre-flight)
- [Mock provider & dry run](#mock-provider--dry-run)
- [Open & click tracking](#open--click-tracking)
- [Tracking & provider support matrix](docs/TRACKING.md)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security notes](#security-notes)
- [What is verified and what is not](#what-is-verified-and-what-is-not)
- [Project layout](#project-layout)

---

## Features

### Multiple business services
- **Service profiles** — one per business line (lead generation, virtual
  assistance, CRM automation, email outreach, e-commerce, …). Each carries its
  own description, target industries, ideal customer profile, default subject,
  default body and call to action. Campaigns, templates and follow-up
  sequences can be linked to a service.
- Starter profiles are created on first visit and are fully editable.

### Contacts and leads
- Add, edit, view, search, filter, import (CSV wizard with column mapping) and
  **export** contacts.
- Store name, company, business email, website, role, **source**, **tags**,
  **notes** and consent basis.
- Duplicate detection is enforced by the database (`UNIQUE (userId, emailNormalized)`),
  including case- and dot-variant normalisation for Gmail-family domains.
- Invalid addresses are rejected; unknown time zones are held for review.
- Never send to a suppressed or unsubscribed contact.

### Campaigns
- Create, edit, **duplicate**, pause, resume, **archive** and cancel.
- Associate a campaign with a **service**, a **follow-up sequence** and a
  sender account; per-campaign subject, body and signature.
- Reusable templates with `{{variable}}` personalisation.
- **Message preview** rendered exactly as the worker will send it, plus a
  **personalisation coverage report** (which variables the audience cannot fill).
- **Test sends** and a **manual approval gate** before a campaign can start.
- Duplicate campaign sends to the same contact are impossible (database unique
  constraint).

### Sending
- Gmail (official API + OAuth 2.0) and any SMTP server. Credentials are
  encrypted at rest and read from environment variables.
- **Connection test** endpoint — a real connection/authentication check with a
  clear error message.
- Safe queue, per-sender rate limits, retry limits, exponential backoff with
  jitter, and delivery status tracking.
- Provider limits and temporary failures are handled gracefully.
- An email is **never** marked as sent unless the provider confirmed acceptance.
- A timeout after submission leaves the job `AMBIGUOUS` — it is never retried
  blindly, so the same message can never go out twice.
- **Dry-run mode** (global or per campaign): the whole pipeline runs, but no
  email ever reaches a provider and no quota is consumed. New campaigns start in
  dry run.

### Automated follow-ups
- Configurable sequences of steps with per-step delays.
- Follow-ups stop automatically when a contact replies, unsubscribes, bounces,
  complains, is suppressed, or when the campaign is paused/cancelled/archived.
- Each follow-up message tracks its scheduled time, status and failure reason.
- Scheduling is durable (stored in the database) and survives restarts.
- Sending windows and time zones apply to follow-ups too.
- Overlapping workers can never process the same job.

### Client portal
- **Separate client accounts** with their own login, password and dashboard
  (`/portal`). A client never sees the workspace owner's interface.
- **Explicit campaign assignment** — an administrator assigns campaigns to a
  client; a client sees only those, and nothing else.
- **Server-side access enforcement.** Every portal query is filtered by the
  assignment list, so another client's campaign cannot be reached through a
  URL, an export, an API call or a query parameter (a request for it returns
  404, never a hint that it exists).
- **Client-specific reports**: totals, per-campaign breakdown, daily charts,
  CSV export and a printable report — with date filters.
- Deactivating a client or changing their password ends their sessions
  immediately.

### Pipeline & CRM
- **Configurable lead stages** (New, Researched, Contacted, Replied, Qualified,
  Proposal, Client, Lost) with a pipeline board.
- **Priority, owner, tags, industry, notes and source** on every contact, plus
  a free-text note log.
- **Tasks and reminders** with a due date, and an overdue reminder.
- **Activity timeline** — every send, open, reply, unsubscribe, stage change
  and note in one chronological list per contact.
- **Prospect -> client conversion** that links the contact to the client account.
- **Saved audience segments** (stored filters) that can be reused for campaigns.
- **Bulk updates with a preview**: nothing is written until the operator has
  seen exactly which contacts change.

### Notifications
- In-app notifications for **replies**, **interested prospects**, **campaign
  completion/failure**, **provider disconnection**, **queue failures**,
  **dead-lettered messages**, **import completion** and **configuration
  problems**.
- Read/unread state and the full history, in a bell in the header.

### Campaign pre-flight
- A report run before a campaign starts: missing subject/body, missing
  unsubscribe link, placeholder or broken links, missing personalisation data,
  ineligible recipients (and exactly why), no connected sender.
- Blockers stop the campaign from starting; warnings and info do not.
- It sends nothing.

### Open & click tracking

> Which metrics each provider actually supports — see
> [`docs/TRACKING.md`](docs/TRACKING.md).
- **Opt-in per campaign** (`trackingEnabled` / `clickTrackingEnabled`) — off by
  default, so nothing is tracked without a decision.
- **Open tracking** adds a 1x1 tracking pixel whose URL carries a signed
  token; the token cannot be forged or guessed.
- **Click tracking** rewrites the links to a signed redirect; the unsubscribe
  link is never rewritten, so opting out always works.
- **Unique vs. total** are counted separately: the dedupe key is set only on
  the first event, so repeats are still recorded but do not inflate the
  unique count.
- **Automated traffic is classified** (HUMAN / PREVIEW / BOT) using the user
  agent and the source address; bots and known image proxies are excluded from
  the rates.
- **The rates are labelled as approximate everywhere.** Apple Mail Privacy
  Protection, image blocking and security scanners trigger tracking
  automatically — an open is never presented as proof that a person read the
  message.
- Metrics the provider does not report (delivery) are shown as **"not
  available"** rather than invented.

### Replies and inbox
- Real Gmail inbox polling (`users.messages.list` + `messages.get` using the
  `gmail.readonly` scope granted at connect time).
- Replies are matched to the **contact** and to the **campaign** that contacted
  them; the contact is marked `REPLIED` and their follow-ups are stopped.
- Replies can be classified (interested / not interested / needs info), marked
  read, and attached to a contact by hand.
- SMTP accounts cannot be polled — the UI says so plainly instead of pretending.

### Safety and deliverability
- Unsubscribe links (`List-Unsubscribe` + RFC 8058 one-click) and a suppression
  list (global and per-campaign).
- Hard bounces and complaints suppress the address automatically.
- Consent/lawful-basis tracking, sender identification, mailing details.
- Conservative, configurable sending limits (default 100/sender/day, never
  above the provider limit).
- No spam-filter evasion, no fake identities, no auto-sending to unverified
  scraped addresses. Large-scale sending is off by default (dry run).

### Under the hood
- **Multiple sender accounts** (up to `MAX_SENDER_ACCOUNTS`, default 10).
- **CSV import** with validation, per-row error reporting and de-duplication.
- **Recipient-local scheduling** — 09:00–17:00 Mon–Fri *in the recipient's own
  time zone* (DST-correct). Unknown zones are **held for review**, not guessed.
- **Database-enforced duplicate prevention** — `UNIQUE (campaignId, contactId)`.
- **Quota-aware sending** — per-sender daily caps, per-campaign daily limits and
  per-contact frequency limits, all reserved transactionally.
- **Crash-safe queue** — atomic claiming with `FOR UPDATE SKIP LOCKED`, leases,
  lease reclamation and exponential backoff with jitter.
- **Never-blind-retry** — a timeout *after* the provider accepted a message
  leaves the job `AMBIGUOUS` and requires reconciliation before any resend.
- **Lead pipeline & CRM** — configurable stages, priority, tasks, notes, an
  activity timeline, segments, bulk updates and prospect conversion.
- **In-app notifications** — replies, failures, provider problems, imports.
- **Pre-flight checks** — a campaign cannot start until it passes.
- **Mock email provider** — the whole pipeline runs without credentials.
- **Unified message status** — one vocabulary that never conflates "accepted"
  with "delivered".
- **Client portal** — separate client logins, explicit campaign assignment,
  server-enforced data isolation and client-specific reports.
- **Open & click tracking** — signed tracking pixel and link rewriting, unique
  vs. total counting, bot/preview classification, opt-in per campaign.
- **Security** — encrypted provider tokens at rest (AES-256-GCM), session
  cookies (HttpOnly, HMAC-signed JWT), CSRF origin checks, rate limiting and
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
| `DRY_RUN`                         | `false`                             | `true` = no email ever leaves the machine.                            |
| `TEST_DATABASE_URL`               | -                                   | **A separate database** - the test suite truncates every table.       |

> **Managed Postgres (Neon, Supabase, RDS).** These providers suspend idle
> instances. Add `connect_timeout=60&pool_timeout=60` to `DATABASE_URL` - the
> default 5-second timeout is shorter than a cold start. `src/lib/db.ts`
> injects these automatically and retries transient connection failures.

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
npm run test                 # all tests (integration auto-skips without a DB)
npx vitest run tests/unit    # unit tests only - no database required
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint
npm run build                # next build + prisma generate
npm run build:worker         # the background-worker bundle
npm run build:deploy         # a self-contained bundle for shared hosting
```

**Unit tests** (no database, 110 tests) cover the deterministic core: email
normalisation, crypto (AES-256-GCM), scheduling/DST maths, template rendering,
CSV parsing, retry/backoff classification, personalisation coverage analysis,
service slugs and the dry-run provider.

**Integration tests** (`tests/integration/**`, 108 tests) run against a real
PostgreSQL and are **opt-in**. They `TRUNCATE` every table before each test, so
**never** point them at the application database - use a separate one:

```bash
# 1. A dedicated test database (Postgres 14+)
psql "$DATABASE_URL" -c 'CREATE DATABASE outreach_test;'

# 2. Apply the schema to it
DATABASE_URL="postgresql://.../outreach_test" npx prisma migrate deploy

# 3. Run the suite
TEST_DATABASE_URL="postgresql://.../outreach_test?sslmode=require&connection_limit=20" \
  npx vitest run tests/integration
```

> **Do not point the test database at a transaction pooler.** The suite opens
> several transactions at once on purpose, and a pooler (Neon's `-pooler`
> host, PgBouncer) answers with *"Unable to start a transaction in the given
> time"* instead of running them. Use the **direct** endpoint and set
> `connection_limit` to at least 20. CI provisions a local PostgreSQL, so it
> is unaffected.

They cover: unique-constraint duplicate prevention, concurrent duplicate
imports, deterministic idempotency keys, disjoint concurrent claiming,
lease reclaim vs. ambiguous, per-attempt accounting, reschedule/cancel rules,
quota reservation under concurrency, tz-correct quota days, unsubscribe ->
suppression idempotency and forged-token rejection, authentication /
authorisation / session-invalidation / CSRF, plus the new features: service
profiles, follow-up scheduling and cancellation, reply matching and reply
stopping the follow-up chain, and dry-run mode (no provider call, no quota
consumed, no follow-ups scheduled).

**CI** (`.github/workflows/ci.yml`) provisions PostgreSQL, applies the
migrations and runs both suites plus the Docker build on every push.
## Deployment

**Going live?** Start with [`docs/GO-LIVE.md`](docs/GO-LIVE.md) — it is the
production checklist: what has to be true, the exact hosting build settings,
the environment variables, the dry-run gate, and the credentials that were
exposed and must be rotated.

**Hostinger (shared hosting)?** Follow [`docs/HOSTINGER.md`](docs/HOSTINGER.md)
— it has the exact hPanel settings, the environment variables, and the
migration step.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for everything else. The short
version:

1. Build the image: `docker compose build` (or `docker build -t eop .`).
2. Run `prisma migrate deploy` as a release step (the `migrate` service does it).
3. Run the **app** and at least one **worker** as separate, restartable
   services.
4. Set `APP_URL` to your public HTTPS URL, and regenerate `AUTH_SECRET` /
   `ENCRYPTION_KEY` for production.

**Without Docker:** `npm run build:host` builds a self-contained bundle in
`deploy/` (with the Prisma engine compiled for the machine it is built on),
and `node deploy/start.js` runs the web app and the sender worker together.

### One command to check everything

```bash
node scripts/validate-all.mjs          # everything
node scripts/validate-all.mjs --quick  # skip the long test suite
```

It runs the Prisma schema check, the migration status, the type check, the
lint, the unit and integration suites, the production build, the deployment
bundle and its completeness check, the secret scan, the log-leak scan, the
encoding scan, and a health/login/dashboard smoke test against the configured
database — then prints one summary.

`.github/workflows/ci.yml` lints, typechecks, runs the secret scan, runs unit
tests, spins up PostgreSQL, applies migrations, runs the integration suite,
builds the app and the deployment bundle, checks the bundle is complete, and
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
- **Nothing that can be used as a credential reaches the log.** The
  password-reset link is only logged in development, `logger.redact()` strips
  sensitive keys, and `logger.scrubMessage()` removes a URL query string, an
  OAuth code and any long opaque token from a free-text message.
  `scripts/check-log-leaks.cjs` fails the build if a logger call can write one.
- No secrets are committed; `.env`, `.env.*` (except the examples) are ignored,
  and `scripts/check-secrets.cjs` fails the build if a tracked file contains
  one.

## What is verified and what is not

**Verified by running it** (Windows, portable Node 22, real PostgreSQL on Neon):

- `npx tsc --noEmit` — clean.
- `npx eslint .` — clean.
- `npx vitest run` — **218/218 tests pass** (110 unit + 108 integration against a
  real PostgreSQL database).
- `npx prisma migrate deploy` — applies the committed migration to a live
  database.
- `npx tsx prisma/seed.ts` — seeds the demo workspace.
- `npx next build` — succeeds (all routes).
- `npm run build:worker` — produces the worker bundle.
- `npm run build:deploy` — produces a self-contained deployment bundle.
- The built bundle was **started and exercised end to end**: login, session
  cookie, `/api/auth/me`, `/api/campaigns`, `/api/jobs`, `/dashboard`,
  `/api/health`, and the background worker all behaved correctly against the
  live database.

**Not verified here** (needs credentials or Docker):

- The end-to-end Gmail OAuth flow and any real send (no Google credentials, no
  network egress to Google). The code is complete and the error paths are
  handled; it has simply never talked to Google's servers.
- The Docker image build (no Docker daemon in this environment). The Dockerfile
  is exercised by CI on every push.

These are also exercised by CI (`.github/workflows/ci.yml`), which provisions
PostgreSQL. If you run them locally and something fails, it is a real bug — fix
it rather than assuming the code is right.

## Design system

Every screen is built from one set of primitives, so the product reads as a
single product rather than a set of screens.

**Tokens** (`src/app/globals.css`) — one accent colour, a soft neutral canvas,
white surfaces, deep navy text, and one radius / shadow / spacing scale. Dark
mode is a token swap, not a second design.

**Components** (`src/components/ui/index.tsx`) — `Button`, `Card`, `StatCard`,
`Input`, `Textarea`, `Select`, `Checkbox`, `Field`, `Badge`, `StatusBadge`,
`Table`, `Pagination`, `Modal`, `ConfirmDialog`, `Tabs`, `Menu`, `Tooltip`,
`InfoHint`, `ProgressBar`, `Skeleton`, `EmptyState`, `ErrorState`, `Note`.

**Charts** (`src/components/charts.tsx`) — dependency-free SVG: `LineChart`,
`BarChart`, `DonutChart`, `Sparkline`. They draw only the data they are given;
an empty dataset renders an explicit empty state rather than a flat line.

**Rules the whole UI follows**

- One accent colour, used only for the primary action.
- Semantic colours only for meaning (success / warning / danger / info).
- A metric the system cannot know is shown as **"Not available"** — never as
  zero, and never invented.
- Estimated metrics (open rate) are labelled as estimates wherever they appear.
- Every control is keyboard reachable, labelled, and has a visible focus ring.
- Exactly one `<h1>`, one `<main>` and one `<nav>` per page.
- `prefers-reduced-motion` is respected.

**Responsive behaviour** — the sidebar is fixed on desktop and becomes a
slide-in drawer below 1024px; tables scroll horizontally inside their card
instead of breaking the layout; the wizard stacks into a single column; modals
become bottom sheets on small screens.

## Project layout

```
src/
  app/                 Next.js App Router
    api/               Route handlers (REST)
    (app)/             Dashboard pages: services, campaigns, contacts,
                       follow-ups, replies, clients, senders, templates, queue,
                       analytics, suppressions, settings, audit
    portal/            The client portal (separate login + reports)
  lib/
    auth/              password hashing, sessions, guards
    email/             provider abstraction, gmail, smtp, dry-run, reply poller
    scheduling.ts      recipient-local window / DST maths
    queue.ts           PostgreSQL job queue (atomic claim, leases, follow-ups)
    quota.ts           transactional quota reservation
    suppression.ts     suppression checks
    followup.ts        follow-up sequences: schedule, cancel, advance
    replies.ts         reply matching, recording, and their side effects
    services.ts        service profiles (one per business line)
    personalization.ts personalisation coverage analysis
    tracking.ts        open/click tracking: signed tokens, pixel, bot detection
    metrics.ts         campaign performance metrics and the daily series
    portal.ts          client-portal access helpers (the single access check)
    pipeline.ts        lead stages, conversion
    activity.ts        the contact activity timeline and notes
    notifications.ts   in-app notifications
    preflight.ts       the campaign pre-flight report
    segments.ts        saved audience filters
    link-check.ts      static link validation (never makes a network call)
    message-status.ts  the unified message-status vocabulary
    provider-capabilities.ts  what each provider can and cannot report
    email/mock.ts      the mock provider (no network)
    crypto.ts          AES-256-GCM helpers
    env.ts             validated environment
  worker/              background sender + reconciliation
prisma/
  schema.prisma        data model & constraints
  migrations/          committed SQL migrations
  seed.ts              idempotent demo seed
scripts/
  build.mjs             the production build (prisma + worker + app)
  build-deploy.mjs      self-contained bundle for shared hosting
  build-on-host.mjs     build on the target server (correct native binaries)
  build-on-host.sh      the same, as a shell wrapper
  check-secrets.cjs     fail if a tracked file contains a secret
  check-log-leaks.cjs   fail if a logger call can write a credential
  check-encoding.cjs    find encoding damage in the source
  check-omit-dev.cjs    what a production-only install leaves out
  check-input-validation.cjs  malformed input must be a 4xx, never a 5xx
  clean-build-test.ps1  clone, install, build and start, exactly like a host
  simulate-hosting-install.cjs  the hosting panel's case: a production-only
                         install followed by the build
  simulate-hostinger.ps1  verify the bundle starts in every hosting layout
  validate-all.mjs      the whole gate in one command
  production-safety-check.cjs  unauthorised access, forged tokens, CSRF, dry run
  e2e-supabase-check.cjs  health, login and API smoke test
  export-postgres-dump.mjs  portable SQL dump of the live database
  generate-supabase-bootstrap.mjs  SQL script that builds the schema in the
                         Supabase SQL Editor (no database password needed)
  verify-supabase-bootstrap.cjs  proves that script matches `migrate deploy`
  provision-supabase.mjs  set the database password, find the pooler format
  set-db-password.mjs   set the database password to a given value
  seed-supabase.mjs     migrate and seed the demo workspace
  audit-supabase-schema.mjs  what the database actually contains
  verify-supabase-schema.mjs  check it against the Prisma schema
  rotate-app-secrets.mjs  rotate AUTH_SECRET / ENCRYPTION_KEY safely
  diagnose-hostinger-mcp.mjs  why the Hostinger MCP is refusing to talk
tests/
  unit/                no-database unit tests
  integration/         opt-in, real-PostgreSQL tests
docs/                  architecture, API, deployment, Google OAuth
```

## License

Provided as-is for internal/self-hosted use. Review your local anti-spam and
privacy regulations before sending to real recipients.
