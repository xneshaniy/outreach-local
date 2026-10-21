/**
 * Single entry point for a hosting platform that starts exactly one process.
 *
 * Hostinger's "Setup Node.js App" runs one entry file and restarts it on
 * deploy. This application needs two processes:
 *
 *   - the Next.js standalone server (the UI and the API)
 *   - the sender worker (claims queued jobs and hands them to the provider)
 *
 * Without the worker, nothing is ever sent. Instead of asking the operator to
 * supervise a second process with pm2, this launcher starts the worker as a
 * child process and then brings up the web server in this same process. The
 * platform's restart button therefore restarts BOTH, and they always share
 * the same environment.
 *
 * Set RUN_WORKER=false to run the web app only (for example while debugging).
 */
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const WORKER_ENTRY = path.join(ROOT, "worker", "index.cjs");
const SERVER_ENTRY = path.join(ROOT, "server", "server.js");

/** Log with a prefix so the two processes are distinguishable in one log. */
function log(message, ...rest) {
  console.log(`[launcher] ${message}`, ...rest);
}

let worker = null;

if (process.env.RUN_WORKER !== "false") {
  const { existsSync } = require("node:fs");

  if (!existsSync(WORKER_ENTRY)) {
    log("WARNING: worker/index.cjs is missing - running the web app only.");
  } else {
    log("starting the sender worker...");
    worker = spawn(process.execPath, [WORKER_ENTRY], {
      stdio: "inherit",
      env: process.env,
    });

    worker.on("error", (err) => {
      log("worker failed to start:", err.message);
    });

    worker.on("exit", (code, signal) => {
      if (shuttingDown) return;
      log(`worker exited unexpectedly (code=${code} signal=${signal}) - the platform will restart the app.`);
      // Exit non-zero so the platform's supervisor notices and restarts us.
      process.exit(code ?? 1);
    });
  }
}

let shuttingDown = false;

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

// The standalone server starts as soon as it is required.
log(`starting the web server on port ${process.env.PORT ?? 3000}...`);
require(SERVER_ENTRY);
