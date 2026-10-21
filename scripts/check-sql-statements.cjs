const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "scripts", "supabase-bootstrap.sql");
const text = fs.readFileSync(p, "utf8");

/**
 * A naive statement splitter - the kind a browser editor uses - stops at the
 * first ';' that is not inside a string literal or a comment. If any
 * statement in the file contains such a semicolon, the editor would run a
 * fragment, and the parser error would point at a random place.
 */
function splitLikeAnEditor(sql) {
  const statements = [];
  let current = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollarQuote = false;
  let dollarTag = "";

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      current += ch;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (inDollarQuote) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        inDollarQuote = false;
        dollarTag = "";
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "$") {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        inDollarQuote = true;
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ";") {
      statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => s.length > 0);
}

const statements = splitLikeAnEditor(text);
console.log("statements an editor would see:", statements.length);

// A real parser (Postgres) needs each statement to start with a keyword.
const VERBS = /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET|BEGIN|COMMIT|ALTER|COPY|TRUNCATE|CREATE OR REPLACE|GRANT|REVOKE|ANALYZE|VACUUM)/i;
let bad = 0;
statements.forEach((s, i) => {
  const firstToken = s.split(/\s|\(/)[0];
  if (!VERBS.test(firstToken)) {
    bad += 1;
    console.log(`  #${i + 1} starts with "${firstToken}" -> ${JSON.stringify(s.slice(0, 90))}`);
  }
});
console.log(bad === 0 ? "every statement starts with a SQL keyword" : `${bad} statement(s) start oddly`);

// Longest line and any line that would be visually wrapped in an editor.
const lines = text.split("\n");
const longest = lines.reduce((a, l) => Math.max(a, l.length), 0);
console.log("longest line:", longest, "chars");
const over120 = lines.filter((l) => l.length > 120).length;
console.log("lines over 120 chars:", over120);
console.log("statements over 200 chars:", statements.filter((s) => s.length > 200).length);
