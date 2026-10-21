/**
 * Reproduce a hosting platform's build exactly:
 *
 *   1. install WITHOUT the development dependencies (what NODE_ENV=production
 *      makes npm do)
 *   2. run the build command
 *
 * Before the fix, step 2 died with
 *   "Cannot find module '@tailwindcss/postcss'".
 * It must now repair the install and finish.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const work = path.join(process.env.TEMP, "opencode", "hosting-sim");

const sh = (command, cwd, opts = {}) =>
  execFileSync(command, {
    cwd,
    encoding: "utf8",
    shell: true,
    stdio: opts.quiet ? "pipe" : "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
  });

function copyRepo() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  for (const item of [
    "package.json",
    "package-lock.json",
    "postcss.config.mjs",
    "next.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
    "src",
    "prisma",
    "public",
    "scripts",
  ]) {
    const from = path.join(root, item);
    if (!fs.existsSync(from)) continue;
    const to = path.join(work, item);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }
}

(async () => {
  console.log("==> Copying the project");
  copyRepo();

  console.log("\n==> STEP 1: npm ci --omit=dev   (what NODE_ENV=production does)");
  sh("npm ci --omit=dev --no-audit --no-fund", work, { quiet: true });
  const afterProd = ["@tailwindcss/postcss", "tailwindcss", "esbuild", "prisma", "next"].map(
    (n) => `${n}: ${fs.existsSync(path.join(work, "node_modules", n, "package.json")) ? "present" : "MISSING"}`,
  );
  console.log("   " + afterProd.join("  "));

  console.log("\n==> STEP 2: npm run build:host");
  let failed = false;
  try {
    sh("npm run build:host", work, { env: { NODE_ENV: "production" } });
  } catch (e) {
    failed = true;
    console.log("   BUILD FAILED");
    console.log(String(e.stdout || e.stderr || e.message).split("\n").slice(-25).join("\n"));
  }

  console.log("\n==> STEP 3: the bundle");
  for (const f of [
    "deploy/server/server.js",
    "deploy/worker/index.cjs",
    "deploy/start.js",
    "deploy/node_modules/.prisma/client",
    "deploy/package.json",
  ]) {
    console.log(`   ${fs.existsSync(path.join(work, f)) ? "present" : "MISSING"}  ${f}`);
  }

  if (failed) {
    console.error("\nRESULT: the build did not repair a production-only install.");
    process.exit(1);
  }
  console.log("\nRESULT: OK - the build repaired a production-only install and produced the bundle.");
})();
