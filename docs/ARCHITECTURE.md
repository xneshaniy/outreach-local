# Architecture

Email Outreach Platform — Next.js (App Router) + TypeScript + Tailwind v4 + Prisma/PostgreSQL,
with a separate background worker process. There is **no Redis or external queue**: the job
queue, rate limiter, idempotency store and quota accounting all live in PostgreSQL.

## 1. Components

```
                 HTTPS
   ┌───────────────────────────────┐
   │  Browser (React app + client) │
   └───────────────┬───────────────┘
                   │  session cookie (eop_session, HttpOnly)
                   ▼
   ┌─────────────────────────────────────────┐        ┌────────────────────────┐
   │  App server — Next.js App Router        │        │  External providers    │
   │  • src/middleware.ts (edge auth gate)   │        │  • Gmail API (OAuth2)  │
   │  • src/app/api/**/route.ts (REST API)   │        │  • SMTP (nodemailer)   │
   │  • src/lib/** (auth, quota, scheduler,  │        │  • Google Pub/Sub push │
   │    crypto, providers, validation)       │        └───────────┬────────────┘
   └───────────────┬─────────────────────────┘                   │ webhook
                   │ Prisma Client                               ▼
                   ▼                          src/app/api/webhooks/gmail/route.ts
   ┌─────────────────────────────────────────────────────────────┐
   │  PostgreSQL  (Prisma schema: prisma/schema.prisma)          │
   │  users, senders, campaigns, contacts, recipients, send jobs,│
   │  attempts, daily usage, suppressions, webhook events,       │
   │  audit logs, rate limits, idempotency keys                  │
   └───────────────▲─────────────────────────────────────────────┘
                   │ prisma (FOR UPDATE SKIP LOCKED claims)
   ┌───────────────┴─────────────────────────────────────────────┐
   │  Background worker — src/worker/index.ts                    │
   │  loop: reclaim leases → claim due jobs → process            │
   │        → reconcile AMBIGUOUS jobs                           │
   └─────────────────────────────────────────────────────────────┘
```

| Component | Entry point | Responsibility |
|---|---|---|
| App server | `src/app/api/**/route.ts` | Auth, CRUD, campaign management, enqueue, public endpoints |
| Edge middleware | `src/middleware.ts` | Redirects unauthenticated page requests to `/login`; returns 401 JSON for `/api/*` |
| Worker | `src/worker/index.ts` → `src/worker/processJob.ts` | Claims and sends jobs; crash recovery; ambiguity reconciliation |
| Database | `prisma/schema.prisma` | Single source of truth, including all uniqueness/idempotency constraints |
| Service profiles | `src/lib/services.ts` | One profile per business line; campaigns/templates/sequences link to one. |
| Follow-up engine | `src/lib/followup.ts` | Schedules the next step after a delivery; cancels on reply/unsubscribe/bounce/pause. |
| Reply tracking | `src/lib/replies.ts`, `src/lib/email/reply-poller.ts` | Matches a reply to a contact + campaign and applies its side effects. |
| Personalisation analysis | `src/lib/personalization.ts` | Reports which template variables the audience cannot fill in. |
| Dry-run provider | `src/lib/email/dry-run.ts` | Renders a message without contacting a provider. |
| Tracking | `src/lib/tracking.ts` | Signed open/click tokens, the pixel, link rewriting and bot detection. |
| Performance metrics | `src/lib/metrics.ts` | Campaign metrics and the daily series, computed from real rows only. |
| Client portal | `src/lib/portal.ts`, `src/lib/auth/client-session.ts` | Client sessions and the single place access is decided. |
| Client helper | `src/lib/client/api.ts` | Browser-side fetch wrapper (`apiFetch`) |

## 1b. Feature pipeline: services, follow-ups, replies, dry run

### Service profiles
A `Service` is one business line (lead generation, virtual assistance, CRM
automation, email outreach, e-commerce). It carries the description, target
industries, ideal customer profile, default subject/body and call to action.
`Campaign`, `EmailTemplate` and `FollowUpSequence` reference it with
`ON DELETE SET NULL`, so removing a service never deletes work.

### Follow-up sequences
`FollowUpSequence` -> `FollowUpStep` (position, delay in days, subject, body).

The scheduler is **pull-based and durable**:

