import { prisma, isTransientDbError } from "@/lib/db";
import { normalizeEmail, normalizeTimeZone } from "@/lib/email-normalize";

/**
 * Shared helpers for integration tests.
 *
 * These tests hit a REAL PostgreSQL database and are opt-in:
 *   TEST_DATABASE_URL=postgresql://... npx vitest run tests/integration
 *
 * The schema must already be migrated:
 *   DATABASE_URL=<test-db> npx prisma migrate deploy
 *
 * Every test truncates every table first, so tests are isolated and may run in
 * any order. Nothing here is ever executed against a production database —
 * `dbEnabled` is false unless TEST_DATABASE_URL is explicitly set.
 */

export const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);

async function listTables(): Promise<string[]> {
  const rows: Array<{ tablename: string }> = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  return rows.map((r) => r.tablename);
}

/** Fail fast with actionable instructions when the test DB has no schema. */
export async function preflight(): Promise<void> {
  const tables = await listTables();
  if (tables.length === 0) {
    throw new Error(
      "The test database has no tables. Run migrations first:\n" +
        "  DATABASE_URL=<test-db-url> npx prisma migrate deploy",
    );
  }
}

/** Truncate every application table (FK-safe) before each test. */
export async function resetDatabase(): Promise<void> {
  const tables = await listTables();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  await retryOnTransientDbError(() =>
    prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`),
  );
}

/**
 * Detect a transient infrastructure failure from the database.
 *
 * Re-exported from the application so the test suite and the running app
 * agree on exactly which failures are worth retrying. A managed, pooled
 * PostgreSQL can refuse to hand out a connection or fail to start a
 * transaction while the suite is hammering it; Prisma reports that as a
 * timeout instead of a business error. Such a failure says nothing about
 * the code under test, so the tests retry rather than assert on it.
 *
 * Business errors (a quota error, a unique-constraint violation, a failed
 * assertion) are NEVER classified as transient, so a real bug still fails.
 */
export { isTransientDbError };

/** Run an operation, retrying it while the database reports a transient error. */
export async function retryOnTransientDbError<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 1500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

let counter = 0;
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.test`;
}

export async function createTestUser(
  overrides: Partial<{ email: string; name: string; sessionVersion: number; minDaysBetweenContacts: number }> = {},
) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? uniqueEmail("owner"),
      // Not a bcrypt hash: password login is not exercised in integration tests.
      passwordHash: "$2b$12$integrationtestnotarealhash0000000000000000000000000000",
      name: overrides.name ?? "Test Owner",
      sessionVersion: overrides.sessionVersion ?? 0,
      minDaysBetweenContacts: overrides.minDaysBetweenContacts ?? 3,
    },
  });
}

export async function createTestCampaign(userId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return prisma.campaign.create({
    data: {
      userId,
      name: (overrides.name as string) ?? "Integration campaign",
      subject: (overrides.subject as string) ?? "Hello {{first_name}}",
      body: (overrides.body as string) ?? "<p>Hello {{first_name}}</p>",
      status: (overrides.status as "DRAFT" | "ACTIVE" | "PAUSED") ?? "DRAFT",
      ...(overrides.dailyLimit !== undefined ? { dailyLimit: overrides.dailyLimit as number } : {}),
      ...(overrides.dryRun !== undefined ? { dryRun: overrides.dryRun as boolean } : {}),
      ...(overrides.serviceId !== undefined ? { serviceId: overrides.serviceId as string } : {}),
      ...(overrides.followUpSequenceId !== undefined
        ? { followUpSequenceId: overrides.followUpSequenceId as string }
        : {}),
      ...(overrides.requiresApproval !== undefined
        ? { requiresApproval: overrides.requiresApproval as boolean }
        : {}),
      ...(overrides.windowStartMinute !== undefined
        ? { windowStartMinute: overrides.windowStartMinute as number }
        : {}),
      ...(overrides.windowEndMinute !== undefined
        ? { windowEndMinute: overrides.windowEndMinute as number }
        : {}),
      ...(overrides.sendingDays !== undefined
        ? { sendingDays: overrides.sendingDays as number[] }
        : {}),
    },
  });
}

/**
 * A campaign whose sending window covers every minute of every day.
 *
 * Tests that exercise the worker must not depend on the wall clock: with the
 * default 09:00-17:00 window the job is correctly rescheduled to the next
 * morning when the test runs in the evening.
 */
export async function createAlwaysOnCampaign(userId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return createTestCampaign(userId, {
    status: "ACTIVE",
    windowStartMinute: 0,
    windowEndMinute: 1439,
    sendingDays: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  });
}

export async function createTestContact(
  userId: string,
  email = uniqueEmail("contact"),
  timeZone: string | null | undefined = "Europe/London",
) {
  return prisma.contact.create({
    data: {
      userId,
      email,
      emailNormalized: normalizeEmail(email),
      timeZone: normalizeTimeZone(timeZone ?? undefined),
    },
  });
}

export async function createSenderAccount(
  userId: string,
  overrides: Partial<{ dailyCap: number; email: string }> = {},
) {
  return prisma.senderAccount.create({
    data: {
      userId,
      provider: "SMTP",
      email: overrides.email ?? uniqueEmail("sender"),
      status: "CONNECTED",
      dailyCap: overrides.dailyCap ?? 100,
      smtpHost: "smtp.example.test",
      smtpPort: 587,
      smtpUsername: "smtp-user",
      // AES-256-GCM blob for "not-a-real-password" (AAD: sender:<id>:smtpPassword)
      // is created lazily by the app; tests never open a connection.
      smtpPasswordEnc: null,
    },
  });
}

/** Create a scheduled recipient (+ its job) directly, bypassing CSV import. */
export async function createScheduledRecipient(opts: {
  campaignId: string;
  userId: string;
  contactId: string;
  scheduledAt?: Date;
}) {
  const scheduledAt = opts.scheduledAt ?? new Date();
  const recipient = await prisma.campaignRecipient.create({
    data: {
      campaignId: opts.campaignId,
      contactId: opts.contactId,
      status: "SCHEDULED",
      scheduledAt,
    },
  });
  const { enqueueJob } = await import("@/lib/queue");
  const job = await prisma.$transaction((tx) =>
    enqueueJob(tx, {
      campaignRecipientId: recipient.id,
      campaignId: opts.campaignId,
      contactId: opts.contactId,
      userId: opts.userId,
      scheduledAt,
    }),
  );
  return { recipient, job };
}
