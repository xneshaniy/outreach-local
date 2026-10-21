/**
 * Build the deployment bundle ON THE SERVER.
 *
 * The Prisma query engine is a native binary, so it has to be compiled for
 * the platform that will RUN the app. A bundle built on Windows contains the
 * Windows engine and crashes the moment it is started on Linux. Building on
 * the host removes that whole class of problem.
 *
 * This is the Node version of scripts/build-on-host.sh. It exists because a
 * hosting platform's build step is far more reliable when it does not depend
 * on a shell: no bash, no nvm, no PATH juggling, no .cmd shims. If the
 * platform's build environment can run `node`, it can run this.
 *
 *   node scripts/build-on-host.mjs                 # build the bundle
 *   node scripts/build-on-host.mjs --skip-install  # dependencies are already there
 *   node scripts/build-on-host.mjs --install-to ~/domains/x/nodejs
 *
 * Works on Hostinger, cPanel / StackCP, or any machine with Node >= 20.9.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */
let installTo = "";
let skipInstall = false;
let forceInstall = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--install-to") {
    installTo = args[i + 1] ?? "";
    i += 1;
  } else if (arg === "--skip-install") {
    skipInstall = true;
  } else if (arg === "--install") {
    forceInstall = true;
  } else if (arg === "-h" || arg === "--help") {
    console.log(
      [
        "Usage: node scripts/build-on-host.mjs [--skip-install] [--install] [--install-to <dir>]",
        "",
        "  --skip-install     never install; fail if the dependencies are missing",
        "  --install          always install, even if node_modules is already there",
        "  --install-to <dir> copy the finished bundle to <dir> afterwards",
        "",
        "By default the dependencies are installed only when they are not",
        "already there - a hosting panel usually runs its own install step",
        "before the build, and installing twice doubles the build time.",
      ].join("\n"),
    );
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */
function heading(text) {
  console.log(`\n==> ${text}`);
}

/**
 * Run a command, streaming its output.
 *
 * The command is passed to a shell so that `npm`/`npx` resolve on every
 * platform (on Windows they are .cmd shims, which cannot be executed
 * directly). The commands used here contain no shell metacharacters.
 */
function run(command, env = {}) {
  console.log(`> ${command}`);
  const result = spawnSync(command, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw new Error(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 0. Sanity checks                                                            */
/* -------------------------------------------------------------------------- */
const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);

console.log(`==> Node ${process.versions.node}, npm below`);
console.log(`==> Platform: ${process.platform}/${process.arch}`);

if (major < 20 || (major === 20 && minor < 9)) {
  console.error(
    `\nERROR: Node ${process.versions.node} is too old. This application needs Node >= 20.9.\n` +
      "On Hostinger: hPanel -> Websites -> your domain -> 'Setup Node.js App' -> version 22.x.\n",
  );
  process.exit(1);
}

try {
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8", shell: true }).trim();
  console.log(`==> npm ${npmVersion}`);
} catch {
  console.error("\nERROR: npm is not available on this machine's PATH.");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 1. Dependencies                                                              */
/* -------------------------------------------------------------------------- */
heading("Checking the dependencies");

/**
 * Are the dependencies already installed?
 *
 * A hosting panel normally runs its own install step before the build, so
 * installing again would double the build time - and a build that takes too
 * long is a build that fails.
 */
function dependenciesInstalled() {
  const modules = path.join(root, "node_modules");
  if (!fs.existsSync(modules)) return false;
  // next and the Prisma CLI are both needed for the build.
  return (
    fs.existsSync(path.join(modules, "next", "package.json")) &&
    fs.existsSync(path.join(modules, "prisma", "package.json"))
  );
}

const haveDependencies = dependenciesInstalled();

if (forceInstall) {
  console.log("    installing (--install)");
} else if (haveDependencies) {
  console.log("    already installed - skipping");
  console.log("    (the hosting panel installs them in its own step; installing");
  console.log("     again would double the build time)");
} else if (skipInstall) {
  console.error("");
  console.error("ERROR: --skip-install was given, but the dependencies are not installed.");
  console.error("       node_modules/next or node_modules/prisma is missing.");
  process.exit(1);
} else {
  console.log("    installing");
}

if (forceInstall || (!haveDependencies && !skipInstall)) {
  const hasLock = fs.existsSync(path.join(root, "package-lock.json"));
  // --include=dev matters: hosting platforms set NODE_ENV=production, and npm
  // then omits devDependencies - which is where the Prisma CLI and esbuild
  // live. Without them the build cannot run.
  run(hasLock ? "npm ci --include=dev --no-audit --no-fund" : "npm install --include=dev --no-audit --no-fund");
}

/* -------------------------------------------------------------------------- */
/* 2. The Prisma client, for THIS platform                                     */
/* -------------------------------------------------------------------------- */
heading("Generating the Prisma client for this platform");
run("npx prisma generate");

/* -------------------------------------------------------------------------- */
/* 3. The bundle                                                                */
/* -------------------------------------------------------------------------- */
heading("Building the deployment bundle");
run("npm run build:deploy");

const bundle = path.join(root, "deploy");
if (!fs.existsSync(path.join(bundle, "server", "server.js"))) {
  console.error("\nERROR: the bundle was not assembled correctly (deploy/server/server.js is missing).");
  process.exit(1);
}
if (!fs.existsSync(path.join(bundle, "worker", "index.cjs"))) {
  console.error("\nERROR: the worker bundle is missing (deploy/worker/index.cjs).");
  process.exit(1);
}
if (!fs.existsSync(path.join(bundle, "node_modules", ".prisma", "client"))) {
  console.error(
    "\nERROR: the Prisma client is missing from the bundle (deploy/node_modules/.prisma/client).\n" +
      "The worker would fail with 'Cannot find module @prisma/client'.",
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 4. Optionally install it into the hosting app root                          */
/* -------------------------------------------------------------------------- */
if (installTo) {
  heading(`Installing the bundle into ${installTo}`);
  const target = path.resolve(installTo.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  fs.mkdirSync(target, { recursive: true });

  for (const item of ["server", "worker", "node_modules", "prisma"]) {
    const from = path.join(bundle, item);
    const to = path.join(target, item);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });
    console.log(`    copied ${item}`);
  }
  for (const item of ["package.json", "start.js", "start.sh", ".htaccess"]) {
    const from = path.join(bundle, item);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(target, item));
      console.log(`    copied ${item}`);
    }
  }
  console.log(`    done. The application root in hPanel should be: ${target}`);
}

/* -------------------------------------------------------------------------- */
/* 5. Report                                                                    */
/* -------------------------------------------------------------------------- */
const engines = fs.existsSync(path.join(bundle, "server", "node_modules", ".prisma", "client"))
  ? fs
      .readdirSync(path.join(bundle, "server", "node_modules", ".prisma", "client"))
      .filter((f) => f.startsWith("query_engine") || f.startsWith("libquery_engine"))
      .map((f) => f.replace(/\.(dll|so)\.node$/, ""))
  : [];

console.log("");
console.log(`==> Bundle ready: ${bundle}`);
console.log(`    Prisma engine in the bundle: ${engines.join(", ") || "unknown"}`);
console.log(`    Entry point: deploy/start.js  (web server + sender worker)`);
console.log("");
console.log("NEXT STEPS");
console.log("  1) Apply the database migrations:");
console.log("       npx prisma migrate deploy");
console.log("  2) Point the hosting panel at the bundle:");
console.log("       Output directory : deploy");
console.log("       Entry file      : start.js");
console.log("       Start command   : node deploy/start.js");
console.log("");
