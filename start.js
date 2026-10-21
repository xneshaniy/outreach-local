/**
 * Start the application from wherever it was built.
 *
 * A hosting platform may be configured with the entry point at the repository
 * root or inside the build output directory, and may use either build. This
 * launcher handles all of it:
 *
 *   deploy/ exists (npm run build:host)
 *     -> deploy/start.js, which runs the web server AND the sender worker
 *
 *   .next/standalone/ exists (npm run build)
 *     -> the standalone server, plus the worker if it was built
 *
 * Usage: node start.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const log = (...args) => console.log("[start]", ...args);

/* -------------------------------------------------------------------------- */
/* The deployment bundle: it already starts the worker itself.                  */
/* -------------------------------------------------------------------------- */
const bundleLauncher = path.join(ROOT, "deploy", "start.js");

if (fs.existsSync(bundleLauncher)) {
  log("using the deployment bundle (deploy/start.js)");
  require(bundleLauncher);
} else {
  /* ---------------------------------------------------------------------- */
  /* A plain Next.js build: start the server here and the worker beside it.  */
  /* ---------------------------------------------------------------------- */
  const serverEntry = path.join(ROOT, ".next", "standalone", "server.js");
  if (!fs.existsSync(serverEntry)) {
    console.error(
      "[start] Nothing to run.\n" +
        "[start] Build the app first:\n" +
        "         npm run build:host   (the full deployment bundle, recommended)\n" +
        "         npm run build        (a plain Next.js build)",
    );
    process.exit(1);
  }

  const workerEntry = path.join(ROOT, "dist", "worker", "index.cjs");
  let worker = null;
  let shuttingDown = false;

  if (process.env.RUN_WORKER !== "false" && fs.existsSync(workerEntry)) {
    log("starting the sender worker...");
    worker = spawn(process.execPath, [workerEntry], { stdio: "inherit", env: process.env });
    worker.on("error", (err) => log("worker failed to start:", err.message));
    worker.on("exit", (code, signal) => {
      if (shuttingDown) return;
      log(`worker exited unexpectedly (code=${code} signal=${signal})`);
      process.exit(code ?? 1);
    });
  } else {
    log("no worker bundle found - running the web app only");
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down...`);
    if (worker && !worker.killed) worker.kill(signal);
    setTimeout(() => process.exit(0), 2000);
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => shutdown(signal));
  }

  log(`starting the web server on port ${process.env.PORT ?? 3000}...`);
  require(serverEntry);
}
