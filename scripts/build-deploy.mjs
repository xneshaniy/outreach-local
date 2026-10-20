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

// 4b. Shared-hosting helpers (Apache proxy + pm2 start script).
const templates = path.join(root, "scripts", "templates");
for (const file of [".htaccess", "start.sh"]) {
  const from = path.join(templates, file);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(out, file));
    console.log(`    added ${file}`);
  }
}

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
    "EMAIL OUTREACH PLATFORM - DEPLOYMENT (shared hosting / cPanel / StackCP)",
    "=======================================================================",
    "",
    "CONTENTS OF THIS FOLDER",
    "  server/      Next.js standalone server  (node server/server.js)",
    "  worker/      background sender        (node worker/index.cjs)",
    "  prisma/      schema + migrations",
    "  .htaccess    Apache reverse proxy config (for the SSH/pm2 route)",
    "  start.sh     start/stop script using pm2 (for the SSH/pm2 route)",
    "  .env.example environment variables you must set",
    "",
    "STEP 1 - UPLOAD",
    "  Upload the CONTENTS of this folder to your account, e.g. ~/outreach",
    "  (File Manager -> upload a ZIP and extract it, or FTP/SFTP).",
    "",
    "STEP 2 - ENVIRONMENT",
    "  Copy .env.example to .env and fill in the values, or set them in the",
    "  hosting panel (cPanel: 'Setup Node.js App' -> Environment variables):",
    "    DATABASE_URL    = postgresql://user:pass@host:5432/db?sslmode=require&connect_timeout=60&pool_timeout=60",
    "    AUTH_SECRET     = 64-char base64   (openssl rand -base64 64)",
    "    ENCRYPTION_KEY  = 32-char base64   (openssl rand -base64 32)",
    "    APP_URL         = https://outreach.growthleder.com",
    "    PORT            = 3000",
    "",
    "STEP 3 - DATABASE MIGRATION (once)",
    "  SSH into the account and run:",
    "     cd ~/outreach",
    "     npx prisma migrate deploy",
    "",
    "STEP 4A - IF YOUR PANEL HAS 'Setup Node.js App' (cPanel)",
    "  a) Create Application 1 (the web app):",
    "       Node.js version : 20.x or 22.x",
    "       Application mode : Production",
    "       Application root : outreach",
    "       Application URL  : server/server.js",
    "     Add the environment variables from STEP 2, then 'Restart Application'.",
    "  b) Create Application 2 (the worker):",
    "       Application root : outreach",
    "       Application URL  : worker/index.cjs",
    "     Same environment variables. The worker has no URL - it just runs.",
    "  c) Domains -> point outreach.growthleder.com at Application 1.",
    "",
    "STEP 4B - IF THERE IS NO NODE.JS PANEL (use SSH + pm2)",
    "  SSH into the account and run:",
    "     cd ~/outreach",
    "     curl -fsSL https://raw.githubusercontent.com/amannn/action-semantic-release/master/assets/amannn/action-semantic-release -o /dev/null 2>/dev/null; true",
    "     npm install -g pm2          # if pm2 is not installed",
    "     cp .env.example .env        # then edit it",
    "     npx prisma migrate deploy",
    "     chmod +x start.sh && ./start.sh",
    "  Then copy .htaccess into the DOCUMENT ROOT of the domain in the panel",
    "  (usually public_html, or the folder shown in Domains -> Document Root).",
    "  Apache will then proxy every request to 127.0.0.1:3000.",
    "",
    "STEP 5 - VERIFY",
    "     curl http://127.0.0.1:3000/api/health     -> {\"status\":\"ok\",...}",
    "     curl https://outreach.growthleder.com/api/health",
    "  Then log in at https://outreach.growthleder.com/login",
    "",
    "NOTES",
    "  * This application requires PostgreSQL. MySQL is NOT supported.",
    "  * The worker is a separate process - without it, no email is ever sent.",
    "  * Managed Postgres (Neon/Supabase) suspends idle instances: keep",
    "    connect_timeout=60&pool_timeout=60 in DATABASE_URL.",
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