1. The campaign references a sequence (`Campaign.followUpSequenceId`).
2. After the first email of that campaign is **accepted by the provider**, the
   worker calls `advanceFollowUp()`, which finds the first step with no
   message for that contact and calls `scheduleNextFollowUp()`.
3. `scheduleNextFollowUp()` re-checks eligibility (contact status, suppression
   list, frequency limit), computes `now + delayDays` and clamps the result
   into the **recipient's own local sending window**, then writes a
   `FollowUpMessage` and a `SendJob` of kind `FOLLOW_UP`.
4. The job's idempotency key is `followup:<followUpMessageId>`, so the same
   step can never be delivered twice.

Cancellation is central, not best-effort: `cancelFollowUpsForContact`,
`cancelFollowUpsForCampaign` and `cancelFollowUpsForContactEverywhere` flip
the pending messages to `CANCELLED` **and** cancel their queued jobs. They run
when a contact replies, unsubscribes, bounces, complains, is manually
suppressed, or when the campaign is paused / cancelled / archived.

### Reply handling
A reply is matched to a contact by the normalised sender address and to a
campaign by the most recent `SENT` job for that contact. Recording it:

- marks the contact `REPLIED` (unless it is unsubscribed/bounced/complained),
- increments `repliedCount` and sets `lastRepliedAt`,
- cancels the contact's queued jobs (never email somebody who answered),
- cancels the contact's pending follow-ups.

Gmail accounts are polled with the real API (`users.messages.list` +
`users.messages.get`) using the refresh token granted at connect time — the
`gmail.readonly` scope is requested for exactly this. SMTP accounts cannot be
polled; that limitation is reported in the API response (`pollSupported`) and
shown in the UI rather than hidden.

### Dry run
`DRY_RUN=true` (environment) or `Campaign.dryRun` (per campaign) swaps the
provider for `dryRunProvider`. The pipeline is otherwise identical, but:

- no provider call is made,
- the quota is **not** reserved (a test must not eat the real budget),
- the job is marked `dryRun` and its provider message id is prefixed
  `dry-run:` so the UI can say plainly that nothing was delivered,
- no follow-up is scheduled (the chain only starts after a real delivery).

New campaigns are created in dry-run mode, so a fresh install cannot send
anything until the operator turns it off.

## 1c. Client portal and tracking

### Client portal

A `Client` is a separate account from the workspace owner. It has its own
password hash, its own session cookie (`eop_client_session`), its own JWT
issuer (`email-outreach-client`) and its own `sessionVersion`. A client token
can never be mistaken for an owner token.

`ClientCampaignAccess` is the **only** access rule: a client sees a campaign
if and only if there is a row linking it. `src/lib/portal.ts` resolves that
list once per request and every portal query is filtered by it, so:

- another client's campaign returns **404** (not 403 — no existence leak),
- exports and printable reports are filtered the same way,
- a URL that guesses an id cannot widen the scope.

The portal API is separate from the owner API (`/api/portal/*`), and the Edge
middleware does not gate it with the owner cookie — the portal's own guard does
that on the server.

### Tracking

`TrackingEvent` stores every open and click. `dedupeKey` is set **only on
the first event of its kind** (open per recipient, click per recipient+link).
A Postgres unique index allows many NULLs, so repeats are recorded for the
total without inflating the unique count.

- The pixel URL and the click URL carry an **HMAC-signed token** binding the
  campaign, the recipient and (for clicks) the target URL. A forged token is
  ignored, and a click token cannot be replayed as an open.
- The unsubscribe link is **never** rewritten by click tracking.
- Every event is classified `HUMAN`, `PREVIEW` or `BOT` from the user
  agent and the source address. Bots and known image proxies are excluded from
  the unique counts.
- `SendJob.deliveredAt` records a provider-confirmed delivery. It stays NULL
  when the provider does not report it — the reporting layer then says
  "not available" and uses *sent* as the rate denominator, rather than
  inventing a number.

## 2. Request flow

For a typical authenticated API call (`GET /api/campaigns`):

