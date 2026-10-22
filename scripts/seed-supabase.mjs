/**
 * Apply the migrations to Supabase and seed the demo workspace.
 *
 * The connection string comes from .env.supabase, which is gitignored and
 * written by scripts/provision-supabase.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const REF = process.env.SUPABASE_PROJECT_REF ?? "rkxohuoiggoxgpbcgoda";
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const API = "https://api.supabase.com";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sql(query) {
  const res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// --- remove the unused role left over from the first attempt ---------------
if (PAT) {
  console.log("==> Removing the unused 'outreach_app' role");
  try {
    await sql(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM outreach_app;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM outreach_app;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM outreach_app;
      REVOKE ALL ON SCHEMA public FROM outreach_app;
      DROP ROLE IF EXISTS outreach_app;
    `);
    console.log("    done");
  } catch (e) {
    console.log("    skipped:", String(e.message).slice(0, 120));
  }
}

// --- migrate + seed --------------------------------------------------------
const secretFile = path.join(root, ".env.supabase");
const url = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(secretFile, "utf8"))?.[1]?.trim();
if (!url) {
  console.error("DATABASE_URL not found in .env.supabase");
  process.exit(1);
}

const run = (label, command, args) => {
  console.log(`\n==> ${label}`);
  const out = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(out.trim().split("\n").slice(-8).join("\n"));
};

run("Applying migrations", "npx prisma migrate deploy", []);
run("Seeding the demo workspace", "npx tsx prisma/seed.ts", []);

// --- verify ----------------------------------------------------------------
const prisma = new PrismaClient({ datasourceUrl: url });
const counts = await prisma.$queryRawUnsafe(`
  SELECT
    (SELECT count(*) FROM "User") AS users,
    (SELECT count(*) FROM "Service") AS services,
    (SELECT count(*) FROM "LeadStage") AS stages,
    (SELECT count(*) FROM "EmailTemplate") AS templates,
    (SELECT count(*) FROM "Campaign") AS campaigns,
    (SELECT count(*) FROM "Contact") AS contacts,
    (SELECT count(*) FROM "Client") AS clients,
    (SELECT count(*) FROM _prisma_migrations) AS migrations
`);
console.log("\n==> Row counts");
console.log(counts[0]);
await prisma.$disconnect();
