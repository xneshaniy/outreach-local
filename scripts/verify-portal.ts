/**
 * End-to-end check of the client portal and tracking against a running
 * server. It creates a client, assigns a campaign, simulates an open and a
 * click, and verifies the portal numbers.
 *
 * Usage: npx tsx scripts/verify-portal.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3111";

async function main() {
  const prisma = new PrismaClient();

  const owner = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("No owner found - run the seed first.");
  const campaign = await prisma.campaign.findFirst({ where: { userId: owner.id } });
  if (!campaign) throw new Error("No campaign found - run the seed first.");
  const contact = await prisma.contact.findFirst({ where: { userId: owner.id } });
  if (!contact) throw new Error("No contact found - run the seed first.");

  // Create / refresh a client account.
  const email = "client@example.test";
  await prisma.client.upsert({
    where: { email },
    create: {
      userId: owner.id,
      email,
      passwordHash: await hashPassword("Client-Password-123!"),
      name: "Acme Ltd",
      company: "Acme Ltd",
    },
    update: { passwordHash: await hashPassword("Client-Password-123!"), isActive: true },
  });
  const client = await prisma.client.findUniqueOrThrow({ where: { email } });

  // Assign the campaign to that client (and to nobody else).
  await prisma.clientCampaignAccess.deleteMany({ where: { clientId: client.id } });
  await prisma.clientCampaignAccess.create({
    data: { clientId: client.id, campaignId: campaign.id },
  });

  // A second client with NO access, to prove isolation.
  const otherEmail = "other@example.test";
  await prisma.client.upsert({
    where: { email: otherEmail },
    create: {
      userId: owner.id,
      email: otherEmail,
      passwordHash: await hashPassword("Client-Password-123!"),
      name: "Other Ltd",
    },
    update: {},
  });
  const other = await prisma.client.findUniqueOrThrow({ where: { email: otherEmail } });
  void other;

  // Enable tracking on the campaign.
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { trackingEnabled: true, clickTrackingEnabled: true },
  });

  // Mark the recipient as sent so the numbers are meaningful.
  const recipient = await prisma.campaignRecipient.upsert({
    where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } },
    create: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: "SENT",
      scheduledAt: new Date(),
      sentAt: new Date(),
    },
    update: { status: "SENT", sentAt: new Date() },
    select: { id: true },
  });
  await prisma.sendJob.upsert({
    where: { campaignRecipientId: recipient.id },
    create: {
      campaignRecipientId: recipient.id,
      campaignId: campaign.id,
      contactId: contact.id,
      userId: owner.id,
      status: "SENT",
      scheduledAt: new Date(),
      idempotencyKey: `job:${recipient.id}`,
      providerMessageId: "verify-msg",
    },
    update: { status: "SENT" },
  });

  // --- 1. The tracking pixel -------------------------------------------------
  const { buildOpenPixelUrl, buildClickUrl } = await import("../src/lib/tracking");
  const pixelUrl = buildOpenPixelUrl(campaign.id, contact.id);
  const pixelToken = decodeURIComponent(pixelUrl.split("t=")[1]!);

  const pixelRes = await fetch(`${BASE}/api/track/open?t=${encodeURIComponent(pixelToken)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" },
  });
  const pixelBody = Buffer.from(await pixelRes.arrayBuffer());
  console.log(
    `PIXEL      status=${pixelRes.status} type=${pixelRes.headers.get("content-type")} isGif=${pixelBody
      .subarray(0, 3)
      .toString("ascii") === "GIF"}`,
  );

  // Open it twice more -> the total grows, the unique count does not.
  for (let i = 0; i < 2; i++) {
    await fetch(`${BASE}/api/track/open?t=${encodeURIComponent(pixelToken)}`, {
      headers: { "user-agent": "Mozilla/5.0 Safari" },
    });
  }

  // A bot open must not count as a unique human open.
  await fetch(`${BASE}/api/track/open?t=${encodeURIComponent(pixelToken)}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
  });

  // --- 2. A tracked click ----------------------------------------------------
  const clickUrl = buildClickUrl(campaign.id, contact.id, "https://example.com/offer");
  const clickToken = decodeURIComponent(clickUrl.split("t=")[1]!);
  const clickRes = await fetch(`${BASE}/api/track/click?t=${encodeURIComponent(clickToken)}`, {
    redirect: "manual",
    headers: { "user-agent": "Mozilla/5.0 Safari" },
  });
  console.log(`CLICK      status=${clickRes.status} location=${clickRes.headers.get("location")}`);

  // --- 3. A forged token must be rejected ------------------------------------
  const forged = await fetch(`${BASE}/api/track/open?t=forged.signature`);
  console.log(`FORGED     status=${forged.status} (must be 200 with a valid GIF, but nothing recorded)`);

  // --- 4. The client portal --------------------------------------------------
  const login = await fetch(`${BASE}/api/auth/client-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Client-Password-123!" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  console.log(`LOGIN      status=${login.status} cookie=${cookie ? "yes" : "no"}`);

  const summary = await fetch(`${BASE}/api/portal/summary`, { headers: { cookie } });
  const summaryBody = (await summary.json()) as {
    campaigns: number;
    totals: { sent: number; uniqueOpens: number; totalOpens: number; uniqueClicks: number; openRate: number | null; rateDenominator: string };
    availability: { delivered: boolean; opens: boolean; clicks: boolean };
  };
  console.log(`SUMMARY    status=${summary.status} campaigns=${summaryBody.campaigns}`);
  console.log(
    `           sent=${summaryBody.totals.sent} uniqueOpens=${summaryBody.totals.uniqueOpens} totalOpens=${summaryBody.totals.totalOpens} uniqueClicks=${summaryBody.totals.uniqueClicks}`,
  );
  console.log(`           openRate=${summaryBody.totals.openRate}% (denominator: ${summaryBody.totals.rateDenominator})`);
  console.log(
    `           available: delivered=${summaryBody.availability.delivered} opens=${summaryBody.availability.opens} clicks=${summaryBody.availability.clicks}`,
  );

  // --- 5. Isolation ----------------------------------------------------------
  const report = await fetch(`${BASE}/api/portal/campaigns/${campaign.id}`, { headers: { cookie } });
  console.log(`REPORT     status=${report.status} (own campaign -> 200)`);

  const otherLogin = await fetch(`${BASE}/api/auth/client-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: otherEmail, password: "Client-Password-123!" }),
  });
  const otherCookie = (otherLogin.headers.get("set-cookie") ?? "").split(";")[0];
  const denied = await fetch(`${BASE}/api/portal/campaigns/${campaign.id}`, { headers: { cookie: otherCookie } });
  console.log(`ISOLATION  status=${denied.status} (another client's campaign -> 404)`);

  const otherSummary = await fetch(`${BASE}/api/portal/summary`, { headers: { cookie: otherCookie } });
  const otherBody = (await otherSummary.json()) as { campaigns: number };
  console.log(`ISOLATION  other client sees ${otherBody.campaigns} campaign(s) (must be 0)`);

  const csv = await fetch(`${BASE}/api/portal/reports/export`, { headers: { cookie } });
  const csvText = await csv.text();
  console.log(`EXPORT     status=${csv.status} lines=${csvText.trim().split("\n").length} hasCampaign=${csvText.includes(campaign.name)}`);

  const print = await fetch(`${BASE}/api/portal/reports/print?campaignId=${campaign.id}`, { headers: { cookie } });
  console.log(`PRINT      status=${print.status} type=${print.headers.get("content-type")}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
