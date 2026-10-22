/**
 * The launcher.
 *
 * This file is used in two places: the repository root (start.js) and the
 * deployment bundle (deploy/start.js). They must stay byte-identical - the
 * build checks that and fails if they diverge, because a panel may use
 * either one and a divergence would mean a deployment that starts one way
 * locally and another way in production.
 *
 * The application needs two processes:
 *
 *   - the Next.js standalone server (the UI and the API)
 *   - the sender worker (claims queued jobs and hands them to the provider)
 *
 * Without the worker, nothing is ever sent. Hostinger's "Setup Node.js App"
 * runs ONE entry file, so this starts the worker as a child process and then
 * brings up the web server in the same process. The platform's restart button
 * therefore restarts both, and they always share the same environment.
 *
 * It is written to work no matter how the hosting panel lays things out,
 * because a panel may:
 *
 *   - run the repository root, where the bundle is in ./deploy
 *   - run the output directory, where server/ and worker/ are right here
 *   - run the repository root as the output directory
 *
 * So the bundle root is found by looking for the files that must be in it.
 *
 * Set RUN_WORKER=false to run the web app only.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** True once a shutdown signal has been received. */
let shuttingDown = false;

/** Log with a prefix so the two processes are distinguishable in one log. */
function log(message, ...rest) {
  console.log("[start]", message, ...rest);
}

/**
 * The directory that holds server/ and worker/.
 *
 * @returns {string} the bundle root
 */
function findBundleRoot() {
  const candidates = [
    __dirname,
    path.join(__dirname, "deploy"),
    process.cwd(),
    path.join(process.cwd(), "deploy"),
  ];

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, "server", "server.js")) &&
      fs.existsSync(path.join(dir, "worker", "index.cjs"))
    ) {
      return dir;
    }
  }

  console.error(
    "[start] Could not find the application.\n" +
      "[start] Expected server/server.js and worker/index.cjs in one of:\n" +
      candidates.map((c) => `  - ${c}`).join("\n") +
      "\n[start] Build it first:  npm run build:host",
  );
  process.exit(1);
}

/**
 * The port to listen on.
 *
 * A hosting platform may pass the port as an argument instead of an
 * environment variable - the Next.js preset runs "npm run start -- -p $PORT".
 * The environment wins, because that is what the platform sets.
 */
function resolvePort(argv) {
  if (process.env.PORT) return process.env.PORT;
  const index = argv.findIndex((a) => a === "-p" || a === "--port");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((a) => /^--port=/.test(a));
  if (inline) return inline.split("=")[1];
  return "3000";
}

const ROOT = findBundleRoot();
const WORKER_ENTRY = path.join(ROOT, "worker", "index.cjs");
const SERVER_ENTRY = path.join(ROOT, "server", "server.js");

if (!process.env.PORT) {
  process.env.PORT = resolvePort(process.argv.slice(2));
  log(`no PORT in the environment - using ${process.env.PORT} from the command line`);
}

let worker = null;

if (process.env.RUN_WORKER !== "false") {
  if (!fs.existsSync(WORKER_ENTRY)) {
    log("WARNING: worker/index.cjs is missing - running the web app only.");
  } else {
    log(`starting the sender worker (${WORKER_ENTRY})...`);
    worker = spawn(process.execPath, [WORKER_ENTRY], {
      stdio: "inherit",
      env: process.env,
      // The standalone server changes the process directory to its own folder
      // when it is required, so the worker is given the bundle root
      // explicitly - otherwise it would look for .env in the wrong place.
      cwd: ROOT,
    });

    worker.on("error", (err) => {
      log("worker failed to start:", err.message);
    });

    worker.on("exit", (code, signal) => {
      if (shuttingDown) return;
      log(
        `worker exited unexpectedly (code=${code} signal=${signal}) - the platform will restart the app.`,
      );
      // Exit non-zero so the platform's supervisor notices and restarts us.
      process.exit(code ?? 1);
    });
  }
}

/** Stop the worker, then exit. */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down...`);
  if (worker && !worker.killed) {
    worker.kill(signal);
  }
  // Give the worker a moment to finish its current job, then exit.
  setTimeout(() => process.exit(0), 2000);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(signal));
}

log(`bundle root: ${ROOT}`);
log(`starting the web server on port ${process.env.PORT}...`);
// The standalone server starts as soon as it is required.
require(SERVER_ENTRY);
