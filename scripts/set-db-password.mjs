/**
 * Set the Supabase database password.
 *
 * The Management API sets the postgres role's password with PATCH. The SQL
 * endpoint cannot do it: it runs as postgres, and only a superuser may alter
 * a privileged role.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... node scripts/set-db-password.mjs [password]
 *
 * With no argument a strong password is generated and written to the local
 * (gitignored) files, so it never has to travel through a chat window.
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
  console.error("Usage: SUPABASE_ACCESS_TOKEN=... node scripts/set-db-password.mjs [password]");
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

const password = process.argv[2] || generatePassword();
const generated = !process.argv[2];

const res = await fetch(`${API}/v1/projects/${REF}/database/password`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
const text = await res.text();
if (res.status >= 300) {
  console.error(`failed: ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log("==> The database password was set");

const url =
  `postgresql://postgres.${REF}:${encodeURIComponent(password)}@aws-0-${REGION}.pooler.supabase.com:5432/postgres` +
  `?schema=public&sslmode=require&connect_timeout=60&pool_timeout=60`;

const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
const rows = await prisma.$queryRawUnsafe("SELECT current_user AS usr, current_database() AS db");
console.log(`==> Connected as ${JSON.stringify(rows[0])}`);
await prisma.$disconnect();

// Keep the local files in step.
for (const file of [".env.supabase", ".env.hostinger"]) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) continue;
  let content = fs.readFileSync(target, "utf8");
  content = content.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url}`);
  fs.writeFileSync(target, content, "utf8");
  console.log(`==> Updated ${file}`);
}

if (generated) {
  console.log("");
  console.log("A strong password was generated. It is in .env.supabase and");
  console.log(".env.hostinger on this machine - copy it from there, it is not");
  console.log("printed here on purpose.");
}
