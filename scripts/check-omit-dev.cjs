const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const work = path.join(process.env.TEMP, "opencode", "omitdev-test");

/**
 * What does a production-only install leave out?
 *
 * This is the decisive question: a hosting platform that sets
 * NODE_ENV=production makes npm omit devDependencies, and the build then
 * fails on whichever build-time package is missing.
 */
const BUILD_CRITICAL = [
  "next",
  "prisma",
  "@prisma/client",
  "@tailwindcss/postcss",
  "tailwindcss",
  "esbuild",
  "typescript",
  "tsx",
];

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

for (const item of ["package.json", "package-lock.json", "postcss.config.mjs", "prisma", "next.config.ts", "tsconfig.json"]) {
  const from = path.join(root, item);
  if (!fs.existsSync(from)) continue;
  const to = path.join(work, item);
  if (fs.statSync(from).isDirectory()) {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.copyFileSync(from, to);
  }
}

console.log("== installing with --omit=dev (what NODE_ENV=production does) ==");
try {
  // shell:true so npm.cmd resolves on Windows.
  execFileSync("npm ci --omit=dev --no-audit --no-fund", {
    cwd: work,
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
  });
  console.log("   install finished");
} catch (e) {
  console.log("   install failed:", String(e.stderr || e.message).split("\n")[0]);
}

console.log("\n== build-time packages present? ==");
let missing = 0;
for (const name of BUILD_CRITICAL) {
  const present = fs.existsSync(path.join(work, "node_modules", name, "package.json"));
  if (!present) missing += 1;
  console.log(`   ${present ? "present" : "MISSING"}  ${name}`);
}
console.log(`\n   ${missing} build-time package(s) missing after a production-only install`);

console.log("\n== and the postcss config would fail with ==");
if (!fs.existsSync(path.join(work, "node_modules", "@tailwindcss", "postcss"))) {
  console.log("   Error: Cannot find module '@tailwindcss/postcss'");
}
