/**
 * Split a SQL script into statements, understanding strings, comments and
 * dollar-quoted bodies.
 *
 * The bootstrap script is applied through Prisma's $executeRawUnsafe, which
 * sends a prepared statement and can therefore only carry one command. The
 * script therefore has to be split before it is applied that way. (The
 * Supabase SQL Editor runs the whole script in one go - the split is only
 * needed for the verification.)
 *
 * @returns {string[]} the statements, without their trailing semicolons
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // Dollar-quoted body
    if (ch === "$") {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        current += sql.slice(i, end === -1 ? sql.length : end + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    // Single-quoted literal ('' escapes a quote)
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          current += sql[i];
          i += 1;
          break;
        }
        current += sql[i];
        i += 1;
      }
      continue;
    }
    // Double-quoted identifier
    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // End of statement
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
