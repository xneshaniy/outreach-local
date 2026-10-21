import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { runPreflight } from "@/lib/preflight";
import { segmentCount, segmentWhere } from "@/lib/segments";
import { ensureDefaultStages, moveContactToStage, convertProspect } from "@/lib/pipeline";
import { recordActivity, addNote, listActivity } from "@/lib/activity";
import { listNotifications, markRead, notify } from "@/lib/notifications";
import {
  createAlwaysOnCampaign,
  createTestCampaign,
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * The pipeline, the CRM, the notifications and the pre-flight checks.
 */

/**
 * The owner session is read through next/headers, so the cookie jar is mocked.
 * The jar is filled per test with a real session token.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "eop_session" && sessionJar.token
        ? { name: "eop_session", value: sessionJar.token }
        : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const sessionJar = vi.hoisted(() => ({ token: null as string | null }));

/** Sign in as the given user for the duration of the test. */
async function signIn(user: { id: string; email: string; sessionVersion: number }) {
  const { createSessionToken } = await import("@/lib/auth/session");
  sessionJar.token = await createSessionToken({
    sub: user.id,
    email: user.email,
    sv: user.sessionVersion,
  });
  return sessionJar.token;
}

describe.runIf(dbEnabled)("pipeline, notifications and pre-flight", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  // -------------------------------------------------------------------------
  describe("lead stages", () => {
    it("creates the default stages once", async () => {
      const user = await createTestUser();
      const first = await ensureDefaultStages(user.id);
      expect(first.length).toBeGreaterThanOrEqual(5);
      expect(first.map((s) => s.name)).toContain("Qualified");

      const second = await ensureDefaultStages(user.id);
      expect(second).toHaveLength(first.length);
      expect(await prisma.leadStage.count({ where: { userId: user.id } })).toBe(first.length);
    });

    it("records the stage change on the timeline", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "stage@example.test");
      const stages = await ensureDefaultStages(user.id);
      const target = stages.find((s) => s.name === "Qualified")!;

      await moveContactToStage({ userId: user.id, contactId: contact.id, stageId: target.id });

      const updated = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      expect(updated.stageId).toBe(target.id);

      const activity = await listActivity(contact.id);
      expect(activity.some((a) => (a as { type: string }).type === "STAGE_CHANGED")).toBe(true);
    });

    it("refuses a stage from another workspace", async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      const contact = await createTestContact(userA.id, "cross@example.test");
      const stagesB = await ensureDefaultStages(userB.id);

      await expect(
        moveContactToStage({
          userId: userA.id,
          contactId: contact.id,
          stageId: stagesB[0]!.id,
        }),
      ).rejects.toThrow(/stage does not exist/i);
    });
  });

  // -------------------------------------------------------------------------
  describe("prospect conversion", () => {
    it("links a contact to the client it became", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "convert@example.test");
      const client = await prisma.client.create({
        data: {
          userId: user.id,
          email: "convert-client@example.test",
          passwordHash: await hashPassword("Client-Password-123!"),
          name: "Converted Ltd",
        },
      });

      await convertProspect({ userId: user.id, contactId: contact.id, clientId: client.id });

      const updated = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      expect(updated.convertedAt).not.toBeNull();
      expect(updated.convertedToClientId).toBe(client.id);
    });
  });

  // -------------------------------------------------------------------------
  describe("contact activity and notes", () => {
    it("records activity and notes on the timeline", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "timeline@example.test");

      await recordActivity({
        userId: user.id,
        contactId: contact.id,
        type: "EMAIL_SENT",
        summary: "Email sent: Hello",
      });
      await addNote({ userId: user.id, contactId: contact.id, body: "Called on Tuesday." });

      const activity = await listActivity(contact.id);
      const types = activity.map((a) => (a as { type: string }).type);
      expect(types).toContain("EMAIL_SENT");
      expect(types).toContain("NOTE_ADDED");
    });
  });

  // -------------------------------------------------------------------------
  describe("notifications", () => {
    it("stores, lists and marks notifications read", async () => {
      const user = await createTestUser();
      await notify({
        userId: user.id,
        type: "REPLY",
        title: "Reply from ada@example.test",
        body: "Yes, sounds good",
        link: "/replies",
      });

      const { items, unread } = await listNotifications(user.id);
      expect(items).toHaveLength(1);
      expect(unread).toBe(1);

      const id = (items[0] as { id: string }).id;
      expect(await markRead(user.id, [id])).toBe(1);
      const after = await listNotifications(user.id);
      expect(after.unread).toBe(0);
    });

    it("does not leak notifications between workspaces", async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      await notify({ userId: userA.id, type: "SYSTEM", title: "Only for A" });

      const b = await listNotifications(userB.id);
      expect(b.items).toHaveLength(0);
      expect(b.unread).toBe(0);
    });

    it("never throws when the notification cannot be stored", async () => {
      await createTestUser();
      // A user that does not exist -> the FK fails, but notify() swallows it.
      await expect(
        notify({ userId: "does-not-exist", type: "SYSTEM", title: "x" }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("segments", () => {
    it("counts only the contacts that match the filters", async () => {
      const user = await createTestUser();
      const tagged = await createTestContact(user.id, "tagged@example.test");
      await prisma.contact.update({ where: { id: tagged.id }, data: { tags: ["saas"] } });
      await createTestContact(user.id, "plain@example.test");

      const count = await segmentCount(user.id, { tags: ["saas"] });
      expect(count).toBe(1);
    });

    it("excludes archived contacts", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "archived@example.test");
      await prisma.contact.update({ where: { id: contact.id }, data: { isArchived: true } });

      const where = segmentWhere(user.id, {});
      expect(where.isArchived).toBe(false);
      expect(await segmentCount(user.id, {})).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("campaign pre-flight", () => {
    it("blocks a campaign with no message", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { subject: "", body: "" });
      const report = await runPreflight(campaign);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === "NO_SUBJECT")).toBe(true);
      expect(report.findings.some((f) => f.code === "NO_BODY")).toBe(true);
    });

    it("blocks a campaign with no unsubscribe link", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, {
        body: "<p>Hello there</p>",
        subject: "Hi",
      });
      const report = await runPreflight(campaign);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.code === "NO_UNSUBSCRIBE")).toBe(true);
    });

    it("accepts a complete campaign and counts the eligible recipients", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id, {
        body: "<p>Hi {{first_name}}</p><p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
        subject: "Hi {{first_name}}",
      });
      const contact = await createTestContact(user.id, "ok@example.test", "Europe/London");
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const report = await runPreflight(campaign);
      expect(report.eligible).toBe(1);
      expect(report.excluded).toBe(0);
      // No sender account exists in this test, so that is a blocker.
      expect(report.findings.some((f) => f.code === "NO_SENDER")).toBe(true);
    });

    it("explains why a recipient is excluded", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id, {
        body: "<p>Hi</p><p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
      });
      const contact = await createTestContact(user.id, "held@example.test", null);
      await prisma.campaignRecipient.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          status: "HELD_TZ",
          skipReason: "UNKNOWN_TIMEZONE",
        },
      });

      const report = await runPreflight(campaign);
      expect(report.eligible).toBe(0);
      expect(report.excludedReasons.UNKNOWN_TIMEZONE).toBe(1);
      expect(report.findings.some((f) => f.code === "HELD_TIMEZONE")).toBe(true);
    });

    it("reports the missing personalisation variables", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id, {
        body: "<p>Hi {{first_name}} {{title}}</p><p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
      });
      const contact = await createTestContact(user.id, "notitle@example.test", "Europe/London");
      await prisma.contact.update({ where: { id: contact.id }, data: { title: null } });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const report = await runPreflight(campaign);
      expect(report.personalization.missing).toContain("title");
    });

    it("says the provider cannot report delivery", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id, {
        body: "<p>Hi</p><p><a href='{{unsubscribe_url}}'>Unsubscribe</a></p>",
      });
      const report = await runPreflight(campaign, { provider: "GMAIL" });
      expect(report.findings.some((f) => f.code === "NO_DELIVERY_DATA")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("bulk contact updates", () => {
    it("previews before it applies and never overwrites silently", async () => {
      const user = await createTestUser();
      const a = await createTestContact(user.id, "a@example.test");
      const b = await createTestContact(user.id, "b@example.test");
      await prisma.contact.update({ where: { id: a.id }, data: { source: "old" } });

      await signIn(user);
      const { POST } = await import("@/app/api/contacts/bulk/route");
      const previewRes = await POST(
        new NextRequest("http://localhost:3000/api/contacts/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "preview", ids: [a.id, b.id], changes: { source: "new" } }),
        }),
      );
      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as { changed: number; preview: Array<{ changed: boolean }> };
      expect(preview.changed).toBe(2);
      // Nothing was written yet.
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: a.id } })).source).toBe("old");

      const applyRes = await POST(
        new NextRequest("http://localhost:3000/api/contacts/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "apply", ids: [a.id, b.id], changes: { source: "new" } }),
        }),
      );
      expect(applyRes.status).toBe(200);
      const applied = (await applyRes.json()) as { updated: number };
      expect(applied.updated).toBe(2);
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: a.id } })).source).toBe("new");
    });

    it("never touches a contact from another workspace", async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      const foreign = await createTestContact(userB.id, "foreign@example.test");

      await signIn(userA);
      const { POST } = await import("@/app/api/contacts/bulk/route");
      const res = await POST(
        new NextRequest("http://localhost:3000/api/contacts/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "apply", ids: [foreign.id], changes: { source: "hacked" } }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number; missing: string[] };
      expect(body.updated).toBe(0);
      expect(body.missing).toContain(foreign.id);
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: foreign.id } })).source).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("dead-letter retry", () => {
    it("retries a failed job but refuses an ambiguous one", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id);
      const contact = await createTestContact(user.id, "retry@example.test", "Europe/London");
      const recipient = await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
        select: { id: true },
      });

      const failed = await prisma.sendJob.create({
        data: {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          contactId: contact.id,
          userId: user.id,
          status: "FAILED",
          scheduledAt: new Date(),
          idempotencyKey: `job:${recipient.id}`,
          deadLetteredAt: new Date(),
          attempts: 1,
        },
      });

      await signIn(user);
      const { POST } = await import("@/app/api/jobs/[id]/retry/route");
      const ok = await POST(
        new NextRequest(`http://localhost:3000/api/jobs/${failed.id}/retry`, { method: "POST" }),
        { params: Promise.resolve({ id: failed.id }) },
      );
      expect(ok.status).toBe(200);
      const retried = await prisma.sendJob.findUniqueOrThrow({ where: { id: failed.id } });
      expect(retried.status).toBe("QUEUED");
      expect(retried.deadLetteredAt).toBeNull();

      // An uncertain outcome must never be retried automatically.
      const ambiguous = await prisma.sendJob.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          userId: user.id,
          status: "AMBIGUOUS",
          scheduledAt: new Date(),
          idempotencyKey: `job:ambiguous-${recipient.id}`,
          ambiguousSince: new Date(),
        },
      });
      const refused = await POST(
        new NextRequest(`http://localhost:3000/api/jobs/${ambiguous.id}/retry`, { method: "POST" }),
        { params: Promise.resolve({ id: ambiguous.id }) },
      );
      expect(refused.status).toBe(400);
      const still = await prisma.sendJob.findUniqueOrThrow({ where: { id: ambiguous.id } });
      expect(still.status).toBe("AMBIGUOUS");
    });
  });
});
