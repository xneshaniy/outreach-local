import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ApiError } from "./errors";
import { sha256 } from "./crypto";

/**
 * API request idempotency.
 *
 * Mutating endpoints that can be retried by clients accept an
 * `Idempotency-Key` header. The first request stores the outcome; replays with
 * the same key + body return the stored response and create NO new rows.
 * Reuse with a different body is rejected (409).
 */
export async function withIdempotency<T>(
  userId: string,
  endpoint: string,
  key: string | null,
  requestBody: unknown,
  handler: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!key) {
    return { result: await handler(), replayed: false };
  }

  const requestHash = sha256(JSON.stringify(requestBody ?? null));

  // Atomic claim of the key. If we lose the race, wait for the stored result.
  const claimed = await prisma.idempotencyKey.createMany({
    data: [{ userId, key, endpoint, requestHash }],
    skipDuplicates: true,
  });

  if (claimed.count === 0) {
    // Key already used — verify it was the same request.
    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) {
      // Extremely unlikely race (row deleted between calls) — treat as new.
      return { result: await handler(), replayed: false };
    }
    if (existing.requestHash && existing.requestHash !== requestHash) {
      throw ApiError.conflict("Idempotency-Key was already used with a different payload.");
    }
    if (existing.responseBody != null) {
      return { result: existing.responseBody as T, replayed: true };
    }
    // Original request still in flight — tell the client to retry.
    throw ApiError.conflict("A request with this Idempotency-Key is still in progress.");
  }

  try {
    const result = await handler();
    await prisma.idempotencyKey.updateMany({
      where: { userId, key },
      data: { responseBody: result as Prisma.InputJsonValue, responseStatus: 200 },
    });
    return { result, replayed: false };
  } catch (err) {
    // Release the key so an honest retry can succeed.
    await prisma.idempotencyKey.deleteMany({ where: { userId, key } });
    throw err;
  }
}
