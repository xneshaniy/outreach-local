# Open & Click Tracking — what works, and what needs extra setup

This document is the honest answer to "which tracking features work with my
current provider?". Read it before you promise a client an open rate.

---

## 1. The short answer

| Metric | Gmail (OAuth API) | SMTP | Needs extra setup? |
|---|---|---|---|
| **Sent (accepted by the provider)** | ✅ yes | ✅ yes | no |
| **Delivered** | ❌ not available | ❌ not available | **yes** — a delivery webhook (e.g. a Gmail Pub/Sub watcher or an ESP that reports delivery) must call the app |
| **Unique opens** | ✅ first-party pixel | ✅ first-party pixel | turn on **open tracking** for the campaign |
| **Total opens** | ✅ | ✅ | turn on **open tracking** |
| **Open rate** | ✅ | ✅ | turn on **open tracking** |
| **Unique clicks** | ✅ first-party redirect | ✅ first-party redirect | turn on **click tracking** |
| **Click rate** | ✅ | ✅ | turn on **click tracking** |
| **Replies / reply rate** | ✅ (inbox polling) | ❌ manual | Gmail: connect the account. SMTP: record replies by hand |
| **Bounces** | ✅ (hard failures from the API) | ✅ (reject at submit) | — |
| **Unsubscribes** | ✅ | ✅ | — |

**The important part:** the Gmail API does **not** expose per-recipient open
or delivery events for ordinary accounts, and SMTP does not either. The open
and click tracking in this application is therefore **first-party**: a 1x1
pixel and a link-rewriting redirect that this application serves itself. It
works with any provider — but it only measures what the recipient's mail
client chooses to tell us.

---

## 2. How the first-party tracking works

### Open tracking (the pixel)

1. The campaign has `trackingEnabled = true`.
2. When the worker renders the message for a recipient, it appends an
   invisible 1x1 GIF:

   ```html
   <img src="https://your-app/api/track/open?t=<signed token>"
        width="1" height="1" alt="" style="display:none!important"
        aria-hidden="true" decoding="async" tabindex="-1" role="presentation" />
   ```

3. The token is `base64url(scope|campaignId|contactId).HMAC-SHA256`. It is
   signed with `AUTH_SECRET`, so a third party cannot forge an open for a
   recipient they do not own, and the contact id cannot be enumerated.
4. `GET /api/track/open` records the event and answers with the GIF. The
   response is `Cache-Control: no-store` — a cached pixel would not be counted
   at all.

### Click tracking (the redirect)

1. The campaign has `clickTrackingEnabled = true`.
2. The worker rewrites every `http(s)` link in the body to
   `https://your-app/api/track/click?t=<signed token>`, where the token binds
   the campaign, the recipient and the target URL.
3. `GET /api/track/click` verifies the signature, records the event and
   answers `302` to the original URL. Only `http`/`https` targets are
   followed; `javascript:`, `data:` and `file:` are rejected.
4. **The unsubscribe link is never rewritten** — opting out keeps working
   exactly as before, whatever tracking is switched on.

### Unique vs. total

`TrackingEvent.dedupeKey` is set **only on the first event of its kind**:

- open → `open:<campaignId>:<contactId>`
- click → `click:<campaignId>:<contactId>:<url>`

A Postgres unique index allows many `NULL`s, so a repeat event is still
recorded (with a `NULL` key) — the **total** keeps growing while the
**unique** count stays correct.

---

## 3. Why an open is not proof that a person read the email

Every event is classified before it is counted:

| Class | How it is detected | Counted in the unique rate? |
|---|---|---|
| `BOT` | known scanner / crawler / link checker / `curl` user agents | **no** |
| `PREVIEW` | Apple Mail Privacy Protection, known image-proxy addresses (Apple `17.0.0.0/8`, Google `66.249.66.1`, …) | **no** |
| `HUMAN` | everything else | yes |

Even so, the numbers are an **approximation**:

- **Apple Mail Privacy Protection** pre-fetches every image through Apple's
  own proxy. It looks exactly like an open.
- **Many clients block images by default.** A "no open" reading is often just
  a blocked request.
- **Security scanners** (corporate mail gateways, link scanners, anti-virus)
  open every link and fetch every image.
- **Some clients fetch images several times** for layout. That is why the
  total is reported separately from the unique count.

The application never presents an open as a human read. Every screen that
shows an open rate carries the same warning, and the CSV export repeats it.

### If you need something more reliable

- Use a **provider-side** open tracking instead (a sending service that
  reports opens) and feed the numbers in — then the data is the provider's,
  not an estimate from a pixel.
- Compare opens with **replies**: a reply is proof of a human. Treat the
  reply rate as the headline number and the open rate as a supporting
  signal.

---

## 4. Privacy and consent

Tracking is **opt-in per campaign** and **off by default**. Before enabling
it:

- Check the laws that apply to you (GDPR, ePrivacy, PECR, CASL, CAN-SPAM
  and equivalents). Open tracking in particular can require **prior
  consent** and a **disclosure** in the email itself.
- Say so in the email: a line such as "We track opens and clicks to see
  whether this is useful. You can opt out at any time." — and honour the
  opt-out (the existing unsubscribe flow already does).
- Do not enable tracking on contacts without a lawful basis. The contact
  records carry `consentAt` and `consentSource` for exactly this reason.
- The tracking endpoints set `Cache-Control: no-store` and
  `X-Robots-Tag: noindex, nofollow`, and the pixel carries no cookie, so
  the recipient's browser is not identified.

The unsubscribe link is never rewritten by click tracking, and the suppression
list is checked by the worker before every send — a suppressed or unsubscribed
contact is never sent to, tracked or otherwise.

---

## 5. Turning it on

1. Open the campaign → **Settings**.
2. Tick **Track opens** and/or **Track clicks**.
3. Save. It applies to messages sent **from that point on** — messages that
   were already sent keep whatever they had.

To try it safely, put the campaign in **dry run** first: the message is
rendered with the tracking in place, but nothing is sent. Check the rendered
HTML (campaign → Preview) to confirm the pixel and the tracked links look
right.

---

## 6. Verifying it works

```bash
# The pixel answers with a real 1x1 GIF
curl -i "https://your-app/api/track/open?t=<token>" | head -5

# The click redirects to the target
curl -i "https://your-app/api/track/click?t=<token>" | head -5
```

A token that is not valid is ignored:

- a forged open token returns a valid GIF (so the inbox never shows a broken
  image) but records **nothing**;
- a forged click token returns **400** and records nothing.

To try it end to end without sending a campaign email, run the local
verification script against a running server:

```bash
npx tsx scripts/verify-portal.ts
```

It creates a client, assigns a campaign, simulates an open (twice, plus a bot
open) and a click, then prints the portal numbers and the access-isolation
results.