```
NextRequest
  → src/middleware.ts            verify eop_session JWT (signature only, edge)
  → route handler (handleApi wrapper, src/lib/http.ts)
      → assertSameOrigin(req)    state-changing requests only (CSRF)
      → requireUser()            src/lib/auth/guards.ts
          → readSessionToken()   src/lib/auth/session.ts  (JWT verify)
          → prisma.user.findUnique + sessionVersion match
      → enforceRateLimit(...)    src/lib/ratelimit.ts     (fixed window, Postgres)
      → zod.parse(...)           src/lib/validation.ts    (or inline schema)
      → prisma.*                 src/lib/db.ts
      → audit(prisma, {...})     src/lib/audit.ts
  → json(payload)                NextResponse.json
```

Error handling is centralized by `handleApi` (`src/lib/http.ts`):

* `ApiError` → `{ error: { code, message, details? } }` with its status.
* `ZodError` → 400 `{ error: { code: "VALIDATION", message, details: [{path,message}] } }`.
* anything else → 500 `{ error: { code: "INTERNAL", message: "Internal server error." } }`
  (details logged, never returned).

Error constructors and codes live in `src/lib/errors.ts`: `BAD_REQUEST` (400),
`UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409),
`RATE_LIMITED` (429), `INTERNAL` (500).

Middleware is a convenience gate only; every route re-validates the session
server-side through `requireUser()`. Public paths (bypass the middleware gate):
`/login`, `/register`, `/api/auth/login`, `/api/auth/register`, `/api/unsubscribe`,
`/api/webhooks`. `GET /api/health` is intentionally not session-protected.

## 3. Auth model

Defined in `src/lib/auth/session.ts`, `src/lib/auth/guards.ts`,
`src/lib/auth/password.ts`, `src/lib/ratelimit.ts`, `src/lib/http.ts`.

* **Session token**: stateless JWT (HS256, `jose`), issuer `email-outreach-platform`,
  payload `{ sub: userId, email, sv: sessionVersion }`, TTL `SESSION_TTL_SECONDS`
  (default 604800 s).
* **Cookie**: `eop_session` — `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  `path=/`.
* **sessionVersion**: embedded in the token and compared with `User.sessionVersion`.
  Bumping the row invalidates all outstanding tokens ("log out everywhere").
  Registration issues `sv: 0`; login issues the current DB value.
* **Passwords**: bcrypt (`src/lib/auth/password.ts`), with a policy check at
  registration/enforcement points.
* **CSRF**: `assertSameOrigin` compares the `Origin` (or `Referer`) header to
  `APP_URL` plus `EXTRA_ALLOWED_ORIGINS`; non-browser clients without either header
  are allowed (`SameSite=Lax` still protects browser requests).
* **Rate limiting** (`enforceRateLimit`): fixed-window counter in the `RateLimit`
  table using `INSERT ... ON CONFLICT DO UPDATE`, so it is correct across instances.
  Key builders: `authLimitKey(kind, identifier)` and `apiLimitKey(userId, endpoint)`.
  Defaults: auth 10 / 60 s, API 120 / 60 s (`RATE_LIMIT_ENABLED`,
  `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_SECONDS`, `RATE_LIMIT_API_MAX`,
  `RATE_LIMIT_API_WINDOW_SECONDS` in `src/lib/env.ts`).
* **Authorization**: `requireUser()`, `requireCampaign()`, `requireSenderAccount()`,
  `requireContact()`, `requireTemplate()` scope every lookup by `userId` and return
  404 (not 403) for other users' resources to avoid leaking existence.

## 4. Data model

`prisma/schema.prisma` (PostgreSQL). All lists are paginated in the API layer.

