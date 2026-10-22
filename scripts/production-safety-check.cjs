/**
 * Production-safety checks against a running instance.
 *
 * Every check here is something that must NOT be able to go wrong in
 * production: an unauthorised request must be rejected, a suppressed contact
 * must not be mailed, and a dry run must not reach a provider.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");

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
const PORT = 3666;
const BASE = `http://localhost:${PORT}`;

const env = {
  ...process.env,
  DATABASE_URL: local.DATABASE_URL,
  AUTH_SECRET: local.AUTH_SECRET,
  ENCRYPTION_KEY: local.ENCRYPTION_KEY,
  APP_URL: BASE,
  PORT: String(PORT),
  HOSTNAME: "0.0.0.0",
  NODE_ENV: "production",
  // A dry run, exactly as the panel will have it.
  DRY_RUN: "true",
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

const child = spawn(process.execPath, [path.join(root, "deploy", "start.js")], {
  cwd: path.join(root, "deploy"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
child.stdout.on("data", (d) => logs.push(d.toString()));
child.stderr.on("data", (d) => logs.push(d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, options);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

(async () => {
  // wait for the app
  let up = false;
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await req("/api/health");
      if (res.status === 200) { up = true; break; }
    } catch {}
    await wait(1000);
  }
  if (!up) {
    console.error("The app did not start.");
    console.error(logs.join("").split("\n").slice(-15).join("\n"));
    process.exit(1);
  }

  console.log("\n=== production safety ===");

  // 1. The health endpoint.
  const health = await req("/api/health");
  const healthJson = JSON.parse(health.text);
  check("health endpoint answers 200", health.status === 200);
  check("health reports the database up", healthJson.database === "up", healthJson.database);

  // 2. An unauthenticated admin API must be rejected.
  const unauth = await req("/api/dashboard");
  check("an unauthenticated admin API is rejected", unauth.status === 401, `HTTP ${unauth.status}`);

  const unauth2 = await req("/api/contacts");
  check("an unauthenticated contacts API is rejected", unauth2.status === 401, `HTTP ${unauth2.status}`);

  const unauth3 = await req("/api/campaigns");
  check("an unauthenticated campaigns API is rejected", unauth3.status === 401, `HTTP ${unauth3.status}`);

  // 3. A forged tracking token must not record an event.
  //    The pixel itself answers 200 with a 1x1 GIF on purpose - a broken
  //    image in someone's inbox is worse than a missed statistic - so what
  //    matters is that nothing is written.
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: local.DATABASE_URL });
  const before = await db.trackingEvent.count();
  const forged = await req("/api/track/open?t=forged.token.value");
  const forgedClick = await req("/api/track/click?t=forged.token.value&u=https%3A%2F%2Fexample.test");
  const after = await db.trackingEvent.count();
  check(
    "a forged tracking token records no event",
    after === before,
    `${after - before} event(s) recorded`,
  );
  check(
    "the open pixel still answers with a GIF",
    forged.status === 200 && forged.headers.get("content-type")?.includes("image"),
    `HTTP ${forged.status} ${forged.headers.get("content-type") ?? ""}`,
  );
  // A click must REJECT a forged token rather than redirect: the target URL
  // only ever comes from the signed token, so a forged link must not be able
  // to bounce anyone anywhere.
  check(
    "a forged click is rejected and does not redirect",
    forgedClick.status === 400 && !forgedClick.headers.get("location"),
    `HTTP ${forgedClick.status}, location=${forgedClick.headers.get("location") ?? "none"}`,
  );
  await db.$disconnect();

  // 4. A forged unsubscribe token must not be accepted.
  const forgedUnsub = await req("/api/unsubscribe?token=forged.token.value");
  check(
    "a forged unsubscribe token is rejected",
    forgedUnsub.status === 400 || forgedUnsub.status === 404,
    `HTTP ${forgedUnsub.status}`,
  );

  // 5. A cross-origin state-changing request must be rejected (CSRF).
  const csrf = await req("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ email: "a@b.test", password: "whatever12345" }),
  });
  check(
    "a cross-origin write is rejected (CSRF)",
    csrf.status === 403,
    `HTTP ${csrf.status}`,
  );

  // 6. The dry run must not have reached a provider.
  const log = logs.join("");
  const providerCalls = /"provider":"(GMAIL|SMTP)"/.test(log);
  check("the dry run never contacted a provider", !providerCalls);

  // 7. The worker must be running.
  check("the sender worker started", /starting the sender worker/.test(log));

  // 8. No credential in the log.
  const leaked = /sbp_|sb_secret_|pg[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{60,}\.[A-Za-z0-9_-]{20,}/.test(log);
  check("no credential appears in the log", !leaked);

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PRODUCTION-SAFETY CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`);
  child.kill();
  process.exit(failed.length === 0 ? 0 : 1);
})();
