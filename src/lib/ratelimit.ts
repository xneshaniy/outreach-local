import { dbRetry, prisma } from "./db";
import { env } from "./env";
import { ApiError } from "./errors";

/**
 * Postgres-backed fixed-window rate limiter.
 *
 * Uses an atomic INSERT ... ON CONFLICT DO UPDATE so it stays correct with
 * multiple app instances (unlike an in-memory Map).
 */
export async function enforceRateLimit(key: string, max: number, windowSeconds: number): Promise<void> {
  if (!env.rateLimitEnabled) return;

  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);

  const rows = await dbRetry(() =>
    prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "RateLimit" ("id", "key", "windowStart", "count", "createdAt")
      VALUES (gen_random_uuid()::text, ${key}, ${windowStart}, 1, now())
      ON CONFLICT ("key", "windowStart")
      DO UPDATE SET "count" = "RateLimit"."count" + 1
      RETURNING "count"`,
  );

  const count = rows[0]?.count ?? 1;
  if (count > max) {
    throw ApiError.tooMany(`Too many requests. Try again in ${windowSeconds}s.`);
  }
}

export function authLimitKey(kind: string, identifier: string): string {
  return `rl:auth:${kind}:${identifier}`;
}

export function apiLimitKey(userId: string, endpoint: string): string {
  return `rl:api:${userId}:${endpoint}`;
}