| Model | Purpose | Key relations |
|---|---|---|
| `User` | Workspace owner; `role`, `sessionVersion`, `minDaysBetweenContacts` | root of every tenant-scoped row |
| `SenderAccount` | Gmail or SMTP sending identity; encrypted credentials; `dailyCap` | → `User`, → `SenderDailyUsage`, `SendJob`, `SendAttempt` |
| `EmailTemplate` | Reusable subject/body | → `User`, → `Campaign` |
| `Contact` | Recipient record; `emailNormalized` canonical form; `timeZone`; consent fields | → `User`, → `CampaignRecipient`, `SendJob`, `UnsubscribeEvent` |
| `Campaign` | Message snapshot (`subject`/`body`), sending window, `sendingDays`, tz fallback mode, optional `dailyLimit`, `emergencyStopped`, `startAt`/`endAt` | → `User`, `EmailTemplate`, → `CampaignRecipient`, `SendJob`, `CampaignDailyUsage`, `Suppression`, `ImportBatch`, `UnsubscribeEvent` |
| `CampaignRecipient` | One contact's membership in one campaign; scheduling state | → `Campaign`, `Contact`, → `SendJob` |
| `SendJob` | The single logical send unit per recipient | → `CampaignRecipient`, `Campaign`, `Contact`, `SenderAccount`, → `SendAttempt` |
| `SendAttempt` | Per-attempt audit row (outcome, latency, header, reconciliation note) | → `SendJob`, `SenderAccount` |
| `SenderDailyUsage` | Per (account, quota day) sent/reserved/failure counters | → `SenderAccount` |
| `CampaignDailyUsage` | Per (campaign, day) sent counter | → `Campaign` |
| `Suppression` | Global or campaign-scope suppression | → `User`, `Campaign` |
| `UnsubscribeEvent` | Immutable record of an unsubscribe (token hash, IP, UA) | → `User`, `Campaign`, `Contact` |
| `WebhookEvent` | Provider event log with idempotent external id | → `User` |
| `AuditLog` | Append-only security trail | → `User` (nullable, `SetNull`) |
| `ImportBatch` | CSV import bookkeeping | → `User`, `Campaign` |
| `RateLimit` | Fixed-window counters | standalone |
| `IdempotencyKey` | Replay protection for API requests carrying `Idempotency-Key` | → `User` |

Enums: `Role`, `SenderProvider`, `SenderStatus`, `CampaignStatus`,
`RecipientStatus` (`PENDING`, `HELD_TZ`, `SCHEDULED`, `QUEUED`, `SENDING`, `SENT`,
`FAILED`, `SKIPPED`, `CANCELLED`), `JobStatus` (`QUEUED`, `CLAIMED`, `SENT`,
`FAILED`, `SKIPPED`, `CANCELLED`, `AMBIGUOUS`), `AttemptStatus` (`SUCCESS`,
`TRANSIENT_FAILURE`, `PERMANENT_FAILURE`, `AMBIGUOUS`), `ProviderKind`,
`ContactStatus`, `SuppressionScope`, `SuppressionReason`, `ImportStatus`,
`TzFallbackMode` (`HOLD`, `FALLBACK`), `WebhookStatus`.

### Uniqueness / duplicate-prevention constraints

Declared in Prisma:

| Constraint | Model | Effect |
|---|---|---|
| `@unique email` | `User` | one account per email |
| `@@unique([userId, email])` | `SenderAccount` | no duplicate sender identity per workspace |
| `@@unique([userId, emailNormalized])` | `Contact` | one contact per workspace per normalized email |
| `@@unique([campaignId, contactId])` | `CampaignRecipient` | **a contact belongs to a campaign exactly once, ever** |
| `@unique campaignRecipientId` | `SendJob` | one logical job per recipient |
| `@unique idempotencyKey` | `SendJob` | deterministic key `job:<campaignRecipientId>` makes re-enqueues no-ops |
| `@@unique([jobId, attemptNumber])` | `SendAttempt` | no double accounting of one attempt |
| `@@unique([senderAccountId, date])` | `SenderDailyUsage` | one quota row per account per quota day |
| `@@unique([campaignId, date])` | `CampaignDailyUsage` | one quota row per campaign per day |
| `@@unique([provider, externalId])` | `WebhookEvent` | webhook idempotency |
| `@@unique([key, windowStart])` | `RateLimit` | atomic counter per fixed window |
| `@@unique([userId, key])` | `IdempotencyKey` | one stored response per key per user |

Plus **partial unique indexes** created only in
`prisma/migrations/20260101000000_init/migration.sql` (lines 266–267):

```sql
CREATE UNIQUE INDEX "Suppression_global_email_key"
  ON "Suppression"("userId", "emailNormalized")
  WHERE "scope" = 'GLOBAL' AND "campaignId" IS NULL;

CREATE UNIQUE INDEX "Suppression_campaign_email_key"
  ON "Suppression"("campaignId", "emailNormalized")
  WHERE "scope" = 'CAMPAIGN' AND "campaignId" IS NOT NULL;
```

