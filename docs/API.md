# API Reference

REST API of the Email Outreach Platform. Every handler lives in
`src/app/api/**/route.ts` and is wrapped by `handleApi` (`src/lib/http.ts`).
Inputs are validated with Zod (`src/lib/validation.ts` and inline schemas);
nothing reaches Prisma unvalidated.

## Conventions

### Authentication

* Session cookie: `eop_session` — HS256 JWT, `HttpOnly`, `SameSite=Lax`,
  `Secure` in production. Sent automatically by the browser
  (`credentials: "same-origin"` in `src/lib/client/api.ts`).
* All endpoints below require a valid session unless marked **Public**.
  Authentication failure → `401`.
* `src/middleware.ts` returns `401` JSON for unauthenticated `/api/*` requests and
  redirects unauthenticated page requests to `/login`. Routes re-validate the session
  server-side; middleware is not the only check.
* State-changing methods (`POST`, `PATCH`, `DELETE`) additionally call
  `assertSameOrigin(req)`: when `Origin`/`Referer` is present it must match `APP_URL`
  or an entry in `EXTRA_ALLOWED_ORIGINS`, otherwise `403` (`FORBIDDEN`,
  "Request origin not allowed.").

### Error envelope

All errors produced by `handleApi` share one shape:

```json
{ "error": { "code": "STRING", "message": "Human readable.", "details": "optional" } }
```

| Code | Status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Invalid request semantics |
| `VALIDATION` | 400 | Zod parse failure; `details` is `[{ "path": "...", "message": "..." }]` |
| `UNAUTHORIZED` | 401 | Missing/invalid session |
| `FORBIDDEN` | 403 | Origin not allowed / no access |
| `NOT_FOUND` | 404 | Resource missing or not owned by the caller |
| `CONFLICT` | 409 | Duplicate resource or idempotency-key conflict |
| `RATE_LIMITED` | 429 | Fixed-window rate limit exceeded |
| `INTERNAL` | 500 | Unhandled error (details logged, never returned) |

Other non-`error`-envelope status codes used by specific routes:
`201` (created), `202` (accepted, test send ambiguous), `502` (test send provider
failure), `503` (`GET /api/health` when the database is down).

### Pagination

List endpoints accept `page` (default 1) and `pageSize` (default 20 or 50; max 100)
and return `{ total, page, pageSize, items }`. `GET /api/campaigns` and
`GET /api/contacts` also accept `search` (max 200 chars) and `status`.
`GET /api/campaigns/:id/contacts` and `GET /api/jobs` accept `status`
(and `GET /api/jobs` additionally `campaignId`).

### `Idempotency-Key` header

Mutating endpoints that a client may retry accept an `Idempotency-Key` request
header, processed by `withIdempotency` (`src/lib/idempotency.ts`):

* The first request stores the response (`IdempotencyKey.responseBody`); replays with
  the same key **and** the same body return the stored payload and create no new rows.
* Reusing a key with a different body → `409 CONFLICT`
  ("Idempotency-Key was already used with a different payload.").
* A concurrent request with the same key while the first is still running →
  `409 CONFLICT` ("A request with this Idempotency-Key is still in progress.").

Currently consumed by `POST /api/campaigns/:id/contacts`.

### Rate limits

`enforceRateLimit` (`src/lib/ratelimit.ts`) uses a Postgres fixed window.
Auth endpoints use `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_AUTH_WINDOW_SECONDS`
(default 10 / 60 s); most other authenticated endpoints use `RATE_LIMIT_API_MAX` /
`RATE_LIMIT_API_WINDOW_SECONDS` (default 120 / 60 s). Exceeding a limit → `429`.
The public unsubscribe endpoint uses a fixed `30 requests / 60 s` per IP (failures are
swallowed).

---

## Auth — `/api/auth`

### `POST /api/auth/register` — Public

Create the first workspace user. Rate-limited per IP. Password policy enforced.

