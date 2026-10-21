/**
 * The production build.
 *
 * A hosting platform may or may not install devDependencies: most set
 * NODE_ENV=production, and npm then omits them. The Prisma CLI is a
 * devDependency, so `prisma generate` would fail with "command not found".
 *
 * `npx prisma generate` fixes that: npx uses the local CLI when it is
 * installed and downloads it on demand when it is not. This script therefore
 * builds the same way on every platform.
 *
 * It also assembles the standalone output, so the app can be started either
 * way:
 *   node .next/standalone/server.js
 *   next start
 *
 * Usage: npm run build
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.error) {
    console.error(`\nERROR: could not run "${command}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nERROR: "${command}" failed with exit code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// 1. The Prisma client. npx downloads the CLI if devDependencies were
//    omitted, so this works on every platform.
run("npx prisma generate");

// 2. The worker.
run("npm run build:worker");

// 3. The Next.js build.
run("npx next build");

// 4. Assemble the standalone output so it can be started directly.
const standalone = path.join(root, ".next", "standalone");
if (fs.existsSync(standalone)) {
  const staticDir = path.join(root, ".next", "static");
  if (fs.existsSync(staticDir)) {
    copyDir(staticDir, path.join(standalone, ".next", "static"));
    console.log("\n==> Copied .next/static into the standalone output");
  }
  const publicDir = path.join(root, "public");
  if (fs.existsSync(publicDir)) {
    copyDir(publicDir, path.join(standalone, "public"));
    console.log("==> Copied public/ into the standalone output");
  }
}

// 5. Sanity check.
const serverEntry = path.join(standalone, "server.js");
if (!fs.existsSync(serverEntry)) {
  console.error("\nERROR: .next/standalone/server.js is missing - the build did not produce a server.");
  process.exit(1);
}
const workerEntry = path.join(root, "dist", "worker", "index.cjs");
if (!fs.existsSync(workerEntry)) {
  console.error("\nERROR: dist/worker/index.cjs is missing - the worker was not built.");
  process.exit(1);
}

console.log("");
console.log("==> Build complete");
console.log("    web app : node .next/standalone/server.js   (or: npm start)");
console.log("    worker  : node dist/worker/index.cjs");
console.log("    or both : node start.js");
console.log("");
