const REF = "rkxohuoiggoxgpbcgoda";
const BASE = `https://${REF}.supabase.co`;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SECRET) {
  console.error("Set SUPABASE_SECRET_KEY to the project's secret API key.");
  console.error("  Supabase -> your project -> Settings -> API Keys");
  process.exit(1);
}

(async () => {
  const res = await fetch(`${BASE}/rest/v1/`, {
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  });
  const spec = await res.json();

  const tables = Object.keys(spec.paths ?? {})
    .map((p) => p.replace(/^\//, ""))
    .filter((p) => p && p !== "rpc" && !p.startsWith("rpc/"))
    .sort();

  console.log(`tables exposed by PostgREST: ${tables.length}`);
  console.log(tables.join(", "));

  const migRes = await fetch(`${BASE}/rest/v1/_prisma_migrations?select=migration_name,checksum&order=migration_name`, {
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  });
  const migrations = await migRes.json();

  console.log(`\nmigrations recorded: ${migrations.length}`);
  for (const m of migrations) {
    console.log(`  ${m.migration_name}  ${m.checksum.slice(0, 16)}...`);
  }

  // The expected table list, from the Prisma schema.
  const expected = [
    "AuditLog", "Campaign", "CampaignDailyUsage", "CampaignRecipient", "CampaignSegment",
    "Client", "ClientCampaignAccess", "Contact", "ContactActivity", "ContactNote",
    "EmailTemplate", "FollowUpMessage", "FollowUpSequence", "FollowUpStep",
    "IdempotencyKey", "ImportBatch", "LeadStage", "Notification", "PasswordResetToken",
    "Reply", "SendAttempt", "SendJob", "SenderAccount", "SenderDailyUsage", "Service",
    "Suppression", "Task", "TemplateVersion", "TrackingEvent", "UnsubscribeEvent",
    "User", "WebhookEvent",
  ];

  const missing = expected.filter((t) => !tables.includes(t));
  const extra = tables.filter((t) => !expected.includes(t));

  console.log(`\nexpected ${expected.length} tables, found ${tables.length}`);
  console.log(`missing: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`unexpected: ${extra.length ? extra.join(", ") : "none"}`);
  console.log(`\nRESULT: ${missing.length === 0 && migrations.length === 6 ? "THE SCHEMA IS COMPLETE" : "INCOMPLETE"}`);
})();
