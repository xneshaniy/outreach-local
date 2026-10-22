/**
 * Rotate the application's AUTH_SECRET and ENCRYPTION_KEY.
 *
 * Both were exposed in a conversation, so they are being replaced.
 *
 * This is only safe when nothing depends on the old values:
 *   - AUTH_SECRET signs the session cookie. Sessions are stateless JWTs, so
 *     there is no server-side session row to invalidate; existing cookies
 *     simply stop working and people sign in again.
 *   - ENCRYPTION_KEY encrypts the provider tokens stored on SenderAccount
 *     rows. With no connected sender account there is nothing encrypted to
 *     lose.
 *
 * The script refuses to rotate when a sender account exists, so it can never
 * silently invalidate stored credentials.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.hostinger");

if (!fs.existsSync(envFile)) {
  console.error(".env.hostinger is missing.");
  process.exit(1);
}

const url = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(envFile, "utf8"))?.[1]?.trim();
if (!url) {
  console.error("DATABASE_URL not found in .env.hostinger");
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: url });

// --- the safety check ------------------------------------------------------
const senders = await prisma.senderAccount.findMany({
  select: {
    id: true,
    email: true,
    smtpPasswordEnc: true,
    accessTokenEnc: true,
    refreshTokenEnc: true,
  },
});
const withSecrets = senders.filter(
  (s) => s.smtpPasswordEnc || s.accessTokenEnc || s.refreshTokenEnc,
);

console.log(`==> Connected sender accounts: ${senders.length}`);
console.log(`==> With encrypted provider credentials: ${withSecrets.length}`);

if (withSecrets.length > 0) {
  await prisma.$disconnect();
  console.error("");
  console.error("REFUSING to rotate: stored provider tokens are encrypted with the");
  console.error("current ENCRYPTION_KEY and would become unreadable.");
  console.error("Reconnect every sender account after rotating, or rotate only");
  console.error("AUTH_SECRET.");
  process.exit(1);
}

// --- rotate ----------------------------------------------------------------
const authSecret = crypto.randomBytes(64).toString("base64");
const encryptionKey = crypto.randomBytes(32).toString("base64");

let env = fs.readFileSync(envFile, "utf8");
env = env.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${authSecret}`);
env = env.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${encryptionKey}`);
fs.writeFileSync(envFile, env, "utf8");

// The other gitignored file, so the local tooling uses the same values.
const secretFile = path.join(root, ".env.supabase");
if (fs.existsSync(secretFile)) {
  let secret = fs.readFileSync(secretFile, "utf8");
  secret = secret.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${authSecret}`);
  secret = secret.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${encryptionKey}`);
  fs.writeFileSync(secretFile, secret, "utf8");
}

console.log("");
console.log("==> AUTH_SECRET and ENCRYPTION_KEY were rotated");
console.log("    They are written to .env.hostinger and .env.supabase (both");
console.log("    gitignored). They are not printed here on purpose.");
console.log("    Paste the same values into the hosting panel.");

await prisma.$disconnect();