* Request body (`registerSchema`):
  `{ email: string (email, ≤320), password: string (10–200), name?: string (1–120) }`.
* Success `201`: `{ user: { id, email, name, role } }` and sets the session cookie.
* Errors: `400` (password policy), `409` (email already exists), `429`.

### `POST /api/auth/login`

* Request body (`loginSchema`): `{ email, password }`.
* Success `200`: `{ user: { id, email, name, role } }` and sets the session cookie.
* Errors: `401` ("Invalid email or password."; also rate-limited per IP and per
  account), `429`. Failed attempts are audited as `auth.login_failed`.

### `POST /api/auth/logout`

* Request body: none.
* Success `200`: `{ ok: true }` and clears the session cookie.
* Audited as `auth.logout` when a session was present.

### `GET /api/auth/me`

* Success `200`: `{ user: { id, email, name, role, minDaysBetweenContacts },
  counts: { senders, campaigns, contacts } }`.
* Errors: `401`.

---

## Campaigns — `/api/campaigns`

### `GET /api/campaigns`

List the caller's campaigns. Rate-limited (`apiLimitKey(user.id, "campaigns")`).

* Query: `page`, `pageSize`, `search` (matches `name`, case-insensitive), `status`
  (`DRAFT` | `ACTIVE` | `PAUSED` | `COMPLETED` | `CANCELLED`).
* Success `200`: `{ total, page, pageSize, items }`; each item includes
  `_count: { recipients, sendJobs }`. Ordered by `createdAt` desc.

### `POST /api/campaigns`

Create a `DRAFT` campaign. Rate-limited (`campaigns-create`).

* Request body (`campaignCreateSchema`):

  | Field | Type / constraint | Default |
  |---|---|---|
  | `name` | string 1–200 | required |
  | `subject` | string 1–500 | required |
  | `body` | string 1–200000 | required |
  | `templateId` | cuid or null | null |
  | `fromName` | string ≤200 \| null | null |
  | `replyTo` | email ≤320 \| null | null |
  | `windowStartMinute` | int 0–1439 | 540 |
  | `windowEndMinute` | int 1–1440 | 1020 |
  | `sendingDays` | int[1..7], values 0–6 | `[1,2,3,4,5]` |
  | `timeZoneFallback` | `HOLD` \| `FALLBACK` | `HOLD` |
  | `fallbackTimeZone` | IANA string ≤100 (normalized) | null |
  | `dailyLimit` | int 1–100000 \| null | null |
  | `startAt`, `endAt` | date \| null | null |

  Cross-field: `windowEndMinute > windowStartMinute`; `fallbackTimeZone` is required
  when `timeZoneFallback` is `FALLBACK`.
* Success `201`: `{ campaign }`.
* Errors: `400 VALIDATION`, `401`, `403`, `429`.

### `GET /api/campaigns/:id`

* Success `200`: `{ campaign, stats }` where `stats` has `total`, `byStatus`
  (`PENDING`, `SCHEDULED`, `HELD_TZ`, `QUEUED`, `SENDING`, `SENT`, `FAILED`,
  `SKIPPED`, `CANCELLED`).
* Errors: `404` (not found or not owned).

### `PATCH /api/campaigns/:id`

Partial update (`campaignUpdateSchema` = `campaignCreateSchema.partial()`). If the
sending window, `sendingDays`, or time-zone-fallback settings change and the campaign
is `DRAFT`/`ACTIVE`/`PAUSED`, pending recipients are rescheduled.

* Success `200`: `{ campaign, rescheduled }` (`rescheduled` = number of moved jobs).
* Errors: `400 VALIDATION`, `404`.

### `DELETE /api/campaigns/:id`

Durably cancel the campaign (`markCampaignCancelled`): status → `CANCELLED`, queued
jobs → `CANCELLED`, non-terminal recipients → `CANCELLED`. No data is deleted.

* Success `200`: `{ ok: true, status: "CANCELLED" }`.
* Errors: `404`.

