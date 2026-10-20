# Connecting Gmail via OAuth 2.0

This platform connects Gmail sender accounts using **Google's official OAuth 2.0
flow** and the **Gmail API** (`users.messages.send`). It never asks for a Gmail
password, and it never automates the Google sign-in page — doing either would be
a Terms-of-Service violation and a security liability.

Relevant code:

- `src/app/api/google/connect/route.ts` — starts the flow, mints a signed `state`.
- `src/app/api/google/callback/route.ts` — verifies `state`, exchanges the code,
  encrypts and stores the refresh token.
- `src/lib/email/gmail.ts` — sends messages using the stored credentials.

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Create a project (or select an existing one).

## 2. Enable the Gmail API

1. **APIs & Services → Library**.
2. Search for **Gmail API** and click **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace org and want Internal).
3. Fill in the app name, support email, and developer contact.
4. Under **Scopes**, add the scopes listed below.
5. While the app is in **Testing** mode, add every Gmail account you intend to
   connect under **Test users**. (In production you must go through Google's
   verification process for the restricted `gmail.send` scope.)

### Scopes used

The platform requests exactly these (configurable via `GOOGLE_SCOPES`):

| Scope                                            | Why                                             |
| ------------------------------------------------ | ----------------------------------------------- |
| `https://www.googleapis.com/auth/gmail.send`      | Send mail as the account.                        |
| `https://www.googleapis.com/auth/gmail.readonly`  | Read delivery/bounce metadata (reconciliation).  |
| `https://www.googleapis.com/auth/userinfo.email`  | Identify the Gmail address being connected.      |
| `https://www.googleapis.com/auth/userinfo.profile`| Basic profile for display.                       |

Grant the *least* privilege you need: if you do not use bounce
reconciliation, you may remove `gmail.readonly`.

## 4. Create OAuth credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized redirect URIs** — add exactly:

   ```
   http://localhost:3000/api/google/callback     # local development
   https://your-domain.example/api/google/callback  # production
   ```

   The value must match `GOOGLE_REDIRECT_URI` / `${APP_URL}/api/google/callback`
   **character for character**, including scheme and trailing path.

4. Copy the **Client ID** and **Client secret**.

## 5. Configure the app

Add to `.env`:

```dotenv
GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-..."
GOOGLE_REDIRECT_URI="http://localhost:3000/api/google/callback"
# APP_URL must also be correct; it is the base for the redirect URI and links.
APP_URL="http://localhost:3000"
```

Restart the app so the validated environment is reloaded.

## 6. Connect an account

1. Sign in and open **Senders**.
2. Click **Connect Google**. The browser is sent to Google's consent screen.
3. Choose the account and grant the scopes.
4. Google redirects to `/api/google/callback`, which:
   - verifies the signed `state` cookie (CSRF protection),
   - confirms the session still belongs to the same user,
   - exchanges the code for tokens,
   - verifies the email address,
   - stores the **refresh token encrypted** (AES-256-GCM) and records an audit
     entry,
   - redirects back to **Senders** with a success banner.

You can connect up to `MAX_SENDER_ACCOUNTS` (default 10) accounts.

---

## How it stays safe

- **CSRF:** the `state` parameter is a short-lived (10-minute) HS256 JWT signed
  with `AUTH_SECRET` and mirrored in an HttpOnly cookie scoped to
  `/api/google`. The callback rejects a mismatch.
- **No token leakage:** tokens never appear in redirect URLs or API responses.
  Errors are reported with machine-readable codes
  (`state_mismatch`, `token_exchange_failed`, `no_refresh_token_reconnect`, …).
- **Encryption at rest:** `refreshTokenEnc` / `accessTokenEnc` are AES-256-GCM
  ciphertexts bound to the sender account via additional authenticated data
  (`tokenAad(accountId, "refreshToken")`), so a ciphertext cannot be replayed
  for a different account.
- **`offline` + `prompt=consent`:** requested so a refresh token is issued.
  If Google still returns no refresh token, the callback asks you to reconnect.

## Troubleshooting

| Symptom                                   | Cause / fix                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                   | The redirect URI in Google Cloud does not match `GOOGLE_REDIRECT_URI`.        |
| `no_refresh_token_reconnect`              | Access was granted without `prompt=consent`. Remove the app's access and retry. |
| `state_mismatch` / `state_invalid`        | Cookies blocked, or the flow took longer than 10 minutes. Retry.             |
| `email_not_verified`                      | The Google account's email is not verified.                                  |
| `account_limit_reached`                   | You hit `MAX_SENDER_ACCOUNTS`; disconnect an account first.                   |
| `google_not_configured`                   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are unset.                       |
| `access_denied`                           | The user declined the consent screen.                                        |
| Sends fail with `invalid_grant`           | The refresh token was revoked (password change, admin revoke). Reconnect.     |

## Daily sending limits

The **application cap** (`dailyCap`, default 100) is enforced locally and is
always `MIN(configured cap, provider limit)`. It can only ever *lower* what
Gmail allows. Respect Google's sending limits for your account type; exceeding
them risks temporary or permanent blocks.
