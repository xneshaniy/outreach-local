const REF = "rkxohuoiggoxgpbcgoda";
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const API = "https://api.supabase.com";

if (!PAT) {
  console.error("Set SUPABASE_ACCESS_TOKEN.");
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

(async () => {
  const counts = await sql(`
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
      (SELECT count(*) FROM pg_type WHERE typtype='e') AS enums,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public') AS indexes,
      (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
         WHERE n.nspname='public' AND c.contype='f') AS foreign_keys,
      (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_prisma_migrations') AS has_migrations_table
  `);
  console.log("=== schema counts ===");
  console.log(counts[0]);

  const migrations = await sql(
    "SELECT migration_name, checksum, applied_steps_count FROM _prisma_migrations ORDER BY started_at",
  );
  console.log("\n=== migration records ===");
  for (const m of migrations) {
    console.log(`  ${m.migration_name}  steps=${m.applied_steps_count}  ${m.checksum.slice(0, 16)}...`);
  }

  const partial = await sql(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname='public' AND indexdef LIKE '%WHERE%' ORDER BY indexname
  `);
  console.log("\n=== partial (filtered) unique indexes ===");
  for (const p of partial) console.log(`  ${p.indexname}`);

  const rls = await sql(`
    SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
     ORDER BY c.relname
  `);
  console.log("\n=== tables with Row Level Security enabled ===");
  console.log(rls.length === 0 ? "  none (the app connects as the table owner)" : rls.map((r) => r.relname).join(", "));

  const data = await sql(`
    SELECT
      (SELECT count(*) FROM "User") AS users,
      (SELECT count(*) FROM "Contact") AS contacts,
      (SELECT count(*) FROM "Campaign") AS campaigns,
      (SELECT count(*) FROM "Service") AS services,
      (SELECT count(*) FROM "Client") AS clients
  `);
  console.log("\n=== row counts ===");
  console.log(data[0]);
})();
