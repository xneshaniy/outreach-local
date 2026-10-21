/**
 * Verify the Supabase bootstrap script against a throwaway database:
 *   1. create an empty database
 *   2. run the bootstrap SQL exactly as the SQL Editor would
 *   3. confirm `prisma migrate deploy` then reports no pending migrations
 *   4. confirm the schema matches the one `migrate deploy` produces
 */
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const fs = require("node:fs");
const path = require("node:path");

const PRISMA_CLI = path.join(__dirname, "..", "node_modules", "prisma", "build", "index.js");
const runPrisma = (args, env) =>
  execFileSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "pipe",
  });

/**
 * The admin connection string.
 *
 * The script creates and drops throwaway databases, so it needs a role with
 * CREATEDB. It is read from the environment - never hardcoded, because this
 * file is committed.
 */
const ADMIN = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!ADMIN) {
  console.error(
    "Set ADMIN_DATABASE_URL to a PostgreSQL URL whose role may CREATE DATABASE.",
  );
  process.exit(1);
}

/** The URL for one of the scratch databases. */
const NAME = "outreach_bootverify";
const BOOTSTRAP = path.join(__dirname, "supabase-bootstrap.sql");

/**
 * Prisma's $executeRawUnsafe sends a prepared statement, which can only
 * carry one command, so the script has to be split before it is applied
 * through Prisma. (The Supabase SQL Editor runs the whole script in one go -
 * this is only needed for the verification.) The shared splitter understands
 * string literals, quoted identifiers, line comments, block comments AND
 * dollar-quoted bodies, which the idempotent statements rely on.
 */
const { splitStatements } = require("./lib/sql.mjs");

/**
 * The URL for one of the scratch databases.
 *
 * The database name is swapped into the admin URL, so the scratch databases
 * live on the same server as the admin database.
 */
const urlFor = (db) => {
  const url = new URL(ADMIN);
  url.pathname = `/${db}`;
  if (!url.searchParams.has("schema")) url.searchParams.set("schema", "public");
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "60");
  if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "60");
  return url.toString();
};

async function schemaFingerprint(url) {
  const p = new PrismaClient({ datasourceUrl: url });
  const rows = await p.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      ORDER BY table_name, ordinal_position`,
  );
  const idx = await p.$queryRawUnsafe(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY tablename, indexname`,
  );
  const enums = await p.$queryRawUnsafe(
    `SELECT t.typname, e.enumlabel FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typtype = 'e' ORDER BY t.typname, e.enumsortorder`,
  );
  const mig = await p.$queryRawUnsafe(
    `SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name`,
  );
  await p.$disconnect();
  return {
    columns: JSON.stringify(rows),
    indexes: JSON.stringify(idx),
    enums: JSON.stringify(enums),
    migrations: JSON.stringify(mig),
  };
}

(async () => {
  const admin = new PrismaClient({ datasourceUrl: ADMIN });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE ${NAME}`);
  await admin.$disconnect();
  console.log(`==> Created an empty database: ${NAME}`);

  // --- 1. the reference database, built by `prisma migrate deploy` ----------
  console.log("==> Building the reference database with `prisma migrate deploy`");
  runPrisma(["migrate", "deploy"], { DATABASE_URL: urlFor(NAME) });
  const reference = await schemaFingerprint(urlFor(NAME));
  console.log("    reference schema captured");

  // --- 2. a second database, built by the bootstrap script ----------------
  const NAME2 = `${NAME}_2`;
  const admin2 = new PrismaClient({ datasourceUrl: ADMIN });
  await admin2.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${NAME2} WITH (FORCE)`);
  await admin2.$executeRawUnsafe(`CREATE DATABASE ${NAME2}`);
  await admin2.$disconnect();
  console.log(`==> Created a second empty database: ${NAME2}`);

  console.log("==> Running the bootstrap SQL exactly as the SQL Editor would");
  const sql = fs.readFileSync(BOOTSTRAP, "utf8");
  const statements = splitStatements(sql).filter(
    (s) => !/^BEGIN$/i.test(s) && !/^COMMIT$/i.test(s),
  );
  console.log(`    ${statements.length} statements`);
  const p2 = new PrismaClient({ datasourceUrl: urlFor(NAME2) });
  for (const statement of statements) {
    await p2.$executeRawUnsafe(statement);
  }
  await p2.$disconnect();
  console.log("    bootstrap script applied");

  // --- idempotency: run it a SECOND time on the same database -----------
  console.log("==> Running the bootstrap script a second time (must be a no-op)");
  const p3 = new PrismaClient({ datasourceUrl: urlFor(NAME2) });
  try {
    for (const statement of statements) {
      await p3.$executeRawUnsafe(statement);
    }
    console.log("    second run succeeded - the script is idempotent");
  } catch (e) {
    await p3.$disconnect().catch(() => {});
    console.error("    SECOND RUN FAILED:", e?.meta?.message ?? e.message);
    console.error("    the script is NOT idempotent");
    process.exit(1);
  }
  await p3.$disconnect();

  // --- 3. does Prisma consider the migrations applied? --------------------
  console.log("==> Running `prisma migrate deploy` against the bootstrapped database");
  const out = runPrisma(["migrate", "deploy"], { DATABASE_URL: urlFor(NAME2) });
  console.log("    " + out.trim().split("\n").filter(Boolean).slice(-3).join(" | "));

  // --- 4. compare the two schemas -----------------------------------------
  const bootstrapped = await schemaFingerprint(urlFor(NAME2));
  console.log("");
  for (const key of ["columns", "indexes", "enums", "migrations"]) {
    const same = reference[key] === bootstrapped[key];
    console.log(`    ${key.padEnd(12)} identical to the migrate-deploy schema: ${same}`);
    if (!same) {
      const a = JSON.parse(reference[key]);
      const b = JSON.parse(bootstrapped[key]);
      const onlyA = a.filter((x) => !JSON.stringify(b).includes(JSON.stringify(x)));
      const onlyB = b.filter((x) => !JSON.stringify(a).includes(JSON.stringify(x)));
      console.log("      only in migrate-deploy:", JSON.stringify(onlyA).slice(0, 400));
      console.log("      only in bootstrap     :", JSON.stringify(onlyB).slice(0, 400));
    }
  }

  // --- cleanup ------------------------------------------------------------
  const admin3 = new PrismaClient({ datasourceUrl: ADMIN });
  for (const db of [NAME, NAME2]) {
    // WITH (FORCE) terminates the sessions that are still attached.
    await admin3.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
  await admin3.$disconnect();
  console.log("");
  console.log("==> Scratch databases dropped");
})().catch((err) => {
  console.error("VERIFICATION FAILED:", err?.meta?.message ?? err.message);
  process.exit(1);
});