These enforce one global suppression per (user, email) and one per (campaign, email).
`addSuppression` (`src/lib/suppression.ts`) treats Prisma error `P2002` as "already
suppressed", making inserts idempotent. The same tolerance is used for
`WebhookEvent.create` in the Gmail webhook handler.

## 5. Send pipeline

### 5.1 Enqueue: campaign → contacts → recipients → jobs

`src/lib/campaign.ts` → `addContactsToCampaign()` (single transaction):

1. Upsert contacts with `createMany({ skipDuplicates: true })` on
   `(userId, emailNormalized)`; fetch the resulting contact rows.
2. Create `CampaignRecipient` rows with `createMany({ skipDuplicates: true })` on
   `(campaignId, contactId)`. Status/schedule is computed per recipient:
   * `SCHEDULED` with a UTC `scheduledAt` when a valid local send time exists,
   * `HELD_TZ` (with `skipReason: "UNKNOWN_TIMEZONE"`) when the contact has no usable
     time zone and the campaign is in `HOLD` mode.
3. Enqueue the single job per `SCHEDULED` recipient that has no job yet
   (`sendJob: null`) via `enqueueJob()` — self-healing for earlier partial runs.

`reschedulePendingRecipients()` recomputes `PENDING` / `SCHEDULED` / `HELD_TZ`
recipients after a window change; only `QUEUED` jobs are moved, claimed/terminal jobs
are never touched. `canStartCampaign()` is the pre-flight gate used by start/resume:
requires ≥ 1 connected sender, ≥ 1 `SCHEDULED` recipient, `APP_URL` configured, and
non-empty subject/body.

Import batches (`POST /api/contacts/import`) reuse the same functions and record
totals on `ImportBatch`.

### 5.2 Queue: `src/lib/queue.ts`

* `jobIdempotencyKey(campaignRecipientId)` → `"job:<campaignRecipientId>"`.
* `enqueueJob(tx, …)` → `sendJob.upsert` keyed on `campaignRecipientId`; the `update`
  branch is intentionally empty so an in-flight/terminal job is never reset.
* `claimDueJobs(workerId, limit, leaseSeconds)` — the atomic claim:

  ```sql
  UPDATE "SendJob" AS j
  SET "status"='CLAIMED', "claimedAt"=now(), "claimedBy"=$workerId,
      "leaseExpiresAt"=now() + make_interval(secs => $leaseSeconds), ...
  WHERE j.id IN (
    SELECT id FROM "SendJob"
    WHERE "status"='QUEUED' AND "scheduledAt" <= now()
    ORDER BY "scheduledAt" ASC LIMIT $limit
    FOR UPDATE SKIP LOCKED)
  RETURNING j.id;
  ```

  `FOR UPDATE SKIP LOCKED` guarantees concurrent workers claim disjoint sets;
  `SendJob_status_scheduledAt_idx` backs the scan.
* `heartbeatJob(jobId)` extends the lease for long provider calls.
* `reclaimAbandonedJobs()` — **crash recovery with the never-blind-retry rule**:
  * expired-lease `CLAIMED` jobs with **no** unfinished/`AMBIGUOUS` attempt → back to
    `QUEUED` (safe to retry);
  * expired-lease `CLAIMED` jobs that **do** have an unfinished or `AMBIGUOUS`
    attempt → `AMBIGUOUS` (outcome unknown; must be reconciled);
  * any still-unfinished `SendAttempt` of an `AMBIGUOUS` job is closed with a
    `reconciliationNote`.
* `rescheduleJob()` only moves `QUEUED` jobs; `cancelCampaignJobs()` cancels queued
  jobs; `queueDepth()` groups by status (optionally per user); `listAmbiguousJobs()`
  returns ambiguous jobs oldest-first.

Deterministic idempotency keys and `@unique` constraints mean a crash, a retried API
call, or a duplicate enqueue can never produce a second `SendJob` for a recipient.

### 5.3 Quota: `src/lib/quota.ts`

Transactional reservation with row locks, per (account, quota day) and optionally per
(campaign, quota day):

* `quotaDayKey(date, SENDER_QUOTA_TIMEZONE)` — UTC midnight of the local quota day.
* `reserveSenderSlot(tx, accountId, cap, day)` — `INSERT ... ON CONFLICT DO NOTHING`
  then `SELECT … FOR UPDATE`; throws `QuotaExceededError` when
  `sentCount + reservedCount >= cap`, otherwise increments `reservedCount`.
