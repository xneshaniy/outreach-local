const fs = require("fs");
const { execFileSync } = require("child_process");

/**
 * Fail if any tracked file contains something that looks like a secret.
 *
 * A secret that reaches Git has to be rotated, so this is a hard gate. The
 * patterns are assembled from fragments so that this file does not match
 * itself.
 */
const PATTERNS = [
  // Neon / Postgres passwords
  { name: "postgres password", re: new RegExp("np" + "g_[A-Za-z0-9]{20,}") },
  // Supabase API keys
  { name: "supabase secret key", re: new RegExp("sb_" + "secret_[A-Za-z0-9_]{20,}") },
  { name: "supabase publishable key", re: new RegExp("sb_" + "publishable_[A-Za-z0-9_]{20,}") },
  // Vercel / Supabase style tokens
  { name: "vercel token", re: new RegExp("vc" + "k_[A-Za-z0-9]{20,}") },
  // GitHub
  { name: "github token", re: new RegExp("gh" + "p_[A-Za-z0-9]{30,}") },
  // AWS
  { name: "aws access key", re: new RegExp("AK" + "IA[0-9A-Z]{16}") },
  // Private keys
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Our own secrets, split so this file does not match itself.
  { name: "AUTH_SECRET", re: new RegExp("pCSP" + "7Hcy2bEJEXcDQCWOfOuIrhdg[^\\s\"']*") },
  { name: "ENCRYPTION_KEY", re: new RegExp("YL634" + "NLF85OOELP7ScjqSdCD5T[^\\s\"']*") },
];

// Files that are allowed to contain the patterns above (none, currently).
const ALLOW = [];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !ALLOW.includes(f));

let bad = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    const matches = text.match(re);
    if (matches) {
      bad += 1;
      console.log(`SECRET (${name}) in ${file}: ${matches.length} match(es)`);
    }
  }
}

if (bad > 0) {
  console.error(`\n${bad} file(s) contain what looks like a secret.`);
  process.exit(1);
}
console.log(`No secrets found in ${files.length} tracked files.`);
