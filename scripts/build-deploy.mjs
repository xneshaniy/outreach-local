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

/**
 * Target platform hint.
 *
 * The bundle is usually built on the developer machine but uploaded to a
 * Linux server. Native dependencies (the Prisma query engine) are platform
 * specific, so the wrong ones crash the server on startup. The build script
 * reports which engine ended up in the bundle.
 */
function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * Native dependencies (the Prisma query engine) are platform specific.
 *
 * A bundle built on Windows contains the Windows engine and will NOT run on a
 * Linux server. The reliable way to get a Linux bundle is to BUILD ON THE
 * TARGET HOST (see scripts/build-on-host.sh) or to use Docker.
 *
 * This function only reports what the bundle contains so the operator is
 * never surprised.
 */
function reportNativeBinaries() {
  const clientDir = path.join(out, "server", "node_modules", ".prisma", "client");
  if (!fs.existsSync(clientDir)) return;
  const engines = fs
    .readdirSync(clientDir)
    .filter((f) => f.startsWith("query_engine") && f.endsWith(".node"))
    .map((f) => f.replace("query_engine-", "").replace(".dll.node", ""));
  if (engines.length === 0) return;

  const buildPlatform = process.platform === "win32" ? "windows" : process.platform;
  console.log(`    Prisma query engine in the bundle: ${engines.join(", ")}`);

  if (engines.every((e) => e.startsWith(buildPlatform))) {
    console.log("    -> matches the build platform.");
  } else {
    console.log("");
    console.log("    !! The engine does NOT match this build platform.");
    console.log("    !! If the server runs a different OS, rebuild the bundle ON THE SERVER:");
    console.log("       cd ~/outreach && npm ci && npx prisma generate && npm run build:deploy");
    console.log("");
  }
}

/** Remove dev-only / platform-specific packages that bloat the upload. */
function pruneBundle() {
  const nm = path.join(out, "server", "node_modules");
  const drop = [
    "typescript", // dev-only
    "sharp",
    "@img", // native image tooling, not used by this app
  ];
  for (const pkg of drop) {
    const p = path.join(nm, pkg);
    if (fs.existsSync(p)) {
      const size = fs
        .readdirSync(p, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath ?? p, e.name)).size, 0);
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`    pruned ${pkg} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
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

// 2b. Trim the upload size and report the native binaries.
pruneBundle();
reportNativeBinaries();

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
    "*** IMPORTANT: THE PRISMA QUERY ENGINE IS PLATFORM SPECIFIC ***",
    "  If this bundle was built on Windows, the engine inside is the Windows",
    "  one and the app will NOT start on a Linux server. Build the bundle ON",
    "  THE SERVER instead:",
    "     cd ~/outreach",
    "     bash scripts/build-on-host.sh",
    "",
    "RECOMMENDED ROUTE (works on any cPanel with SSH)",
    "  1. Clone the repository (cPanel -> Git(TM) Version Control):",
    "       Repository: https://github.com/xneshaniy/outreach-local.git",
    "       Directory:  outreach",
    "  2. SSH into the account and build:",
    "       cd ~/outreach",
    "       bash scripts/build-on-host.sh",
    "  3. Create .env:",
    "       cp .env.example .env      then edit the values",
    "  4. Apply the database migration (once):",
    "       npx prisma migrate deploy",
    "  5. Start the app + the worker:",
    "       npm install -g pm2        # if pm2 is missing",
    "       bash deploy/start.sh",
    "  6. Copy deploy/.htaccess into the DOCUMENT ROOT of the domain",
    "     (Domains -> the domain -> Document Root, usually public_html).",
    "     Apache then proxies every request to 127.0.0.1:3000.",
    "  7. Verify:",
    "       curl http://127.0.0.1:3000/api/health",
    "       curl https://outreach.growthleder.com/api/health",
    "",
    "ALTERNATIVE ROUTE (cPanel 'Setup Node.js App' panel)",
    "  a) Create Application 1 (the web app):",
    "       Node.js version : 20.x or 22.x",
    "       Application mode : Production",
    "       Application root : outreach",
    "       Application URL  : server/server.js",
    "     Add the environment variables, then 'Restart Application'.",
    "  b) Create Application 2 (the worker):",
    "       Application root : outreach",
    "       Application URL  : worker/index.cjs",
    "     The worker has no URL - it just runs.",
    "  c) Domains -> point outreach.growthleder.com at Application 1.",
    "  (With this route you must still build on the server, or the Prisma",
    "   engine will not match the host OS.)",
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
