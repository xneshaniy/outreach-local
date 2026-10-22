const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");

/** Read the local, gitignored environment files. */
function localEnv() {
  const values = {};
  for (const file of [".env.hostinger", ".env.supabase"]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    for (const line of fs.readFileSync(target, "utf8").split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return values;
}

const local = localEnv();
const url =
  process.env.DATABASE_URL ??
  local.DATABASE_URL ??
  /^DATABASE_URL=(.*)$/m
    .exec(fs.readFileSync(path.join(root, ".env.supabase"), "utf8"))?.[1]
    ?.trim();
if (!url) {
  console.error("DATABASE_URL not found.");
  process.exit(1);
}

const PORT = 3555;
const APP_URL = `http://localhost:${PORT}`;

const env = {
  ...process.env,
  DATABASE_URL: url,
  AUTH_SECRET: process.env.AUTH_SECRET ?? local.AUTH_SECRET ?? "e2e-auth-secret-0123456789abcdefghijklmnop",
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? local.ENCRYPTION_KEY ?? "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  // The local address, so the requests below are same-origin and the CSRF
  // guard is exercised the way it will be in production.
  APP_URL,
  PORT: String(PORT),
  HOSTNAME: "0.0.0.0",
  NODE_ENV: "production",
};

const root2 = path.join(root, "deploy");
const child = spawn(process.execPath, [path.join(root2, "start.js")], {
  cwd: root2,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

const log = [];
child.stdout.on("data", (d) => log.push(d.toString()));
child.stderr.on("data", (d) => log.push(d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(pathname, options = {}) {
  const res = await fetch(`${APP_URL}${pathname}`, options);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/**
 * Wait for the health endpoint instead of sleeping a fixed amount of time.
 *
 * A cold start has to load the standalone server, initialise the Prisma
 * client and open a connection to a remote database - which can take longer
 * than any fixed sleep, especially while a build is running.
 */
async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await req("/api/health");
      if (res.status === 200) return res;
      last = `${res.status} ${res.text.slice(0, 120)}`;
    } catch (err) {
      last = String(err?.cause?.code ?? err.message);
    }
    await wait(1000);
  }
  throw new Error(`The app did not become healthy within ${timeoutMs}ms. Last: ${last}`);
}

(async () => {
  const health = await waitForHealth();
  console.log("=== health ===");
  console.log(`  ${health.status}  ${health.text.slice(0, 220)}`);

  const login = await req("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "Seed-Password-123!" }),
  });
  console.log("\n=== login as the seeded owner ===");
  console.log(`  ${login.status}  ${login.text.slice(0, 200)}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  console.log(`  session cookie: ${cookie ? "issued" : "NOT ISSUED"}`);

  if (cookie) {
    const dash = await req("/api/dashboard", { headers: { cookie } });
    console.log("\n=== dashboard (real data from Supabase) ===");
    console.log(`  ${dash.status}`);
    try {
      const d = JSON.parse(dash.text);
      console.log(`  contacts   : ${d.contacts?.total}`);
      console.log(`  campaigns  : ${d.campaigns?.total}`);
      console.log(`  services   : ${d.services?.total ?? "(not in payload)"}`);
      console.log(`  engagement : opens=${d.engagement?.uniqueOpens} clicks=${d.engagement?.uniqueClicks}`);
      console.log(`  health     : ok=${d.health?.ok} problems=${d.health?.problems?.length ?? 0}`);
    } catch {
      console.log("  " + dash.text.slice(0, 200));
    }

    const campaigns = await req("/api/campaigns", { headers: { cookie } });
    console.log("\n=== campaigns ===");
    console.log(`  ${campaigns.status}  ${campaigns.text.slice(0, 220)}`);
  }

  // The client portal has its own login and its own session.
  console.log("\n=== client portal login ===");
  const clientLogin = await req("/api/auth/client-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "client@example.test", password: "Client-Password-123!" }),
  });
  console.log(`  ${clientLogin.status}  ${clientLogin.text.slice(0, 160)}`);
  const clientCookie = clientLogin.headers.get("set-cookie")?.split(";")[0];
  if (clientCookie) {
    const summary = await req("/api/portal/summary?days=30", { headers: { cookie: clientCookie } });
    console.log("  portal summary:");
    try {
      const s = JSON.parse(summary.text);
      console.log(`    client     : ${s.client?.name} (${s.client?.company ?? ""})`);
      console.log(`    campaigns  : ${s.campaigns}`);
      console.log(`    sent       : ${s.totals?.sent}`);
      console.log(`    open rate  : ${s.totals?.openRate ?? "(no tracking yet)"}`);
    } catch {
      console.log("    " + summary.text.slice(0, 160));
    }
  }

  console.log("\n=== server log (last lines) ===");
  console.log(log.join("").split("\n").slice(-8).join("\n"));

  child.kill();
  process.exit(0);
})();
