import { PrismaClient } from "@prisma/client";
import { env } from "./env";

/**
 * Prisma client singleton.
 * - Survives Next.js dev-mode hot reloads (globalThis cache).
 * - Logs queries only at debug level; never logs binds (may contain tokens).
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (env.nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Db = PrismaClient;

/**
 * Helper for transaction-scoped code. Re-exported for readability.
 */
export const transaction = prisma.$transaction.bind(prisma);
