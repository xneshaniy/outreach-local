/**
 * Start the built bundle in every layout a hosting panel might produce, and
 * check that each one serves the app.
 *
 * A panel may:
 *   - run the repository root, with the bundle in ./deploy
 *   - run the output directory, with server/ and worker/ right there
 *   - run the repository root as the output directory
 *   - pass the port as -p <port> instead of setting PORT
 *   - not set HOSTNAME at all
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const bundle = path.join(root, "deploy");

function localEnv() {
  const values = {};
  for (const file of [".env.hostinger", ".env.supabase"]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    for (const line of fs.readFileSync(target, "utf8").split("\n")) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) values[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return values;
}

const local = localEnv();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

/** Run a command and capture what it printed. */
function run(cmd, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("exit", (code) => resolve({ code, out }));
    child.on("error", () => resolve({ code: -1, out: "" }));
  });
}

async function scenario(name, { cwd, entry, args = [], port, omitPort = false, omitHostname = false }) {
  const env = {
    ...process.env,
    DATABASE_URL: local.DATABASE_URL,
    AUTH_SECRET: local.AUTH_SECRET,
    ENCRYPTION_KEY: local.ENCRYPTION_KEY,
    APP_URL: `http://localhost:${port}`,
    NODE_ENV: "production",
  };
  if (omitPort) delete env.PORT;
  else env.PORT = String(port);
  if (omitHostname) delete env.HOSTNAME;
  else env.HOSTNAME = "0.0.0.0";

  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  let health = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.status === 200) {
        health = await res.json();
        break;
      }
    } catch {}
    await wait(1000);
  }

  const workerStarted = /starting the sender worker/.test(logs);
  const bundleRoot = (logs.match(/bundle root: (.+)/) ?? [])[1] ?? "(not logged)";

  check(`${name} - serves the health endpoint`, health !== null, health ? `database=${health.database}` : "no response");
  check(`${name} - the worker started`, workerStarted);
  check(`${name} - resolved the bundle root`, bundleRoot !== "(not logged)" && fs.existsSync(bundleRoot), bundleRoot);

  child.kill();
  await wait(1500);
}

(async () => {
  if (!fs.existsSync(path.join(bundle, "server", "server.js"))) {
    console.error("No bundle. Run: npm run build:deploy");
    process.exit(1);
  }

  // A copy of the repository root that also contains the bundle, which is
  // what a panel sees when it deploys the whole repository.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
  fs.cpSync(path.join(root, "start.js"), path.join(tmp, "start.js"));
  fs.cpSync(bundle, path.join(tmp, "deploy"), { recursive: true });

  console.log("=== every hosting layout ===\n");

  await scenario("A. repository root, bundle in ./deploy", {
    cwd: tmp,
    entry: "start.js",
    port: 3901,
  });

  await scenario("B. output directory (server/ and worker/ here)", {
    cwd: bundle,
    entry: "start.js",
    port: 3902,
  });

  await scenario("C. repository root as the output directory", {
    cwd: tmp,
    entry: path.join("deploy", "start.js"),
    port: 3903,
  });

  await scenario("D. port passed as -p, no PORT in the environment", {
    cwd: tmp,
    entry: "start.js",
    args: ["-p", "3904"],
    port: 3904,
    omitPort: true,
  });

  await scenario("E. no HOSTNAME in the environment", {
    cwd: tmp,
    entry: "start.js",
    port: 3905,
    omitHostname: true,
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("");
  console.log(failures === 0 ? "EVERY LAYOUT WORKS" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
