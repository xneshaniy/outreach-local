/**
 * Build a self-contained deployment bundle for shared hosting (StackCP) or any
 * plain Node.js host.
 *
 * Produces `deploy/` containing:
 *   - server/       the Next.js standalone server (node server.js)
 *   - worker/       the compiled background worker
 *   - prisma/       schema + migrations (run `migrate deploy` once)
 *   - package.json  minimal manifest with start scripts
 *   - .env.example  reminder of required environment variables
 *
 * Usage:  npm run build:deploy
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "deploy");

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log("==> Cleaning previous bundle");
fs.rmSync(out, { recursive: true, force: true });

console.log("==> Building Next.js (standalone output)");
run("npx next build");

console.log("==> Building worker bundle");
run("npm run build:worker");

console.log("==> Assembling deploy/");
fs.mkdirSync(out, { recursive: true });

// 1. Standalone server (contains its own node_modules with traced deps).
copyDir(path.join(root, ".next", "standalone"), path.join(out, "server"));

// 1b. SECURITY: Next.js copies .env files into the standalone output.
// Strip them — real secrets must never be baked into a deployable artifact.
for (const name of [".env", ".env.local", ".env.production", ".env.development"]) {
  const p = path.join(out, "server", name);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    console.log(`    removed ${name} from the bundle`);
  }
}

// 2. Static assets must sit next to the standalone server.
copyDir(path.join(root, ".next", "static"), path.join(out, "server", ".next", "static"));
if (fs.existsSync(path.join(root, "public"))) {
  copyDir(path.join(root, "public"), path.join(out, "server", "public"));
}

// 3. Worker.
copyDir(path.join(root, "dist", "worker"), path.join(out, "worker"));

// 4. Prisma schema + migrations so `migrate deploy` can be run on the host.
copyDir(path.join(root, "prisma"), path.join(out, "prisma"));

// 5. Minimal package.json for the host.
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "email-outreach-platform",
      private: true,
      version: "0.1.0",
      scripts: {
        start: "node server/server.js",
        worker: "node worker/index.cjs",
        "db:deploy": "prisma migrate deploy",
      },
      dependencies: {
        "@prisma/client": "^6.0.0",
        prisma: "^6.0.0",
      },
    },
    null,
    2,
  ) + "\n",
);

fs.writeFileSync(
  path.join(out, "README.txt"),
  [
    "EMAIL OUTREACH PLATFORM - DEPLOYMENT",
    "=====================================",
    "",
    "1. Upload the CONTENTS of this folder to your hosting account (e.g. ~/outreach).",
    "2. Create a Node.js application in the hosting panel:",
    "     - Application root:  outreach",
    "     - Application startup file: server/server.js",
    "     - Application URL:   server/server.js",
    "3. Set the environment variables (see .env.example) in the hosting panel.",
    "   DATABASE_URL   = postgresql://user:pass@host:5432/db?sslmode=require",
    "   AUTH_SECRET    = 64-char base64",
    "   ENCRYPTION_KEY = 32-char base64",
    "   APP_URL        = https://outreach.growthleder.com",
    "4. Run the database migration ONCE (over SSH):",
    "     cd ~/outreach && npx prisma migrate deploy",
    "5. Add a SECOND Node.js application (or a background process / cron job) for the worker:",
    "     - Application startup file: worker/index.cjs",
    "6. Point the domain (outreach.growthleder.com) at the Node.js application",
    "   (set it as the domain in the panel, or add an .htaccess proxy rule).",
    "",
    "NOTE: This application requires PostgreSQL. MySQL is NOT supported.",
    "",
  ].join("\n"),
);

fs.writeFileSync(
  path.join(out, ".env.example"),
  [
    "DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require",
    "APP_URL=https://outreach.growthleder.com",
    "AUTH_SECRET=replace-with-64-byte-base64",
    "ENCRYPTION_KEY=replace-with-32-byte-base64",
    "SESSION_TTL_SECONDS=604800",
    "SENDER_DAILY_CAP_DEFAULT=100",
    "SENDER_QUOTA_TIMEZONE=UTC",
    "MAX_SENDER_ACCOUNTS=10",
    "MIN_DAYS_BETWEEN_CONTACTS=3",
    "WORKER_POLL_INTERVAL_MS=2000",
    "WORKER_BATCH_SIZE=20",
    "WORKER_LEASE_SECONDS=120",
    "WORKER_MAX_ATTEMPTS=5",
    "WORKER_BACKOFF_BASE_MS=5000",
    "RATE_LIMIT_ENABLED=true",
    "RATE_LIMIT_AUTH_MAX=10",
    "RATE_LIMIT_AUTH_WINDOW_SECONDS=60",
    "RATE_LIMIT_API_MAX=120",
    "RATE_LIMIT_API_WINDOW_SECONDS=60",
    "LOG_LEVEL=info",
    "",
  ].join("\n"),
);

console.log("\n==> Bundle ready: deploy/");
console.log("    Upload the CONTENTS of deploy/ to your host.");