### `GET /api/campaigns/:id/contacts`

Paginated recipient list. Query: `page` (default 1), `pageSize` (default 20, max 100),
`status`. Each item includes a trimmed `contact`
(`email, firstName, lastName, company, timeZone, status`).

* Success `200`: `{ total, page, pageSize, items }`.

### `POST /api/campaigns/:id/contacts`

Add contacts by email list and/or existing contact ids. Supports
`Idempotency-Key`. Duplicate-safe: contacts upsert on `(userId, emailNormalized)`,
recipients on unique `(campaignId, contactId)`.

* Request body:

  ```json
  { "emails": ["a@example.com"], "contactIds": ["cuid"] }
  ```

  At least one of `emails` (≤5000, each ≤320) or `contactIds` (≤5000 cuids) is
  required. Invalid emails → `400 BAD_REQUEST` with `details.invalidEmails` (first 20).
* Success `201` (or `200` when replayed):
  `{ added, duplicates, invalid, heldForTimezone, replayed, stats }`.
* Errors: `400`, `404` (campaign), `409` (idempotency conflict).

### `POST /api/campaigns/:id/start`

Pre-flight checks via `canStartCampaign`: ≥1 connected sender, ≥1 `SCHEDULED`
recipient, `APP_URL` configured, non-empty subject/body.

* Request body: none.
* Success `200`: `{ campaign }`; if already active: `{ campaign, alreadyActive: true }`.
* Errors: `400` with `details.problems` (array of strings), `404`.

### `POST /api/campaigns/:id/pause`

Stops new sends; queued jobs are kept (status → `PAUSED`, `emergencyStopped = true`).

* Success `200`: `{ campaign }`.
* Errors: `400` (not `ACTIVE`), `404`.

### `POST /api/campaigns/:id/resume`

Re-runs pre-flight checks, then status → `ACTIVE`, `emergencyStopped = false`.

* Success `200`: `{ campaign }`.
* Errors: `400` (not `PAUSED`, or pre-flight problems), `404`.

### `POST /api/campaigns/:id/schedule`

Update the recipient-local sending window and recompute pending jobs.

* Request body (`scheduleSchema`): `{ windowStartMinute: 0–1439,
  windowEndMinute: 1–1440, sendingDays: int[1..7] }`; requires
  `windowEndMinute > windowStartMinute`.
* Success `200`: `{ campaign, rescheduled }`.
* Errors: `400 VALIDATION`, `404`.

### `GET /api/campaigns/:id/stats`

* Success `200`: `{ stats, recentJobs, daily }`. `recentJobs` = 20 latest jobs
  (`id, status, attempts, lastError, errorCode, providerMessageId, updatedAt,
  contact.email, senderAccount.email`); `daily` = up to 30 `CampaignDailyUsage` rows.
* Errors: `404`.

### `POST /api/campaigns/:id/duplicate`

Clone a campaign as a new `DRAFT`.

* Request body: `{ name?: string (1–200), includeContacts: boolean (default false) }`.
* Success `201`: `{ campaign }`. When `includeContacts` is true, recipients are copied
  (unique `(campaignId, contactId)` still applies).
* Errors: `400 VALIDATION`, `404`.

### `POST /api/campaigns/:id/test-send`

Send one personalized test message. Does not consume recipient scheduling.

* Request body: `{ to: email (≤320), contactId?: cuid, senderAccountId?: cuid }`.
* Success `200`: `{ ok: true, messageId }`.
* Success `202`: `{ ok: false, ambiguous: true, message }` (outcome unknown).
* Errors: `400` (invalid recipient / no connected sender available), `404`;
  `502` with `{ ok: false, kind, code, message }` for a transient/permanent provider
  failure.

---

## Contacts — `/api/contacts`

### `GET /api/contacts`

Query: `page`, `pageSize`, `search` (matches `email`, `firstName`, `lastName`,
`company`, case-insensitive), `status`.

