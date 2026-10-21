const REF = "rkxohuoiggoxgpbcgoda";
const BASE = `https://${REF}.supabase.co`;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SECRET) {
  console.error("Set SUPABASE_SECRET_KEY to the project's secret API key.");
  console.error("  Supabase -> your project -> Settings -> API Keys");
  process.exit(1);
}

async function q(label, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  });
  const text = await res.text();
  console.log(`\n${label}`);
  console.log(`  ${res.status}  ${text.slice(0, 700)}`);
  return { status: res.status, text };
}

(async () => {
  console.log("=== what exists in the public schema right now ===");
  await q("tables (PostgREST root)", "/rest/v1/");

  console.log("\n=== a table that should exist after the bootstrap ===");
  await q("User", "/rest/v1/User?select=email,name,role&limit=3");
  await q("Contact", "/rest/v1/Contact?select=email&limit=3");

  console.log("\n=== the migration bookkeeping ===");
  await q("_prisma_migrations", "/rest/v1/_prisma_migrations?select=migration_name,checksum&order=migration_name");
})();
