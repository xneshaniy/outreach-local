/**
 * Malformed input must be a 400, never a 500.
 *
 * A 500 means the request reached the database or threw past the validation
 * layer, which is both a bad experience and a small information leak.
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
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) values[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return values;
}

const local = localEnv();
const PORT = 3777;
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
};

const child = spawn(process.execPath, [path.join(root, "deploy", "start.js")], {
  cwd: path.join(root, "deploy"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
child.stdout.on("data", (d) => logs.push(d.toString()));
child.stderr.on("data", (d) => logs.push(d.toString()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function badInput(name, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const ok = res.status >= 400 && res.status < 500;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} HTTP ${res.status}`);
}

(async () => {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === 200) break;
    } catch {}
    await wait(1000);
  }

  console.log("\n=== malformed input is a 4xx, never a 5xx ===");
  await badInput("login with no body", "/api/auth/login", {});
  await badInput("login with a bad email", "/api/auth/login", { email: "not-an-email", password: "x" });
  await badInput("login with a missing password", "/api/auth/login", { email: "a@b.test" });
  await badInput("register with a bad email", "/api/auth/register", { email: "nope", password: "short" });
  await badInput("forgot-password with a bad email", "/api/auth/forgot-password", { email: "nope" });
  await badInput("client-login with no body", "/api/auth/client-login", {});
  await badInput("a contact with no email", "/api/contacts", { email: "" });
  await badInput("a contact with a bad email", "/api/contacts", { email: "nope" });
  await badInput("a campaign with no name", "/api/campaigns", { name: "" });
  await badInput("a campaign with a bad subject", "/api/campaigns", { name: "x", subject: "", body: "" });
  await badInput("a template with no body", "/api/templates", { name: "x", subject: "", body: "" });
  await badInput("a segment with no name", "/api/segments", { name: "" });
  await badInput("a service with no name", "/api/services", { name: "" });
  await badInput("a task with no title", "/api/tasks", { title: "" });
  await badInput("malformed JSON", "/api/auth/login", "{not json");
  await badInput("an unknown field", "/api/auth/login", { email: "a@b.test", password: "x", isAdmin: true });

  console.log("");
  console.log(failures === 0 ? "ALL INPUT-VALIDATION CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})();