* Success `200`: `{ total, page, pageSize, items }` (ordered by `createdAt` desc).

### `POST /api/contacts`

Create one contact, deduped by normalized email.

* Request body (`contactCreateSchema`): `email` (required, email ≤320),
  `firstName`/`lastName` (≤200), `company` (≤300), `website` (≤500), `title` (≤200),
  `timeZone` (IANA, ≤100), `country` (≤100), `consentAt` (date), `consentSource`
  (≤200) — all optional except `email`.
* Success `201`: `{ contact }`.
* Errors: `400 VALIDATION`, `409` with `details.contactId` when it already exists.

### `GET /api/contacts/:id`

* Success `200`: `{ contact }`. Errors: `404`.

### `PATCH /api/contacts/:id`

Partial update (`contactCreateSchema.partial()`); changing `email` also recomputes
`emailNormalized`.

* Success `200`: `{ contact }`. Errors: `400 VALIDATION`, `404`.

### `DELETE /api/contacts/:id`

Soft delete: contact status → `INVALID`; the contact's `QUEUED` jobs → `CANCELLED`.

* Success `200`: `{ ok: true }`. Errors: `404`.

### `POST /api/contacts/import`

Multipart CSV upload. Limits: 10 MB, 50 000 rows; the file must be `.csv` or
`text/csv`.

* Form fields: `file` (required), `campaignId` (optional), `mapping` (optional JSON,
  detected from headers otherwise), `dryRun` (`"true"` to preview).
* Dry run success `200`: `{ dryRun: true, headers, sample, detectedMapping, total,
  valid, invalid, duplicatesInFile }`.
* Success `201`: `{ batchId, added, duplicates, invalid, heldForTimezone,
  invalidPreview }`.
* Errors: `400` (missing file, too large, wrong type, no valid rows — with
  `details.invalid`), `404` (campaign not found). Imports are recorded as
  `ImportBatch` rows (`COMPLETED` or `FAILED`).

---

## Senders — `/api/senders`

### `GET /api/senders`

List connected accounts. Token/credential fields are never returned.

* Success `200`:
  `{ accounts: [{ id, provider, email, displayName, status, dailyCap, lastError,
  lastUsedAt, connectedAt, scopes, usage: { sent, reserved, failures }, remaining }],
  quotaDay, maxAccounts }`.

### `POST /api/senders`

Connect an SMTP account. The connection is verified before anything is stored; the
password is stored encrypted (AES-256-GCM, AAD `sender:<id>:smtpPassword`).

* Request body (`smtpAccountSchema`):

  | Field | Type / constraint |
  |---|---|
  | `email` | email ≤320 (lowercased) |
  | `displayName` | string ≤200 \| null |
  | `host` | string 1–300 |
  | `port` | int 1–65535 |
  | `secure` | boolean (default false) |
  | `username` | string 1–300 |
  | `password` | string 1–500 |
  | `dailyCap` | int 1–2000 (optional; clamped to `SENDER_DAILY_CAP_DEFAULT`) |

* Success `201`: `{ account: { id, provider, email, status, dailyCap } }`.
* Errors: `400` (account limit reached, or SMTP connection failed),
  `409` (email already connected).

### `PATCH /api/senders/:id`

Update the daily cap; the applied value is `min(dailyCap, SENDER_DAILY_CAP_DEFAULT)`.

* Request body (`senderSettingsSchema`): `{ dailyCap: int 1–2000 }`.
* Success `200`: `{ account: { id, email, dailyCap, status } }`. Errors: `404`.

### `DELETE /api/senders/:id`

Disconnect: status → `DISCONNECTED` and all token/credential material
(`refreshTokenEnc`, `accessTokenEnc`, `smtpPasswordEnc`, `tokenExpiresAt`) is nulled.
The row is kept for audit/attribution.

* Success `200`: `{ ok: true }`. Errors: `404`.

### `POST /api/senders/:id/pause`

Status → `PAUSED` (the worker stops selecting the account).