* `settleSenderSlot` — on success: `sentCount+1`, `reservedCount-1` (floored at 0).
* `releaseSenderSlot(tx, …, countFailure)` — frees the reservation on terminal
  failure/skip and optionally increments `failureCount`.
* `reserveCampaignSlot` / `rollbackCampaignSlot` — same pattern against
  `CampaignDailyUsage` when `Campaign.dailyLimit` is set.
* The effective sender cap is `MIN(account.dailyCap, SENDER_DAILY_CAP_DEFAULT)` —
  configuration can only lower, never raise, the platform cap.

### 5.4 Worker ordering: `src/worker/processJob.ts`

`processJob(job)` executes in this fixed order (ordering is correctness-critical):

1. **Campaign state** — `CANCELLED`/`COMPLETED` → skip; not `ACTIVE` or
   `emergencyStopped` → requeue with `scheduledAt = now + 60 s` without consuming an
   attempt.
2. **Recipient eligibility** — terminal recipient statuses → skip; `HELD_TZ` → skip
   (`HELD_UNKNOWN_TIMEZONE`).
3. **Suppression / contact status / frequency** — `checkSuppression()`
   (global, then campaign) and `isTooFrequent(contact, minDays)` with the workspace
   `User.minDaysBetweenContacts` (default `MIN_DAYS_BETWEEN_CONTACTS`).
4. **Recipient-local window** — if outside the window, reschedule the job and
   recipient to `nextSendingInstant`; if no valid instant exists, mark the recipient
   `HELD_TZ` (`NO_VALID_SEND_TIME`).
5. **Attempt row** — created **before** the provider call, with status `AMBIGUOUS` and
   `idempotencyHeader = "v1:<jobId>:<attemptNumber>"`. An unfinished attempt row is
   the crash-safe marker of a possible in-flight send. A `P2002` on create means the
   attempt already exists (crash replay) → abort without contacting the provider.
6. **Sender selection + reservation** — connected accounts ordered by
   `lastUsedAt`/`createdAt`; for each candidate, one transaction reserves the sender
   slot and the campaign slot, and pins `senderAccountId`/`provider` on both job and
   attempt. If every account is at cap, the job is deferred to the next quota day and
   the attempt is closed as `TRANSIENT_FAILURE` / `ALL_SENDERS_AT_CAP`.
7. **Render + submit** — `renderEmail()` (`src/lib/template.ts`) personalizes
   subject/body with contact variables and the pre-signed unsubscribe URL, then the
   provider (`gmailProvider` or `smtpProvider`) is invoked. A thrown submit error is
   by definition ambiguous.
8. **Settle** — inside a transaction:
   * `ok` → settle the sender slot; attempt `SUCCESS`; job `SENT`; recipient `SENT`;
     contact `lastSentAt`/`sentCount` updated.
   * `ambiguous` → `markAmbiguous()` (quota reservation is **held** because the
     message may exist at the provider; recipient → `SENDING`; job `AMBIGUOUS` with
     `ambiguousSince`).
   * `transient` → release sender slot (count failure), roll back campaign slot,
     attempt `TRANSIENT_FAILURE`; requeue with backoff unless `attempts >= maxAttempts`,
     in which case job and recipient become `FAILED`.
   * `permanent` → same release/rollback, attempt `PERMANENT_FAILURE`, job and
     recipient `FAILED`.

**Retry/backoff** (`backoffDelayMs`): `min(WORKER_BACKOFF_BASE_MS * 2^(attempt-1),
30 min)` multiplied by jitter in `[0.5, 1.5)`. `maxAttempts` comes from
`WORKER_MAX_ATTEMPTS` (default 5).

**AMBIGUOUS state and reconciliation** (`reconcileAmbiguousJob`, driven by
`src/worker/index.ts` step 3, bounded to 5 per cycle):

* `provider.reconcile()` asks the provider whether the message exists
  (Gmail: `rfc822msgid:` search for the deterministic Message-ID; SMTP: always
  `"unknown"`).
* `"sent"` → settle quota, attempt `SUCCESS` with reconciliation note, job/recipient
  `SENT`, contact counters updated, audit `job.reconciled_sent`.
