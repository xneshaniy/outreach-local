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
import { builtinModules } from "node:module";
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
  // Always go through a shell. On Linux `execSync` without a shell splits the
  // command on spaces and execs the pieces directly, which breaks as soon as
  // a path or an argument contains a space - and on Windows `npx`/`npm` are
  // `.cmd` shims that need a shell to be found at all. The commands used here
  // contain no shell metacharacters.
  execSync(cmd, { cwd: root, stdio: "inherit", shell: true });
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

/**
 * The packages copied into deploy/node_modules.
 *
 * The bundle's package.json is generated from this list, so that running
 * `npm install` inside the bundle reproduces exactly the same tree instead of
 * pruning the worker's dependencies as "extraneous".
 */
let workerPackages = [];

/**
 * Copy the worker's runtime dependency closure into the bundle.
 *
 * The worker is compiled with `--packages=external`, so every `import` of a
 * third-party package stays a real `require()` at runtime. Those packages are
 * NOT part of the Next.js standalone output (which lives in server/), so a
 * worker started from the bundle root would fail with
 * "Cannot find module '@prisma/client'".
 *
 * Inside the repository this is masked by the project's own node_modules one
 * directory up — on a real server there is nothing above the bundle, so the
 * closure has to be copied in explicitly.
 */
function copyWorkerDependencies() {
  const workerFile = path.join(out, "worker", "index.cjs");
  if (!fs.existsSync(workerFile)) {
    console.log("    !! worker bundle missing — skipping dependency copy");
    return;
  }
  const source = fs.readFileSync(workerFile, "utf8");

  // Every bare specifier the bundle still requires.
  const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
  const specifiers = new Set();
  const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = requireRe.exec(source)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
    // Node built-ins ("crypto", "fs", "path", ...) are provided by the runtime.
    if (builtins.has(spec)) continue;
    specifiers.add(spec);
  }

  // Map a specifier to the package that provides it ("dotenv/config" -> "dotenv").
  const packageOf = (spec) => {
    const parts = spec.split("/");
    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  };

  /** Resolve a package directory in the project's node_modules. */
  const findPackage = (name) => {
    const direct = path.join(root, "node_modules", name);
    if (fs.existsSync(path.join(direct, "package.json"))) return direct;
    // Fall back to a nested copy (npm sometimes nests a conflicting version).
    for (const scopeOrPkg of fs.readdirSync(path.join(root, "node_modules"), { withFileTypes: true })) {
      if (!scopeOrPkg.isDirectory()) continue;
      const base = path.join(root, "node_modules", scopeOrPkg.name);
      if (scopeOrPkg.name.startsWith("@")) {
        for (const inner of fs.readdirSync(base, { withFileTypes: true })) {
          if (!inner.isDirectory()) continue;
          const nested = path.join(base, inner.name);
          if (nested.endsWith(path.join("node_modules", name))) return nested;
        }
      }
    }
    return null;
  };

  // Walk the dependency closure.
  const closure = new Set();
  const queue = [...specifiers].map(packageOf);
  while (queue.length) {
    const name = queue.shift();
    if (!name || closure.has(name)) continue;
    const dir = findPackage(name);
    if (!dir) {
      console.log(`    !! could not locate package "${name}" — it will be missing at runtime`);
      continue;
    }
    closure.add(name);
    const pkgJson = path.join(dir, "package.json");
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      for (const dep of Object.keys(meta.dependencies ?? {})) queue.push(dep);
      for (const dep of Object.keys(meta.optionalDependencies ?? {})) queue.push(dep);
    } catch {
      /* ignore unreadable manifests */
    }
  }

  for (const name of closure) {
    const from = findPackage(name);
    if (!from) continue;
    const to = path.join(out, "node_modules", name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });

    // Record the version so the bundle's package.json stays in sync.
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
      workerPackages.push({ name, version: meta.version ?? "latest" });
    } catch {
      workerPackages.push({ name, version: "latest" });
    }
  }

  // The generated Prisma client (native engine) must sit next to it.
  const prismaClient = path.join(root, "node_modules", ".prisma", "client");
  if (fs.existsSync(prismaClient)) {
    copyDir(prismaClient, path.join(out, "node_modules", ".prisma", "client"));
  }

  workerPackages.sort((a, b) => a.name.localeCompare(b.name));

  console.log(
    `    added ${closure.size} runtime package(s) for the worker: ${[...closure].sort().join(", ")}`,
  );
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

// 3b. The worker still `require()`s its third-party packages at runtime, and
//     the Next.js standalone output does not contain them. Copy the worker's
//     dependency closure into the bundle so it runs from the bundle root.
copyWorkerDependencies();

// 4. Prisma schema + migrations so `migrate deploy` can be run on the host.
copyDir(path.join(root, "prisma"), path.join(out, "prisma"));