* Success `200`: `{ account: { id, email, status } }`.
* Errors: `400` (already `DISCONNECTED`), `404`.

### `POST /api/senders/:id/resume`

Status → `CONNECTED`, `lastError` cleared.

* Success `200`: `{ account: { id, email, status } }`.
* Errors: `400` (already `DISCONNECTED`), `404`.

---

## Templates — `/api/templates`

### `GET /api/templates`

* Success `200`: `{ templates }` (ordered by `updatedAt` desc).

### `POST /api/templates`

* Request body (`templateSchema`): `{ name: 1–200, subject: 1–500, body: 1–200000,
  description?: ≤1000 | null }`.
* Success `201`: `{ template }`. Errors: `400 VALIDATION`.

### `GET /api/templates/:id`

* Success `200`: `{ template }`. Errors: `404`.

### `PATCH /api/templates/:id`

Partial update of `name`/`subject`/`body`/`description`.

* Success `200`: `{ template }`. Errors: `400 VALIDATION`, `404`.

### `DELETE /api/templates/:id`

Deletes the template; campaigns keep their own body snapshot and their `templateId`
becomes null.

* Success `200`: `{ ok: true }`. Errors: `404`.

---

## Jobs — `/api/jobs`

### `GET /api/jobs`

Queue view. Query: `page`, `pageSize`, `status` (`QUEUED` | `CLAIMED` | `SENT` |
`FAILED` | `SKIPPED` | `CANCELLED` | `AMBIGUOUS`), `campaignId`.

* Success `200`: `{ total, page, pageSize, items, depth, ambiguous,
  config: { maxAttempts, leaseSeconds } }`. Items (ordered by `scheduledAt` asc)
  include `contact { email, timeZone }`, `campaign { id, name }`,
  `senderAccount { email, provider }`, and the latest `sendAttempts` row.

### `POST /api/jobs/:id/resolve`

Manual resolution of an `AMBIGUOUS` job.

* Request body: `{ decision: "sent" | "not_sent" | "drop", note?: string (≤500) }`.
  * `sent` — settle the held quota slot; attempt `SUCCESS`; job/recipient `SENT`;
    contact counters updated.
  * `not_sent` — release sender slot and roll back campaign slot; requeue the job
    (scheduled +60 s).
  * `drop` — release sender slot counting a failure; job/recipient `FAILED`.
* Success `200`: `{ ok: true, decision }`.
* Errors: `400` (job not `AMBIGUOUS`), `404` (not found or not owned).

---

## Suppressions — `/api/suppressions`

### `GET /api/suppressions`

Query: `page` (default 1), `pageSize` (default 50, max 100), `scope`
(`GLOBAL` | `CAMPAIGN`). Items include `campaign { id, name }`.

* Success `200`: `{ total, page, pageSize, items }`.

### `POST /api/suppressions`

Manually suppress an address. Insert is idempotent (partial unique indexes).

* Request body: `{ email: ≤320, scope: "GLOBAL" | "CAMPAIGN" (default GLOBAL),
  campaignId?: cuid, reason: "UNSUBSCRIBE" | "BOUNCE" | "HARD_BOUNCE" | "COMPLAINT" |
  "MANUAL" (default) | "LIST_UNSUBSCRIBE" }`.
  For `GLOBAL`, matching `ACTIVE` contacts are set to `UNSUBSCRIBED` (reason
  `UNSUBSCRIBE`) or `BOUNCED` (otherwise), and their `QUEUED` jobs become `CANCELLED`.
* Success `201` when newly created, `200` when it already existed: `{ created }`.
* Errors: `400` (invalid email / missing `campaignId` for campaign scope),
  `404` (campaign not found).

### `DELETE /api/suppressions`

* Request body: `{ id: cuid }`.
* Success `200`: `{ ok: true }`. Errors: `400 VALIDATION`, `404`.

---

## Settings — `/api/settings`

### `POST /api/settings`

Workspace-level preferences.

