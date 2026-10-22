const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const url = /^TEST_DATABASE_URL=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env.supabase"), "utf8"))[1].trim();

const prisma = new PrismaClient({ datasourceUrl: url });

async function lockSenderRow(tx, senderAccountId, day) {
  await tx.$executeRaw`
    INSERT INTO "SenderDailyUsage" ("id", "senderAccountId", "date", "sentCount", "reservedCount", "failureCount", "updatedAt")
    VALUES (gen_random_uuid()::text, ${senderAccountId}, ${day}, 0, 0, 0, now())
    ON CONFLICT ("senderAccountId", "date") DO NOTHING`;

  const rows = await tx.$queryRaw`
    SELECT "id", "sentCount", "reservedCount"
    FROM "SenderDailyUsage"
    WHERE "senderAccountId" = ${senderAccountId} AND "date" = ${day}
    FOR UPDATE`;

  const row = rows[0];
  if (!row) throw new Error("Failed to lock sender quota row.");
  return row;
}

async function reserveSenderSlot(tx, senderAccountId, cap, day) {
  const row = await lockSenderRow(tx, senderAccountId, day);
  const used = row.sentCount + row.reservedCount;
  if (used >= cap) {
    const e = new Error(`Sender daily cap of ${cap} reached.`);
    e.name = "QuotaExceededError";
    throw e;
  }
  await tx.$executeRaw`
    UPDATE "SenderDailyUsage"
    SET "reservedCount" = "reservedCount" + 1, "updatedAt" = now()
    WHERE "id" = ${row.id}`;
}

(async () => {
  console.log("host:", new URL(url).host);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SenderDailyUsage", "SenderAccount", "User" CASCADE');

  const user = await prisma.user.create({
    data: { email: `probe-${Date.now()}@example.test`, passwordHash: "x", name: "Probe" },
  });
  const account = await prisma.senderAccount.create({
    data: {
      userId: user.id,
      provider: "SMTP",
      email: `probe-${Date.now()}@example.test`,
      status: "CONNECTED",
      dailyCap: 5,
    },
  });

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  const started = Date.now();
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      prisma.$transaction((tx) => reserveSenderSlot(tx, account.id, 5, day)),
    ),
  );
  const elapsed = Date.now() - started;

  const fulfilled = attempts.filter((a) => a.status === "fulfilled").length;
  const quota = attempts.filter((a) => a.status === "rejected" && a.reason?.name === "QuotaExceededError").length;
  console.log(`\nelapsed: ${elapsed}ms | fulfilled: ${fulfilled} | quota errors: ${quota}`);
  console.log("\nrejection reasons:");
  for (const a of attempts) {
    if (a.status === "rejected") {
      const e = a.reason;
      console.log(`  [${e.code ?? e.name ?? "?"}] ${String(e.message).split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 170)}`);
    }
  }
})();
