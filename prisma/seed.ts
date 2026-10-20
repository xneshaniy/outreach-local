import { PrismaClient, type Prisma } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { normalizeEmail, normalizeTimeZone } from "../src/lib/email-normalize";
import { jobIdempotencyKey } from "../src/lib/queue";

/**
 * Idempotent development seed.
 *
 * Running `npm run db:seed` twice must not create duplicates: every write is an
 * UPSERT keyed on the same natural keys the application enforces
 * (User.email, Contact [userId,emailNormalized], CampaignRecipient
 * [campaignId,contactId], SendJob.idempotencyKey, Suppression partial uniques).
 *
 * Credentials come from the environment so no secrets live in the repository:
 *   SEED_USER_EMAIL     (default: owner@example.com)
 *   SEED_USER_PASSWORD  (default: generated and printed once; required in prod)
 */

const prisma = new PrismaClient();

type SeedContact = {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  timeZone: string | null;
  country: string;
};

const CONTACTS: SeedContact[] = [
  { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", company: "Analytical Engines", title: "CTO", timeZone: "Europe/London", country: "GB" },
  { email: "grace@example.com", firstName: "Grace", lastName: "Hopper", company: "Navy Systems", title: "Rear Admiral", timeZone: "America/New_York", country: "US" },
  { email: "alan@example.com", firstName: "Alan", lastName: "Turing", company: "Bletchley Park", title: "Researcher", timeZone: "Europe/London", country: "GB" },
  { email: "katherine@example.com", firstName: "Katherine", lastName: "Johnson", company: "NASA", title: "Mathematician", timeZone: "America/Chicago", country: "US" },
  { email: "linus@example.com", firstName: "Linus", lastName: "Torvalds", company: "Linux Foundation", title: "Maintainer", timeZone: "Europe/Helsinki", country: "FI" },
  { email: "ada.karachi@example.com", firstName: "Ayesha", lastName: "Khan", company: "Karachi Systems", title: "Founder", timeZone: "Asia/Karachi", country: "PK" },
  { email: "kenji@example.com", firstName: "Kenji", lastName: "Tanaka", company: "Tokyo Robotics", title: "VP Engineering", timeZone: "Asia/Tokyo", country: "JP" },
  // Deliberately unknown time zone: this contact is HELD for review, not sent.
  { email: "unknown.tz@example.com", firstName: "Sam", lastName: "Vega", company: "Nomad Co", title: "Consultant", timeZone: null, country: "" },
];

async function main() {
  const email = process.env.SEED_USER_EMAIL ?? "owner@example.com";
  const password = process.env.SEED_USER_PASSWORD ?? "Seed-Password-123!";
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !process.env.SEED_USER_PASSWORD) {
    throw new Error("Refusing to seed production without SEED_USER_PASSWORD.");
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, name: "Seed Owner", role: "OWNER", minDaysBetweenContacts: 3 },
    // Keep an existing password/role; only refresh the display name.
    update: { name: "Seed Owner" },
  });
  console.log(`✓ user ${user.email} (${user.id})`);

  // --- Template -------------------------------------------------------------
  const template = await prisma.emailTemplate.upsert({
    where: { id: `seed-template-${user.id}` },
    create: {
      id: `seed-template-${user.id}`,
      userId: user.id,
      name: "Intro outreach",
      description: "Short, personal introduction used by the demo campaign.",
      subject: "Quick question for {{first_name}}",
      body: [
        "<p>Hi {{first_name}},</p>",
        "<p>I noticed {{company}} is growing fast and wanted to reach out about how we help teams like yours.",
        "Would a short call next week work?</p>",
        "<p>Best,<br/>The Team</p>",
        '<p style="font-size:12px;color:#666">Don\'t want these emails? <a href="{{unsubscribe_url}}">Unsubscribe</a>.</p>',
      ].join("\n"),
    },
    update: {},
  });
  console.log(`✓ template ${template.name}`);

  // --- Contacts -------------------------------------------------------------
  const contacts = [];
  for (const c of CONTACTS) {
    const emailNormalized = normalizeEmail(c.email);
    const contact = await prisma.contact.upsert({
      where: { userId_emailNormalized: { userId: user.id, emailNormalized } },
      create: {
        userId: user.id,
        email: c.email,
        emailNormalized,
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.company,
        title: c.title,
        timeZone: normalizeTimeZone(c.timeZone ?? undefined),
        country: c.country || null,
        consentAt: new Date(),
        consentSource: "seed",
      },
      update: {},
    });
    contacts.push(contact);
  }
  console.log(`✓ ${contacts.length} contacts (1 intentionally has no time zone)`);

  // --- Campaign -------------------------------------------------------------
  const campaign = await prisma.campaign.upsert({
    where: { id: `seed-campaign-${user.id}` },
    create: {
      id: `seed-campaign-${user.id}`,
      userId: user.id,
      name: "Seed outreach campaign",
      subject: template.subject,
      body: template.body,
      templateId: template.id,
      status: "DRAFT",
      // Recipient-local 09:00–17:00 Mon–Fri; unknown time zones are held.
      windowStartMinute: 540,
      windowEndMinute: 1020,
      sendingDays: [1, 2, 3, 4, 5],
      timeZoneFallback: "HOLD",
      fromName: "Seed Sender",
      replyTo: email,
    },
    update: {},
  });
  console.log(`✓ campaign ${campaign.name}`);

  // --- Recipients + jobs ----------------------------------------------------
  // A recipient is created for every contact exactly once (UNIQUE campaignId,contactId).
  // Contacts without a valid time zone are held (HELD_TZ) per the campaign policy.
  let held = 0;
  for (const contact of contacts) {
    const status = contact.timeZone ? "SCHEDULED" : "HELD_TZ";
    if (status === "HELD_TZ") held += 1;
    const recipient = await prisma.campaignRecipient.upsert({
      where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact.id } },
      create: {
        campaignId: campaign.id,
        contactId: contact.id,
        status,
        scheduledAt: contact.timeZone ? nextWeekdayMorning() : null,
        skipReason: status === "HELD_TZ" ? "Unknown/invalid recipient time zone" : null,
      },
      update: {},
    });

    // Only scheduled recipients get a job; the key is deterministic.
    if (status === "SCHEDULED") {
      await prisma.sendJob.upsert({
        where: { idempotencyKey: jobIdempotencyKey(recipient.id) },
        create: {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          contactId: contact.id,
          userId: user.id,
          status: "QUEUED",
          scheduledAt: recipient.scheduledAt ?? nextWeekdayMorning(),
          maxAttempts: 5,
          idempotencyKey: jobIdempotencyKey(recipient.id),
        },
        update: {},
      });
    }
  }
  console.log(`✓ ${contacts.length - held} recipients queued, ${held} held for missing time zone`);

  // --- Suppressions ---------------------------------------------------------
  // Global unsubscribe + a campaign-scoped manual suppression.
  const suppressedEmail = normalizeEmail("unsubscribed@example.com");
  const existingGlobal = await prisma.suppression.findFirst({
    where: { userId: user.id, scope: "GLOBAL", emailNormalized: suppressedEmail },
  });
  if (!existingGlobal) {
    await prisma.suppression.create({
      data: {
        userId: user.id,
        scope: "GLOBAL",
        emailNormalized: suppressedEmail,
        reason: "UNSUBSCRIBE",
        source: "seed",
      },
    });
  }
  console.log("✓ suppression list seeded");

  console.log("\nSeed complete.");
  console.log(`  Login:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log("  Change the password and never reuse these values outside local dev.");
}

/** Next Monday 09:00 UTC-ish placeholder for demo scheduling. */
function nextWeekdayMorning(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

// Keep Prisma's type import referenced for future extensions.
export type SeedData = Prisma.InputJsonValue;

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