* Request body: `{ name?: string (1–120), minDaysBetweenContacts?: int (0–60) }`.
* Success `200`: `{ user: { id, email, name, role, minDaysBetweenContacts } }`.
* Errors: `400 VALIDATION`.

---

## Google OAuth — `/api/google`

### `POST /api/google/connect`

Starts the standard OAuth 2.0 authorization-code flow
(`access_type=offline`, `prompt=consent`). A signed `state` (JWT, 10 min) is minted
and stored in an `HttpOnly` `google_oauth_state` cookie scoped to `/api/google`.

* Request body: none.
* Success `200`: `{ url }` — the Google consent-screen URL.
* Errors: `400` (Google OAuth not configured, or sender-account limit reached).

### `GET /api/google/callback` — Public (browser redirect)

Google OAuth redirect target. Verifies `state` against the cookie and the session
user, exchanges the code, and stores the refresh/access tokens **encrypted** (AAD
`sender:<id>:refreshToken` / `:accessToken`). Both success and failure paths are
`302` redirects to `/senders`; failures append `?oauth_error=<code>` (e.g.
`access_denied`, `state_mismatch`, `state_invalid`, `session_expired`,
`state_user_mismatch`, `token_exchange_failed`, `no_refresh_token_reconnect`,
`email_not_verified`, `account_limit_reached`, `storage_failed`). Success appends
`?connected=<email>`. Tokens and codes are never echoed.

---

## Analytics & audit

### `GET /api/analytics`

Query: `days` (1–90, default 30).

* Success `200`: `{ windowDays, totals: { sent, attemptsByOutcome,
  suppressionsByReason }, campaigns, todayUsage, recentFailures }`. `campaigns` is up
  to 25 campaigns with per-status recipient counts; `todayUsage` is today's
  `SenderDailyUsage` rows with their sender account; `recentFailures` is up to 25
  `FAILED`/`AMBIGUOUS` jobs.

### `GET /api/audit`

Query: `page` (default 1), `pageSize` (default 50, max 100), `action` (substring,
case-insensitive).

* Success `200`: `{ total, page, pageSize, items }` with
  `id, action, entityType, entityId, metadata, ip, createdAt`.

---

## Health — `/api/health` — Public

### `GET /api/health`

Liveness/readiness probe; no session required. `Cache-Control: no-store`.

* Success `200`: `{ status: "ok", version: "0.1.0", environment, database: "up",
  queue, uptimeSeconds, latencyMs, timestamp }`.
* `503` when the database check fails:
  `{ status: "degraded", database: "down", queue: {}, … }`.
* `queue` is the job count grouped by `JobStatus`. No secrets are exposed.

---

## Public unsubscribe — `/api/unsubscribe` — Public

RFC 8058 one-click unsubscribe. Token is a stateless HMAC-signed payload
`{ c: contactId, u: userId, p?: campaignId }` (`src/lib/template.ts`); processing is
idempotent. IP rate limited (30 / 60 s, failures ignored).

### `GET /api/unsubscribe?token=...`

* If the token is invalid → `400` HTML page.
* If the request `Accept` header includes `application/json` → `200`
  `{ ok: true, tokenValid: true }` (`Cache-Control: no-store`).
* Otherwise → `200` HTML confirmation page.

### `POST /api/unsubscribe`

* Request body — one of:
  * `application/json`: `{ token: string (10–2000), reason?: string (≤500) }`.
  * `application/x-www-form-urlencoded` (RFC 8058 one-click):
    `token=...&List-Unsubscribe=One-Click`; `token` may also come from the query
    string.
* Effect: adds a `GLOBAL` suppression (reason `LIST_UNSUBSCRIBE` for one-click, else
  `UNSUBSCRIBE`), sets the contact to `UNSUBSCRIBED`, cancels the contact's
  `QUEUED`/`AMBIGUOUS` jobs and non-`SENT` recipients, and writes an
  `UnsubscribeEvent` (token hash, IP, user agent).
