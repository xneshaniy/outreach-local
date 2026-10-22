/**
 * Run the whole validation suite and report each check.
 *
 * This is the "did I break anything" gate: schema, migrations, connectivity,
 * tests, types, lint, the production build, the deployment bundle, the secret
 * scan, and the health/auth smoke test.
 *
 *   node scripts/validate-all.cjs            # everything
 *   node scripts/validate-all.cjs --quick    # skip the long test suite
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");

const results = [];

function run(label, command, args, options = {}) {
  const started = Date.now();
  process.stdout.write(`\n=== ${label}\n    ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  results.push({ label, ok, seconds });

  if (!ok && options.quiet) {
    console.log((result.stdout ?? "") + (result.stderr ?? ""));
  }
  console.log(`    -> ${ok ? "PASS" : "FAIL"} (${seconds}s)`);
  return ok;
}

/** The application connection string, from the gitignored local file. */
function localEnv() {
  const values = {};
  for (const file of [".env.supabase", ".env.hostinger", ".env"]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    for (const line of fs.readFileSync(target, "utf8").split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return values;
}

const local = localEnv();
const url = process.env.DATABASE_URL ?? local.DATABASE_URL;
if (!url) {
  console.error("No DATABASE_URL found (.env.supabase or .env).");
  process.exit(1);
}

// The test database must not be behind a transaction pooler: the suite opens
// many transactions at once, and a pooler cannot serve them.
const testUrl = process.env.TEST_DATABASE_URL ?? local.TEST_DATABASE_URL ?? url;
const env = { DATABASE_URL: url };
const testEnv = { DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl };

// 1. Prisma schema and migrations
run("Prisma schema is valid", "npx prisma validate", [], { quiet: true });
run("Migration status", "npx prisma migrate status", [], { quiet: true, env });

// 2. Types, lint
run("TypeScript", "npx tsc --noEmit", [], { quiet: true });
run("ESLint", "npx eslint .", [], { quiet: true });

// 3. Tests
if (!quick) {
  run("Unit tests", "npx vitest run tests/unit", [], { quiet: true, env });
  run("Integration tests", "npx vitest run tests/integration", [], { quiet: true, env: testEnv });
}

// 4. Builds
run("Production build", "npx next build", [], { quiet: true, env });
run("Deployment bundle", "npm run build:deploy", [], { quiet: true, env });

// 5. The bundle is complete
const bundle = [
  "deploy/server/server.js",
  "deploy/worker/index.cjs",
  "deploy/start.js",
  "deploy/node_modules/.prisma/client",
  "deploy/package.json",
];
const missing = bundle.filter((f) => !fs.existsSync(path.join(root, f)));
results.push({ label: "Bundle is complete", ok: missing.length === 0, seconds: "0" });
console.log(`\n=== Bundle is complete\n    -> ${missing.length === 0 ? "PASS" : "FAIL: missing " + missing.join(", ")}`);

// 6. Secret scan
run("Secret scan", "node scripts/check-secrets.cjs", [], { quiet: true });

// 6b. No credential may reach the log
run("Log leak scan", "node scripts/check-log-leaks.cjs", [], { quiet: true });

// 6c. No encoding damage
run("Encoding scan", "node scripts/check-encoding.cjs", [], { quiet: true });

// 7. Health + auth smoke test
run("Health, login and API smoke test", "node scripts/e2e-supabase-check.cjs", [], { quiet: true, env });

// --- summary ---------------------------------------------------------------
console.log("\n" + "=".repeat(72));
console.log("SUMMARY");
console.log("=".repeat(72));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${String(r.label).padEnd(42)} ${r.seconds}s`);
}
console.log("=".repeat(72));
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
