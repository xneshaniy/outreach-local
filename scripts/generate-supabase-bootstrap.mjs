/**
 * Generate a single SQL script that brings an EMPTY PostgreSQL database up to
 * the current schema, and records the migrations so Prisma considers them
 * applied.
 *
 * Why this exists: Hostinger's shared hosting only offers MySQL, so the
 * database lives on Supabase. Applying the migrations normally needs either
 * the database password (for `prisma migrate deploy`) or the Supabase CLI
 * linked with an access token. The Supabase **SQL Editor** needs neither - it
 * runs SQL against the project straight from the dashboard.
 *
 * The script is generated from the committed migrations, so it can never
 * drift from them. The recorded checksums are the plain SHA-256 of each
 * migration file, which is exactly what Prisma stores - so a later
 * `prisma migrate deploy` reports "no pending migrations" instead of trying
 * to apply them a second time.
 *
 * Usage:
 *   node scripts/generate-supabase-bootstrap.mjs [output-file]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = path.join(root, "prisma", "migrations");
const outFile = path.resolve(process.argv[2] ?? path.join(root, "scripts", "supabase-bootstrap.sql"));

/** Prisma's own bookkeeping table, exactly as the Prisma CLI creates it. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_steps_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY (id)
);`;

/** A stable id per migration, so re-running the script does not duplicate rows. */
function deterministicId(name) {
  const hash = crypto.createHash("sha256").update(`prisma-migration:${name}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

const migrations = fs
  .readdirSync(migrationDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(migrationDir, name, "migration.sql")))
  .sort();

if (migrations.length === 0) {
  console.error("No migrations found in prisma/migrations.");
  process.exit(1);
}

const parts = [
  "-- =============================================================================",
  "-- Email Outreach Platform - Supabase bootstrap",
  "-- =============================================================================",
  "--",
  "-- Run this ONCE in the Supabase SQL Editor:",
  "--   Supabase -> your project -> SQL Editor -> New query -> paste -> Run",
  "--",
  "-- It creates the whole schema and records the migrations, so a later",
  "--   npx prisma migrate deploy",
  "-- reports \"no pending migrations\" instead of applying them twice.",
  "--",
  `-- Generated from prisma/migrations (${migrations.length} migrations).`,
  "-- Do not edit by hand - regenerate with:",
  "--   node scripts/generate-supabase-bootstrap.mjs",
  "-- =============================================================================",
  "",
  "BEGIN;",
  "",
  "-- Prisma's migration bookkeeping.",
  MIGRATIONS_TABLE,
  "",
];

for (const name of migrations) {
  const sql = fs.readFileSync(path.join(migrationDir, name, "migration.sql"), "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  const id = deterministicId(name);

  parts.push("-- =============================================================================");
  parts.push(`-- migration: ${name}`);
  parts.push("-- =============================================================================");
  parts.push(sql.trim());
  parts.push("");
  parts.push(
    `-- Record it as applied (checksum = sha256 of ${name}/migration.sql).`,
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, logs, rolled_back_at, started_at, finished_at, applied_steps_count)`,
    `VALUES ('${id}', '${checksum}', '${name}', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
    `ON CONFLICT (id) DO NOTHING;`,
    "",
  );
}

parts.push("COMMIT;", "");
parts.push("-- Done. The schema is in place and the migrations are recorded.");
parts.push("");

fs.writeFileSync(outFile, parts.join("\n"), "utf8");

const size = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`==> Bootstrap script written: ${outFile} (${size} KB, ${migrations.length} migrations)`);
for (const name of migrations) {
  console.log(`    - ${name}`);
}
