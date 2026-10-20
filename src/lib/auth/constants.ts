/**
 * Edge-safe constants.
 *
 * This module MUST NOT import anything Node-specific (no `dotenv`, no Prisma,
 * no `next/headers`). It is imported by `src/middleware.ts`, which runs in the
 * Edge Runtime where Node built-ins are unavailable.
 */

/** Name of the HttpOnly session cookie. */
export const SESSION_COOKIE = "eop_session";

/** Name of the short-lived cookie holding the signed Google OAuth `state`. */
export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
