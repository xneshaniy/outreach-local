const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const root = path.join(__dirname, "..");
const url = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env.supabase"), "utf8"))[1].trim();
const p = new PrismaClient({ datasourceUrl: url });

(async () => {
  const t = await p.$queryRawUnsafe("SELECT current_database() AS db, current_user AS usr");
  console.log("  connected  :", JSON.stringify(t[0]));

  const m = await p.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations ORDER BY started_at");
  console.log(`  migrations : ${m.length}`);
  for (const x of m) console.log(`      ${x.migration_name}`);

  const c = await p.$queryRawUnsafe(
    `SELECT
       (SELECT count(*)::int FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
       (SELECT count(*)::int FROM pg_type WHERE typtype = 'e') AS enums,
       (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
       (SELECT count(*)::int FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = 'public' AND c.contype = 'f') AS fks,
       (SELECT count(*)::int FROM pg_indexes
         WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%') AS partial_indexes`,
  );
  console.log("  schema     :", JSON.stringify(c[0]));

  const rows = {
    users: await p.user.count(),
    clients: await p.client.count(),
    contacts: await p.contact.count(),
    campaigns: await p.campaign.count(),
    services: await p.service.count(),
    senderAccounts: await p.senderAccount.count(),
  };
  console.log("  rows       :", JSON.stringify(rows));

  const rls = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
  );
  const forced = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity`,
  );
  console.log(`  RLS        : ${rls[0].n} tables with RLS enabled, ${forced[0].n} forced`);

  await p.$disconnect();
})().catch((e) => {
  console.log("  ERROR", String(e.message).split("\n")[0]);
  process.exit(1);
});