* Success `200`: `{ ok: true, alreadyUnsubscribed: boolean }` for JSON requests, or an
  HTML page otherwise. A valid token for a deleted contact returns
  `{ ok: true, alreadyUnsubscribed: true }`.
* Errors: `400` `{ error: { code: "INVALID_TOKEN", message } }`, `500` `{ error: {
  code: "INTERNAL", message: "Could not process unsubscribe." } }`.

---

## Webhooks — `/api/webhooks/gmail` — Public

### `POST /api/webhooks/gmail`

Accepts both Gmail Pub/Sub push notifications and ESP-style bounce/complaint
payloads. Idempotent on `(provider, externalId)`.

* Authentication: when Google is configured, the `Authorization: Bearer <token>`
  header must carry a Google-issued OIDC JWT whose audience is the OAuth client id
  (verified against Google's JWKS). Missing configuration allows the request only in
  development. Invalid signature → `401` `{ error: { code: "INVALID_SIGNATURE" } }`.
* Gmail Pub/Sub payload: `{ message: { data (base64 JSON with emailAddress and
  historyId), messageId, publishTime } }`. Resolves the owning workspace from the
  contact address, records a `WebhookEvent` (`provider "gmail"`, event type
  `GMAIL_HISTORY`), and ignores unknown recipients.
* ESP payload: `{ eventType: "BOUNCE" | "HARD_BOUNCE" | "COMPLAINT" | "DELIVERY",
  email? , recipient?, eventId? }`. For `BOUNCE`/`HARD_BOUNCE`/`COMPLAINT` it records
  a `WebhookEvent` (`provider "esp"`, `PROCESSED`), adds a `GLOBAL` suppression, sets
  the contact to `BOUNCED`/`COMPLAINED`, and cancels the contact's `QUEUED` jobs.
* Success `200`: `{ ok: true }`, plus `{ ignored: "unknown_recipient" }`,
  `{ ignored: "unrecognized_payload" }`, or `{ duplicate: true }` where applicable.
* Errors: `401` (invalid signature).

---

## Route index

| Method(s) | Path | Auth |
|---|---|---|
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/logout` | Session (optional) |
| GET | `/api/auth/me` | Session |
| GET, POST | `/api/campaigns` | Session |
| GET, PATCH, DELETE | `/api/campaigns/:id` | Session |
| GET, POST | `/api/campaigns/:id/contacts` | Session |
| POST | `/api/campaigns/:id/start` | Session |
| POST | `/api/campaigns/:id/pause` | Session |
| POST | `/api/campaigns/:id/resume` | Session |
| POST | `/api/campaigns/:id/schedule` | Session |
| GET | `/api/campaigns/:id/stats` | Session |
| POST | `/api/campaigns/:id/duplicate` | Session |
| POST | `/api/campaigns/:id/test-send` | Session |
| GET, POST | `/api/contacts` | Session |
| GET, PATCH, DELETE | `/api/contacts/:id` | Session |
| POST | `/api/contacts/import` | Session |
| GET, POST | `/api/senders` | Session |
| PATCH, DELETE | `/api/senders/:id` | Session |
| POST | `/api/senders/:id/pause` | Session |
| POST | `/api/senders/:id/resume` | Session |
| GET, POST | `/api/templates` | Session |
| GET, PATCH, DELETE | `/api/templates/:id` | Session |
| GET | `/api/jobs` | Session |
| POST | `/api/jobs/:id/resolve` | Session |
| GET, POST, DELETE | `/api/suppressions` | Session |
| POST | `/api/settings` | Session |
| POST | `/api/google/connect` | Session |
| GET | `/api/google/callback` | Public (redirect) |
| GET | `/api/analytics` | Session |
| GET | `/api/audit` | Session |
| GET | `/api/health` | Public |
| GET, POST | `/api/unsubscribe` | Public |
| POST | `/api/webhooks/gmail` | Public (signature-verified) |
