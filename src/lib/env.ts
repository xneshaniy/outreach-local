import "dotenv/config";
import { z } from "zod";

/**
 * Central, validated environment access.
 *
 * - In production, missing/invalid configuration throws at startup (fail fast).
 * - In development, we fall back to clearly-marked local defaults so the app
 *   remains runnable with `cp .env.example .env`.
 */

const isProd = process.env.NODE_ENV === "production";

function devFallback(name: string, value: string): string {
  if (isProd) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  // Deterministic, obviously-fake local development value.
  console.warn(`[env] ${name} is not set — using an insecure development fallback.`);
  return value;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/outreach?schema=public"),

  AUTH_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: z.string().min(43).optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  EXTRA_ALLOWED_ORIGINS: z.string().optional(),

  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_API_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // Global dry run: no email ever leaves the machine. Individual campaigns
  // can also be put in dry-run mode.
  DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Route every send through the in-memory mock provider. Used for local
  // development and the automated tests - it never touches the network.
  MOCK_PROVIDER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_SCOPES: z
    .string()
    .default(
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    ),

  SENDER_DAILY_CAP_DEFAULT: z.coerce.number().int().min(1).max(2000).default(100),
  SENDER_QUOTA_TIMEZONE: z.string().default("UTC"),
  MAX_SENDER_ACCOUNTS: z.coerce.number().int().min(1).max(10).default(10),
  MIN_DAYS_BETWEEN_CONTACTS: z.coerce.number().int().min(0).default(3),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).default(120),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WORKER_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(5000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const e = parsed.data;

export const env = {
  nodeEnv: e.NODE_ENV,
  isProd: e.NODE_ENV === "production",
  appUrl: e.APP_URL,
  databaseUrl: e.DATABASE_URL,

  // Secrets ---------------------------------------------------------------
  // AUTH_SECRET / ENCRYPTION_KEY: generated per-installation. In dev we derive
  // stable local values so sessions/encryption keep working between restarts.
  authSecret: e.AUTH_SECRET ?? devFallback("AUTH_SECRET", "dev-only-insecure-auth-secret-change-me!!"),
  encryptionKey:
    e.ENCRYPTION_KEY ??
    devFallback("ENCRYPTION_KEY", Buffer.from("dev-only-insecure-encryption-key-32b").toString("base64")),
  sessionTtlSeconds: e.SESSION_TTL_SECONDS,
  extraOrigins: (e.EXTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Rate limiting ----------------------------------------------------------
  rateLimitEnabled: e.RATE_LIMIT_ENABLED,
  rateLimitAuthMax: e.RATE_LIMIT_AUTH_MAX,
  rateLimitAuthWindowSeconds: e.RATE_LIMIT_AUTH_WINDOW_SECONDS,
  rateLimitApiMax: e.RATE_LIMIT_API_MAX,
  rateLimitApiWindowSeconds: e.RATE_LIMIT_API_WINDOW_SECONDS,

  // Delivery ---------------------------------------------------------------
  /** When true, no email is ever handed to a provider. */
  dryRun: e.DRY_RUN,
  /** When true, the mock provider is used instead of a real one. */
  mockProvider: e.MOCK_PROVIDER,

  // Google ------------------------------------------------------------------
  googleClientId: e.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: e.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: e.GOOGLE_REDIRECT_URI ?? `${e.APP_URL}/api/google/callback`,
  googleScopes: e.GOOGLE_SCOPES.split(/\s+/).filter(Boolean),
  get googleConfigured() {
    return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
  },

  // Sending policy ----------------------------------------------------------
  senderDailyCapDefault: e.SENDER_DAILY_CAP_DEFAULT,
  senderQuotaTimezone: e.SENDER_QUOTA_TIMEZONE,
  maxSenderAccounts: e.MAX_SENDER_ACCOUNTS,
  minDaysBetweenContacts: e.MIN_DAYS_BETWEEN_CONTACTS,

  // Worker ------------------------------------------------------------------
  workerPollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
  workerBatchSize: e.WORKER_BATCH_SIZE,
  workerLeaseSeconds: e.WORKER_LEASE_SECONDS,
  workerMaxAttempts: e.WORKER_MAX_ATTEMPTS,
  workerBackoffBaseMs: e.WORKER_BACKOFF_BASE_MS,

  logLevel: e.LOG_LEVEL,
} as const;

export type Env = typeof env;