* `"not_sent"` → release/rollback quota, attempt `TRANSIENT_FAILURE`, then requeue
  with backoff or mark `FAILED` if attempts are exhausted.
* `"unknown"` → the job stays `AMBIGUOUS` for manual resolution
  (`POST /api/jobs/:id/resolve`). **A job in `AMBIGUOUS` is never auto-retried** — a
  blind retry could double-send, and the held quota reservation prevents exceeding the
  daily cap.

### 5.5 Worker loop: `src/worker/index.ts`

Per tick: (1) `reclaimAbandonedJobs()`; (2) `claimDueJobs()` and process each job
(unhandled errors release the claim; the attempt row marks ambiguity); (3) reconcile up
to 5 ambiguous jobs. Interval `max(250 ms, WORKER_POLL_INTERVAL_MS - elapsed)`
(default 2000 ms). Handles `SIGINT`/`SIGTERM` for graceful shutdown. Worker identity is
`<HOSTNAME>-<random8>`.

## 6. Recipient-local scheduling — `src/lib/scheduling.ts`

All timestamps are stored in UTC; the send decision is made in the recipient's IANA
zone. DST is handled with `Intl` (no fixed offsets).

* `SendingWindow = { startMinute (inclusive), endMinute (exclusive), days[] }`,
  default 09:00–17:00 (`540`–`1020`), Mon–Fri (`[1,2,3,4,5]`).
* `getLocalParts(date, timeZone)` / `tzOffsetMinutes()` — wall-clock parts and offset
  via `Intl.DateTimeFormat` (midnight rendered as `24` is normalized to `0`).
* `zonedTimeToUtc(...)` — probe + validate: normal times are unambiguous; during
  fall-back the **earlier** occurrence is chosen; during spring-forward the
  nonexistent time resolves to the post-jump wall clock (02:30 → 03:30).
* `isWithinSendingWindow()` — checks weekday and minute-of-day.
* `nextSendingInstant(from, tz, window)` — walks forward up to 14 days; returns `null`
  only when no allowed day exists.
* `clampToWindow(proposed, tz, window, {mode, fallbackTimeZone})` — returns the instant
  unchanged if inside the window, otherwise the next valid instant; returns `null`
  for an unknown/invalid zone unless `mode === "FALLBACK"` with a valid
  `fallbackTimeZone`. `null` is what causes a recipient to be held (`HELD_TZ`) in
  `HOLD` mode — the default and safest setting.
* `sendingWindowSchema` rejects `endMinute <= startMinute` (no overnight windows).

## 7. Security

* **Token encryption** (`src/lib/crypto.ts`): AES-256-GCM,
  `ENCRYPTION_KEY` must decode to exactly 32 bytes. Output format
  `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. **AAD binding** ties the ciphertext to a
  context, e.g. `sender:<accountId>:refreshToken` / `:accessToken` (via `tokenAad()` in
  `src/lib/email/gmail.ts`) and `sender:<accountId>:smtpPassword`, preventing token
  mix-up attacks. Provider credentials are written only after the account row exists so
  the AAD contains the real id, and are never returned by any API.
* **Secret handling**: `hmacSign`/`hmacVerify` (constant-time compare) for unsubscribe
  tokens; `sha256` for idempotency request hashes and `UnsubscribeEvent.tokenHash`;
  `safeEqual` for constant-time key comparison; secrets are never logged.
* **Header-injection guard** (`src/lib/email/provider.ts`): `sanitizeHeaderValue()`
  truncates a header value at the first CR/LF and strips remaining control characters;
  `encodeMimeHeader()` RFC 2047-encodes non-ASCII values. Applied to From/To/Subject,
  Message-ID, `X-EOP-Idempotency-Key`, `List-Unsubscribe` and custom headers.
* **Suppression / unsubscribe**: unsubscribe tokens are stateless HMAC-signed payloads
  `{c, u, p?}` (`src/lib/template.ts`); `POST /api/unsubscribe` is idempotent, writes a
  GLOBAL suppression, sets the contact `UNSUBSCRIBED`, and cancels queued/ambiguous jobs
  plus non-`SENT` recipients. Bounce/complaint webhooks add global suppressions and set
  contact status (`BOUNCED`/`COMPLAINED`). `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers are emitted on every
  message (RFC 8058).
