import { existsSync, readFileSync } from "fs";
import path from "path";

/**
 * Test environment bootstrap.
 * - Loads `.env` (if present) so local settings apply.
 * - Integration tests opt in via TEST_DATABASE_URL; when set it REPLACES
 *   DATABASE_URL before the Prisma client is first used.
 * - Uses obvious test-only secrets when nothing is configured.
 */

// Next.js types NODE_ENV as read-only; assign through Object.assign instead.
Object.assign(process.env, { NODE_ENV: "test" });

const envPath = path.resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!;
    }
  }
}

process.env.AUTH_SECRET ??= "test-auth-secret-0123456789abcdefghijklmnop";
process.env.ENCRYPTION_KEY ??= Buffer.from("01234567890123456789012345678901").toString("base64");
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_ENABLED = "false";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
