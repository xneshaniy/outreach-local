import { Prisma, PrismaClient } from "@prisma/client";
import { env } from "./env";

/**
 * Prisma client singleton.
 * - Survives Next.js dev-mode hot reloads (globalThis cache).
 * - Logs queries only at debug level; never logs binds (may contain tokens).
 */

/**
 * Normalise the connection string.
 *
 * Managed Postgres (Neon, Supabase, PgBouncer, ...) suspends idle instances and
 * uses a transaction pooler. Two failure modes show up otherwise:
 *
 *  1. "Can't reach database server" — the instance was asleep and the cold
 *     start took longer than Prisma's 5 s default `connect_timeout`.
 *  2. "Timed out fetching a new connection from the connection pool" — the
 *     pooler multiplexes connections, so a connection that died while the
 *     instance was suspended is never evicted until the pool timeout.
 *
 * We therefore enforce generous timeouts. `connection_limit` is left alone so
 * it can be tuned per deployment.
 */
function normalizeDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "60");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "60");
    if (!url.searchParams.has("socket_timeout")) url.searchParams.set("socket_timeout", "60");
    // Always pin the schema. A pooled connection can inherit a search_path
    // from another session (a `migrate diff --shadow-database-url` run once
    // left `search_path=shadow_diff` on the whole pooler), which would make
    // every query look for its tables in the wrong schema.
    if (!url.searchParams.has("schema")) url.searchParams.set("schema", "public");
    return url.toString();
  } catch {
    // Not a parseable URL (e.g. a unix socket path) — use it verbatim.
    return raw;
  }
}

/**
 * Transient database failures that are worth retrying.
 *
 * These are all "the connection went away" errors, typically caused by a
 * managed database waking up from an idle suspend. The work was not applied,
 * so retrying is safe for reads; for writes the caller is inside a
 * transaction, which is rolled back before the error propagates.
 */
const TRANSIENT_PATTERNS = [
  /can't reach database server/i,
  /timed out fetching a new connection/i,
  /server has closed the connection/i,
  /connection (?:was )?closed/i,
  /connection reset/i,
  /econnreset/i,
  /econnrefused/i,
  /epipe/i,
  /terminating connection/i,
  /the database system is (?:starting up|shutting down)/i,
  /P1001/i,
  /P1002/i,
  /P1008/i,
  /P1010/i,
  /P1017/i,
];

export function isTransientDbError(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  if (!message) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a database operation, retrying transient connection failures.
 *
 * Used for raw SQL (`$queryRaw` / `$executeRaw`) which is not covered by the
 * model-operation retry installed on the client below.
 */
export async function dbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === attempts - 1) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClientWithRetry };

function createClient() {
  const base = new PrismaClient({
    log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
    datasourceUrl: normalizeDatabaseUrl(env.databaseUrl),
  });

  // Retry transient connection failures for every model operation, so a
  // database that was just woken up from an idle suspend does not surface as
  // a 500 to the user.
  return base.$extends({
    name: "transient-retry",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return dbRetry(() => query(args));
        },
      },
    },
  });
}

/** The Prisma client with the transient-retry extension applied. */
export type PrismaClientWithRetry = ReturnType<typeof createClient>;

/**
 * A transactional client (`tx` inside `prisma.$transaction`).
 *
 * Derived from the extended client so it keeps the retry behaviour and stays
 * type-compatible with the plain `Prisma.TransactionClient`.
 */
export type TxLike = Omit<
  PrismaClientWithRetry,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export const prisma: PrismaClientWithRetry = globalForPrisma.prisma ?? createClient();

if (env.nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Db = PrismaClientWithRetry;

/**
 * Helper for transaction-scoped code. Re-exported for readability.
 */
export const transaction = prisma.$transaction.bind(prisma);

export { Prisma };
