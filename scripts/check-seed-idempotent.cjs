const { execFileSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const root = path.join(__dirname, "..");
const url = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env.supabase"), "utf8"))[1].trim();

const p = new PrismaClient({ datasourceUrl: url });

const counts = async () => ({
  users: await p.user.count(),
  clients: await p.client.count(),
  contacts: await p.contact.count(),
  campaigns: await p.campaign.count(),
  services: await p.service.count(),
  stages: await p.leadStage.count(),
  templates: await p.emailTemplate.count(),
  sequences: await p.followUpSequence.count(),
  recipients: await p.campaignRecipient.count(),
  jobs: await p.sendJob.count(),
  suppressions: await p.suppression.count(),
});

(async () => {
  const before = await counts();
  console.log("before:", JSON.stringify(before));

  console.log("\nre-running the seed...");
  execFileSync("npx tsx prisma/seed.ts", {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const after = await counts();
  console.log("after :", JSON.stringify(after));

  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log("");
  console.log(
    changed.length === 0
      ? "THE SEED IS IDEMPOTENT - re-running it changed nothing"
      : `THE SEED CHANGED: ${changed.join(", ")}`,
  );
  await p.$disconnect();
  process.exit(changed.length === 0 ? 0 : 1);
})();
