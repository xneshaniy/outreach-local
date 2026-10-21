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
 * WHY THE FILE IS FORMATTED THE WAY IT IS
 *
 * The script is pasted into a browser editor, and a long line is the most
 * fragile thing you can hand one: a soft-wrapped line copied out of a
 * rendered view can lose or gain a character, and a single stray quote
 * inside a 64-character hex literal turns the statement into
 *
 *   ERROR: 42601: trailing junk after numeric literal at or near "0f80cb..."
 *
 * So every value of the migration records sits on its own line, no line is
 * longer than MAX_LINE_LENGTH, and the output is plain ASCII. The generator
 * enforces all three, so the file cannot regress into something that is
 * awkward - or impossible - to paste.
 *
 * Usage:
 *   node scripts/generate-supabase-bootstrap.mjs [output-file]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "./lib/sql.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = path.join(root, "prisma", "migrations");
const outFile = path.resolve(process.argv[2] ?? path.join(root, "scripts", "supabase-bootstrap.sql"));

/** No line may be longer than this, so the script pastes cleanly. */
const MAX_LINE_LENGTH = 100;

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

/** Keep the generated file plain ASCII. */
const ascii = (text) =>
  text
    .replace(/\u2014/g, "--") // em dash
    .replace(/\u2013/g, "-") // en dash
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u00a0/g, " ");

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

const parts = [];
/** The lines this script writes itself - they must stay short. */
const authoredLines = [];
/** Add a line (or lines) that this script authors. */
const say = (...values) => {
  for (const value of values) {
    parts.push(value);
    authoredLines.push(value);
  }
};

say(
  "-- =============================================================================",
  "-- Email Outreach Platform - Supabase bootstrap",
  "-- =============================================================================",
  "--",
  "-- Run this ONCE in the Supabase SQL Editor:",
  "--   Supabase -> your project -> SQL Editor -> New query -> paste -> Run",
  "--",
  "--",
  "--  ***  THIS SCRIPT REBUILDS THE public SCHEMA.  ***",
  "--",
  "--  It drops everything in the public schema and recreates it from the",
  "--  committed migrations. That is what makes it reliable, and safe to run",
  "--  more than once: the result is always exactly the schema that",
  "--  'prisma migrate deploy' produces.",
  "--",
  "--  If the database already holds data you want to keep, do NOT run this.",
  "--  Use 'npx prisma migrate deploy' instead - it never drops anything.",
  "--",
  "--",
  "-- It creates the whole schema and records the migrations, so a later",
  "-- 'npx prisma migrate deploy' reports \"no pending migrations to apply\"",
  "-- instead of trying to apply them a second time.",
  "--",
  `-- Generated from prisma/migrations (${migrations.length} migrations).`,
  "-- Do not edit by hand - regenerate with:",
  "--   node scripts/generate-supabase-bootstrap.mjs",
  "-- =============================================================================",
  "",
  "BEGIN;",
  "",
  "-- --------------------------------------------------------------------------",
  "-- Start from a clean schema, then replay the migrations exactly as they",
  "-- were written. The result is the schema that 'prisma migrate deploy'",
  "-- produces, including the two partial unique indexes that MySQL cannot",
  "-- express.",
  "-- --------------------------------------------------------------------------",
  "DROP SCHEMA IF EXISTS public CASCADE;",
  "CREATE SCHEMA public;",
  "-- Restore the grants for whichever of these roles exist. Supabase has",
  "-- postgres, anon and authenticated; another provider may not.",
  "DO $grants$",
  "DECLARE r record;",
  "BEGIN",
  "  FOR r IN SELECT rolname FROM pg_roles",
  "             WHERE rolname IN ('postgres', 'anon', 'authenticated')",
  "  LOOP",
  "    EXECUTE format('GRANT ALL ON SCHEMA public TO %I', r.rolname);",
  "  END LOOP;",
  "END",
  "$grants$;",
  "",
  "-- Prisma's migration bookkeeping.",
);
say(...MIGRATIONS_TABLE.split("\n"));
say("");