* **Webhook verification**: the Gmail webhook verifies a Google-issued OIDC JWT
  (`verifyIdToken`, audience = OAuth client id) when Google is configured; missing
  configuration rejects in production and allows in development. Invalid signatures are
  rejected with 401. Duplicate deliveries are idempotent on
  `(provider, externalId)`.
* **Audit log** (`src/lib/audit.ts`): append-only `AuditLog` rows for security-relevant
  actions (`auth.*`, `campaign.*`, `contact.*`, `sender.*`, `suppression.*`,
  `contacts.import`, `job.reconcile*`, `webhook.*`, `google.*`). Never records bodies,
  tokens or passwords; failures never break the primary flow.
* **Response hygiene**: provider tokens/credentials are excluded from all API selects;
  `GET /api/health` reports no secrets; error responses never leak stack traces.

## 8. Directory map — `src/`

```
src/
├─ middleware.ts              Edge auth gate (page redirects, /api 401 JSON)
├─ app/
│  └─ api/                    Route handlers (one directory per resource group)
│     ├─ analytics/           GET  workspace reporting
│     ├─ audit/               GET  audit log
│     ├─ auth/                register, login, logout, me
│     ├─ campaigns/           list/create, [id] CRUD, contacts, start, pause,
│     │                       resume, schedule, stats, duplicate, test-send
│     ├─ contacts/            list/create, [id] CRUD, import (CSV)
│     ├─ google/              connect (OAuth start), callback (OAuth redirect)
│     ├─ health/              GET  liveness/readiness (public)
│     ├─ jobs/                GET  queue view, [id]/resolve (ambiguous)
│     ├─ senders/             list/create (SMTP), [id], pause, resume
│     ├─ settings/            POST workspace preferences
│     ├─ suppressions/        list/create/delete
│     ├─ templates/           list/create, [id] CRUD
│     ├─ unsubscribe/         GET/POST public RFC 8058 one-click
│     └─ webhooks/gmail/      POST public Pub/Sub + ESP events
├─ lib/
│  ├─ audit.ts                Append-only audit trail helper
│  ├─ auth/
│  │  ├─ guards.ts            requireUser / requireCampaign / … (ownership)
│  │  ├─ password.ts          bcrypt hashing + policy
│  │  └─ session.ts           JWT session, cookie set/clear/read
│  ├─ campaign.ts             Add contacts, scheduler, lifecycle, stats
│  ├─ client/api.ts           Browser-side API fetch helper
│  ├─ crypto.ts               AES-256-GCM, HMAC, sha256, safeEqual
│  ├─ csv.ts                  CSV parse/preview/mapping, file size limits
│  ├─ db.ts                   Prisma client singleton
│  ├─ email-normalize.ts      Email + IANA time-zone normalization/validation
│  ├─ email/
│  │  ├─ provider.ts          EmailProvider interface, MIME build, header guard
│  │  ├─ gmail.ts             Gmail API provider + reconciliation
│  │  └─ smtp.ts              nodemailer provider + connection verify
│  ├─ env.ts                  Zod-validated environment (fail-fast in prod)
│  ├─ errors.ts               ApiError + zodDetails
│  ├─ http.ts                 handleApi, json, assertSameOrigin, clientIp
│  ├─ idempotency.ts          withIdempotency (Idempotency-Key replay protection)
│  ├─ logger.ts               Structured logger (LOG_LEVEL)
│  ├─ queue.ts                Enqueue/claim/lease/reclaim/ambiguous listing
│  ├─ quota.ts                Transactional sender/campaign quota reservation
│  ├─ ratelimit.ts            Postgres fixed-window limiter
│  ├─ scheduling.ts           IANA-zone window math, DST handling, HOLD/FALLBACK
│  ├─ suppression.ts          Global/campaign suppression + frequency guard
│  ├─ template.ts             Rendering, unsubscribe tokens, Message-ID helpers
│  └─ validation.ts           Zod schemas for every API input
└─ worker/
   ├─ index.ts                Worker loop (reclaim → claim → process → reconcile)
   └─ processJob.ts           Per-job pipeline + reconcileAmbiguousJob
```

Configuration is read exclusively through `src/lib/env.ts`; the Prisma client is
created once in `src/lib/db.ts`.
