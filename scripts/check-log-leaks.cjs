const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".next", "deploy", "dist", ".agents", "coverage"]);

const findings = [];

/**
 * A logger call that passes something that could be a credential.
 *
 * A bare "code" is NOT included: provider error codes ("SMTP_550") are
 * diagnostics, not secrets, and flagging them would bury the real findings.
 * OAuth authorization codes are covered by "authorization"/"oauth".
 */
const SUSPICIOUS =
  /\b(resetUrl|resetToken|token|accessToken|refreshToken|idToken|secret|password|passphrase|apiKey|api_key|authorization|oauth|cookie|credential|smtpPassword|providerToken)\b/;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;

    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!/logger\.(debug|info|warn|error)\(/.test(line)) return;
      // Collect the whole call (it may span lines).
      let call = line;
      let end = index;
      while (!call.includes(");") && end + 1 < lines.length && end - index < 6) {
        end += 1;
        call += " " + lines[end].trim();
      }
      if (SUSPICIOUS.test(call)) {
        findings.push({
          file: path.relative(root, full),
          line: index + 1,
          call: call.replace(/\s+/g, " ").slice(0, 130),
          // Either the whole object is redacted, or the free-text message is
          // scrubbed - both keep the credential out of the log.
          redacted: /redact\(|scrubMessage\(/.test(call),
        });
      }
    });
  }
}

walk(path.join(root, "src"));

console.log(`Logger calls that may carry a credential: ${findings.length}\n`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}${f.redacted ? "  [redacted]" : "  [NOT REDACTED]"}`);
  console.log(`      ${f.call}`);
}

const unredacted = findings.filter((f) => !f.redacted);
if (unredacted.length > 0) {
  console.error(
    `\n${unredacted.length} logger call(s) can write a credential to the log.`,
  );
  console.error("Wrap the object in redact(), or the message in scrubMessage().");
  process.exit(1);
}
console.log("\nEvery one of them is redacted or scrubbed.");