// 4b. Shared-hosting helpers (Apache proxy + pm2 start script + the
//     single-process launcher for platforms that start only one entry file).
const templates = path.join(root, "scripts", "templates");
for (const file of [".htaccess", "start.sh", "start.js"]) {
  const from = path.join(templates, file);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(out, file));
    console.log(`    added ${file}`);
  }
}

// 5. Minimal package.json for the host.
//
//    The dependency list is generated from the packages that were actually
//    copied into deploy/node_modules, so `npm install` inside the bundle
//    reproduces the same tree instead of pruning the worker's dependencies
//    as "extraneous".
const bundleDependencies = {};
for (const pkg of workerPackages) {
  bundleDependencies[pkg.name] = `^${pkg.version}`;
}
// The Prisma CLI is only needed to run migrations; it is not a runtime dep of
// the worker, but `npm install` should provide it for `npx prisma migrate`.
let prismaVersion = "^6.0.0";
try {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  prismaVersion = rootPkg.devDependencies?.prisma ?? rootPkg.dependencies?.prisma ?? prismaVersion;
} catch {
  /* keep the default */
}
bundleDependencies.prisma = prismaVersion;

fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "email-outreach-platform",
      private: true,
      version: "0.1.0",
      scripts: {
        // `start.js` runs the web server AND the sender worker, so a platform
        // that supervises a single process (Hostinger, Railway, Fly) is
        // enough to run the whole application.
        start: "node start.js",
        "start:web": "node server/server.js",
        worker: "node worker/index.cjs",
        "db:deploy": "prisma migrate deploy",
      },
      engines: {
        node: ">=20.9.0",
      },
      dependencies: bundleDependencies,
    },
    null,
    2,
  ) + "\n",
);
console.log(`    package.json lists ${Object.keys(bundleDependencies).length} dependencies`);

fs.writeFileSync(
  path.join(out, "README.txt"),
  [
    "EMAIL OUTREACH PLATFORM - DEPLOYMENT (Hostinger / cPanel / StackCP)",
    "=======================================================================",
    "",
    "CONTENTS OF THIS FOLDER",
    "  server/      Next.js standalone server  (node server/server.js)",
    "  worker/      background sender        (node worker/index.cjs)",
    "  node_modules/ the worker's runtime deps, incl. the Prisma engine",
    "  prisma/      schema + migrations",
    "  .htaccess    Apache/LiteSpeed proxy config (for the SSH/pm2 route)",
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
    "=======================================================================",
    "HOSTINGER  (hPanel -> Websites -> <domain> -> Setup Node.js App)",
    "=======================================================================",
    "",
    "  1. Over SSH, build the bundle on the server:",
    "       cd ~/outreach",
    "       source ~/.nvm/nvm.sh && nvm use 22",
    "       bash scripts/build-on-host.sh --install-to ~/domains/<domain>/nodejs",
    "  2. Apply the migrations (once per release):",
    "       cd ~/outreach && npx prisma migrate deploy",
    "  3. hPanel -> Setup Node.js App:",
    "       Node.js version  : 22.x",
    "       Application mode : Production",
    "       Application root : nodejs",
    "       Application URL  : server/server.js",
    "  4. Add the environment variables in the panel (DATABASE_URL,",
    "     AUTH_SECRET, ENCRYPTION_KEY, APP_URL, HOSTNAME=0.0.0.0,",
    "     NODE_ENV=production, DRY_RUN=true). Then Restart Application.",
    "  5. Start the WORKER over SSH with pm2 (it is a separate process and",
    "     the app will never send without it):",
    "       cd ~/domains/<domain>/nodejs",
    "       npm install -g pm2",
    "       pm2 start worker/index.cjs --name outreach-worker --time",
    "       pm2 save",
    "     The worker does not inherit the panel's environment variables -",
    "     put them in a .env file in that folder and `set -a; . ./.env; set +a`",
    "     before starting pm2, or pass them inline.",
    "  6. hPanel -> Websites -> Domains -> point the domain at the app, and",
    "     Security -> SSL -> Install Let's Encrypt.",
    "  7. Verify:",
    "       curl -s https://<your-domain>/api/health",
    "     Expected: {\"status\":\"ok\",\"database\":\"up\"}",
    "",
    "  Full guide in the repository: docs/HOSTINGER.md",
    "",
    "=======================================================================",
    "GENERIC ROUTE  (cPanel / StackCP with SSH)",
    "=======================================================================",
    "",
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
    "       curl https://<your-domain>/api/health",
    "",
    "=======================================================================",
    "NOTES",
    "=======================================================================",
    "",
    "  * This application requires PostgreSQL. MySQL is NOT supported.",
    "  * The worker is a separate process - without it, no email is ever sent.",
    "  * Managed Postgres (Neon/Supabase) suspends idle instances: keep",
    "    connect_timeout=60&pool_timeout=60 in DATABASE_URL.",
    "  * Keep DRY_RUN=true until the whole pipeline has been verified.",
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
