const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".next", "deploy", "dist", ".agents", "coverage"]);

/** Characters that indicate a UTF-8 file was decoded as Latin-1 and re-encoded. */
const MOJIBAKE = /[\u00C2\u00C3\u00E2\u20AC\u201A\u201E\u0192\u2122\u0153\u017E\u0178]/;

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".git")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|css|md|json|yml|yaml|sh|sql|txt|prisma)$/i.test(entry.name)) continue;
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\uFFFD")) {
      findings.push({ file: path.relative(root, full), issue: "contains U+FFFD (replacement character)" });
    }
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (MOJIBAKE.test(line)) {
        const match = line.match(MOJIBAKE);
        findings.push({
          file: path.relative(root, full),
          line: index + 1,
          issue: `mojibake ${JSON.stringify(match[0])} in: ${line.trim().slice(0, 90)}`,
        });
      }
    });
  }
}

walk(root);

if (findings.length === 0) {
  console.log("No encoding damage found.");
} else {
  console.log(`${findings.length} problem(s):`);
  for (const f of findings.slice(0, 40)) {
    console.log(`  ${f.file}${f.line ? ":" + f.line : ""}  ${f.issue}`);
  }
  if (findings.length > 40) console.log(`  ... and ${findings.length - 40} more`);
}
