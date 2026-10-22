/**
 * Provision the Supabase database for the application.
 *
 * Why the `postgres` role and not a dedicated one:
 *
 * Supabase enables Row Level Security on every table in the public schema,
 * with no policies. A role that does NOT own the tables is therefore subject
 * to RLS, and with no policies every read and every write is denied - even
 * for a role that has been granted the table privileges. The table OWNER
 * bypasses RLS, so the application connects as `postgres`, which is also the
 * role `prisma migrate deploy` needs.
 *
 * RLS stays enabled, which is what protects the project: the `anon` and
 * `authenticated` roles - the ones the publishable API key maps to - still
 * cannot read or write anything, because there are no policies for them.
 *
 * The personal access token is read from the environment and is never
 * written to disk.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const REF = process.env.SUPABASE_PROJECT_REF ?? "rkxohuoiggoxgpbcgoda";
const REGION = process.env.SUPABASE_REGION ?? "ap-northeast-1";
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const API = "https://api.supabase.com";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!PAT) {
  console.error("Set SUPABASE_ACCESS_TOKEN (the personal access token).");
  process.exit(1);
}

/** A password that is safe inside a connection string. */
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

async function sql(query) {
  const res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

const password = generatePassword();

console.log("==> Setting the database password for the postgres role");
// The Management API sets the postgres role's password with PATCH. The SQL
// endpoint cannot do it: it runs as postgres, and only a superuser may
// alter a privileged role.
const reset = await api("PATCH", `/v1/projects/${REF}/database/password`, { password });
if (reset.status >= 300) {
  console.error(`    failed: ${reset.status} ${reset.text.slice(0, 300)}`);
  process.exit(1);
}
console.log("    done");

// The dedicated role could not work: it does not own the tables, so RLS
// applies to it and, with no policies, every statement is denied. Drop it so
// it cannot be used by accident.
console.log("==> Removing the unused dedicated role");
try {
  await sql(`
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outreach_app') THEN
        EXECUTE 'DROP OWNED BY outreach_app';
        EXECUTE 'DROP ROLE outreach_app';
      END IF;
    END
    $do$;
  `);
  console.log("    done");
} catch (e) {
  console.log("    skipped:", String(e.message).split("\n")[0].slice(0, 80));
}

const url =
  `postgresql://postgres.${REF}:${password}@aws-0-${REGION}.pooler.supabase.com:5432/postgres` +
  `?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60`;

console.log("\n==> Testing the connection");
const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
try {
  const rows = await prisma.$queryRawUnsafe("SELECT current_user AS usr, current_database() AS db");
  console.log(`    ${JSON.stringify(rows[0])}`);
} catch (e) {
  await prisma.$disconnect().catch(() => {});
  console.error("    FAILED:", String(e.message).split("\n").slice(-1)[0]);
  process.exit(1);
}
await prisma.$disconnect();

console.log("\n==> The connection string");
console.log(`    ${url.replace(password, "••••••••")}`);

const envFile = path.join(root, ".env.hostinger");
let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
env = env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`);
fs.writeFileSync(envFile, env, "utf8");

const secretFile = path.join(root, ".env.supabase");
fs.writeFileSync(secretFile, `DATABASE_URL=${url}\n`, "utf8");

console.log(`\n==> Written to ${path.relative(root, envFile)} and ${path.relative(root, secretFile)} (both gitignored)`);
console.log("    Paste the same DATABASE_URL into the hosting panel.");