for (const name of migrations) {
  const sql = fs.readFileSync(path.join(migrationDir, name, "migration.sql"), "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  const id = deterministicId(name);

  // The migration SQL is copied verbatim: it is the DDL that
  // `prisma migrate deploy` runs, and the schema was just emptied, so it
  // applies exactly once, exactly as it would there.
  const statements = splitStatements(ascii(sql)).filter((statement) => statement.length > 0);

  parts.push("-- =============================================================================");
  parts.push(`-- migration: ${name}`);
  parts.push("-- =============================================================================");
  for (const statement of statements) {
    parts.push(statement + ";");
  }
  parts.push("");

  // The bookkeeping row is authored, so every value gets its own line: a
  // 64-character checksum on a line of its own cannot be split by a
  // re-wrap, and cannot lose the quote that closes it.
  say(
    "-- Record it as applied (checksum = sha256 of the migration file).",
    'INSERT INTO "_prisma_migrations" (',
    "    id,",
    "    checksum,",
    "    migration_name,",
    "    logs,",
    "    rolled_back_at,",
    "    started_at,",
    "    finished_at,",
    "    applied_steps_count",
    ") VALUES (",
    `    '${id}',`,
    `    '${checksum}',`,
    `    '${name}',`,
    "    NULL,",
    "    NULL,",
    "    CURRENT_TIMESTAMP,",
    "    CURRENT_TIMESTAMP,",
    "    1",
    ")",
    "ON CONFLICT (id) DO NOTHING;",
    "",
  );
}

say(
  "COMMIT;",
  "",
  "-- --------------------------------------------------------------------------",
  "-- Verification. Run this after the script; the counts must be non-zero.",
  "-- --------------------------------------------------------------------------",
  "SELECT",
  "    (SELECT count(*) FROM information_schema.tables",
  "      WHERE table_schema = 'public'",
  "        AND table_name <> '_prisma_migrations') AS tables,",
  "    (SELECT count(*) FROM pg_type WHERE typtype = 'e') AS enums,",
  "    (SELECT count(*) FROM pg_indexes",
  "      WHERE schemaname = 'public') AS indexes,",
  "    (SELECT count(*) FROM _prisma_migrations) AS migrations;",
  "",
);

/**
 * Scan the file the way a SQL parser does, so the guard understands comments
 * and strings instead of guessing from quote counts.
 *
 * @returns {{ problems: string[], literals: Array<{ value: string, line: number, spansLines: boolean }> }}
 */
function scan(sql) {
  const problems = [];
  const literals = [];

  let line = 1;
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        line += 1;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") line += 1;
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const startLine = line;
      let value = "";
      let spansLines = false;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        if (sql[i] === "\n") {
          spansLines = true;
          line += 1;
        }
        value += sql[i];
        i += 1;
      }
      literals.push({ value, line: startLine, spansLines });
      continue;
    }
    if (ch === "\n") line += 1;
    i += 1;
  }

  if (inBlockComment) problems.push("a block comment is never closed");
  for (const literal of literals) {
    if (literal.spansLines) {
      problems.push(`line ${literal.line}: a string literal spans more than one line: ${JSON.stringify(literal.value.slice(0, 40))}`);
    }
    if (literal.value.length > 80) {
      problems.push(`line ${literal.line}: a ${literal.value.length}-character literal: ${literal.value.slice(0, 40)}...`);
    }
  }

  return { problems, literals };
}

const output = parts.join("\n");

// --- Guards -----------------------------------------------------------------
/**
 * The script is pasted into a browser editor, so it has to survive a
 * re-wrap. Two things matter:
 *
 *   1. Every string literal must sit entirely on one line. A literal split
 *      across lines is how a checksum ends up as
 *      "trailing junk after numeric literal at or near 0f80cb...".
 *   2. The file must be plain ASCII, so a copy out of a rendered view cannot
 *      carry a smart quote that silently closes a literal early.
 *
 * The DDL from the migrations is copied verbatim and may have long lines -
 * that is harmless, because a wrapped DDL line is still valid SQL.
 */
const problems = [];
const lines = output.split("\n");

for (const [index, line] of lines.entries()) {
  for (const char of line) {
    if (char.codePointAt(0) > 126) {
      problems.push(`line ${index + 1} is not ASCII: ${JSON.stringify(line.slice(0, 50))}`);
      break;
    }
  }
}

problems.push(...scan(output).problems);

// The lines this script authors itself must be short.
for (const [index, line] of authoredLines.entries()) {
  if (line.length > MAX_LINE_LENGTH) {
    problems.push(`authored line ${index + 1} is ${line.length} characters (max ${MAX_LINE_LENGTH}): ${line.slice(0, 60)}...`);
  }
}

if (problems.length > 0) {
  console.error("The generated script would be fragile to paste:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

fs.writeFileSync(outFile, output, "utf8");

const size = (fs.statSync(outFile).size / 1024).toFixed(1);
const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
console.log(`==> Bootstrap script written: ${outFile}`);
console.log(`    ${size} KB, ${lines.length} lines, longest line ${longest} characters, ASCII only`);
console.log("    every string literal is on a single line");
console.log(`    ${migrations.length} migrations:`);
for (const name of migrations) console.log(`      - ${name}`);
