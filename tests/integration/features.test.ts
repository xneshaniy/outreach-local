import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  advanceFollowUp,
  cancelFollowUpsForContact,
  isEligibleForFollowUp,
  scheduleNextFollowUp,
} from "@/lib/followup";
import { recordReply, matchReply } from "@/lib/replies";
import { ensureStarterServices, slugify } from "@/lib/services";
import { createScheduledRecipient } from "./helpers";
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
 * Spec §5-6: services, follow-up sequences and reply handling.
 */

describe.runIf(dbEnabled)("services, follow-ups and replies", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  // -------------------------------------------------------------------------
  describe("service profiles", () => {
    it("creates one starter profile per business line, only once", async () => {
      const user = await createTestUser();
      const first = await ensureStarterServices(user.id);
      expect(first.length).toBeGreaterThanOrEqual(5);
      expect(first.map((s) => s.slug)).toContain("lead-generation");
      expect(first.map((s) => s.slug)).toContain("virtual-assistance");
      expect(first.map((s) => s.slug)).toContain("crm-automation");
      expect(first.map((s) => s.slug)).toContain("email-outreach");
      expect(first.map((s) => s.slug)).toContain("ecommerce-management");

      // Idempotent: a second call must not create duplicates.
      const second = await ensureStarterServices(user.id);
      expect(second.length).toBe(first.length);
      expect(await prisma.service.count({ where: { userId: user.id } })).toBe(first.length);
    });

    it("keeps slugs unique per workspace but allows the same slug for another user", async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const first = await ensureStarterServices(a.id);
      const other = await ensureStarterServices(b.id);
      expect(first[0]!.slug).toBe(other[0]!.slug);
      expect(slugify("Lead Generation & List Building")).toBe("lead-generation-list-building");
    });
  });

  // -------------------------------------------------------------------------
  describe("follow-up sequences", () => {
    it("schedules the next step after the first email is delivered", async () => {
      const user = await createTestUser();
      const campaign = await createAlwaysOnCampaign(user.id);
      const contact = await createTestContact(user.id, "ada@example.test", "Europe/London");

      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Two bumps",
          steps: {
            create: [
              { order: 1, delayDays: 3, subject: "Bump 1", body: "<p>First bump</p>" },
              { order: 2, delayDays: 4, subject: "Bump 2", body: "<p>Second bump</p>" },
            ],
          },
        },
        include: { steps: true },
      });

      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { followUpSequenceId: sequence.id },
      });

      const full = await prisma.contact.findUniqueOrThrow({
        where: { id: contact.id },
      });
      const freshCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

      const sentAt = new Date();
      await advanceFollowUp({
        userId: user.id,
        campaign: freshCampaign,
        contact: full,
        sentAt,
        minDaysBetweenContacts: 0,
      });

      const messages = await prisma.followUpMessage.findMany({ where: { contactId: contact.id } });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.status).toBe("SCHEDULED");
      // 3 days later, clamped into the recipient's local window.
      expect(messages[0]!.scheduledAt.getTime()).toBeGreaterThan(sentAt.getTime());

      // The job that delivers it exists and is linked to the message.
      const job = await prisma.sendJob.findFirst({ where: { followUpMessageId: messages[0]!.id } });
      expect(job).toBeTruthy();
      expect(job!.status).toBe("QUEUED");
      expect(job!.kind).toBe("FOLLOW_UP");
    });

    it("never schedules a second copy of the same step", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
      const contact = await createTestContact(user.id, "grace@example.test", "Europe/London");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "One bump",
          steps: { create: [{ order: 1, delayDays: 2, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { followUpSequenceId: sequence.id },
      });

      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      const sentAt = new Date();

      await advanceFollowUp({ userId: user.id, campaign: fresh, contact: full, sentAt, minDaysBetweenContacts: 0 });
      await advanceFollowUp({ userId: user.id, campaign: fresh, contact: full, sentAt, minDaysBetweenContacts: 0 });

      const messages = await prisma.followUpMessage.findMany({ where: { contactId: contact.id } });
      expect(messages).toHaveLength(1);
      expect(await prisma.sendJob.count({ where: { followUpMessageId: messages[0]!.id } })).toBe(1);
    });

    it("does not schedule a follow-up for an unsubscribed contact", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
      const contact = await createTestContact(user.id, "bounced@example.test", "Europe/London");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Bump",
          steps: { create: [{ order: 1, delayDays: 1, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { followUpSequenceId: sequence.id },
      });
      await prisma.contact.update({ where: { id: contact.id }, data: { status: "UNSUBSCRIBED" } });

      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      await advanceFollowUp({
        userId: user.id,
        campaign: fresh,
        contact: full,
        sentAt: new Date(),
        minDaysBetweenContacts: 0,
      });

      expect(await prisma.followUpMessage.count({ where: { contactId: contact.id } })).toBe(0);
    });

    it("cancels pending follow-ups when the contact replies", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
      const contact = await createTestContact(user.id, "reply@example.test", "Europe/London");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Bump",
          steps: { create: [{ order: 1, delayDays: 1, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { followUpSequenceId: sequence.id },
      });

      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      await advanceFollowUp({
        userId: user.id,
        campaign: fresh,
        contact: full,
        sentAt: new Date(),
        minDaysBetweenContacts: 0,
      });
      expect(await prisma.followUpMessage.count({ where: { contactId: contact.id } })).toBe(1);

      // A reply arrives.
      const result = await recordReply({
        userId: user.id,
        provider: "gmail",
        messageId: "gmail-msg-1",
        fromEmail: "reply@example.test",
        toEmail: "sender@example.com",
        subject: "Re: your email",
        snippet: "Yes, sounds good",
        receivedAt: new Date(),
      });
      expect(result.created).toBe(true);
      expect(result.contactId).toBe(contact.id);

      // The contact is marked as replied and the follow-up is cancelled.
      const updated = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      expect(updated.status).toBe("REPLIED");
      expect(updated.repliedCount).toBe(1);
      expect(updated.lastRepliedAt).not.toBeNull();

      const messages = await prisma.followUpMessage.findMany({ where: { contactId: contact.id } });
      expect(messages[0]!.status).toBe("CANCELLED");

      // And the queued job is gone too.
      expect(await prisma.sendJob.count({ where: { followUpMessageId: messages[0]!.id, status: "QUEUED" } })).toBe(0);
    });

    it("treats a suppressed contact as ineligible", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "suppressed@example.test", "Europe/London");
      await prisma.suppression.create({
        data: {
          userId: user.id,
          emailNormalized: "suppressed@example.test",
          scope: "GLOBAL",
          reason: "UNSUBSCRIBE",
        },
      });
      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const result = await isEligibleForFollowUp(user.id, full, "campaign-1", 0);
      expect(result.eligible).toBe(false);
    });

    it("cancels every pending follow-up for a contact", async () => {
      const user = await createTestUser();
      const contact = await createTestContact(user.id, "stop@example.test", "Europe/London");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Bump",
          steps: { create: [{ order: 1, delayDays: 1, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      await prisma.followUpMessage.create({
        data: {
          userId: user.id,
          sequenceId: sequence.id,
          stepId: sequence.steps[0]!.id,
          contactId: contact.id,
          scheduledAt: new Date(),
        },
      });
      const cancelled = await cancelFollowUpsForContact(contact.id, "Replied.");
      expect(cancelled).toBe(1);
      const message = await prisma.followUpMessage.findFirst({ where: { contactId: contact.id } });
      expect(message!.status).toBe("CANCELLED");
      expect(message!.cancelReason).toBe("Replied.");
    });
  });

  // -------------------------------------------------------------------------
  describe("reply matching", () => {
    it("matches a reply to the contact and to the campaign we sent to them", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
      const contact = await createTestContact(user.id, "lead@example.test", "Europe/London");
      await createScheduledRecipient({
        campaignId: campaign.id,
        userId: user.id,
        contactId: contact.id,
        scheduledAt: new Date(),
      });
      // Mark the job as sent so it can be matched.
      const job = await prisma.sendJob.findFirst({ where: { campaignId: campaign.id } });
      await prisma.sendJob.update({ where: { id: job!.id }, data: { status: "SENT" } });

      const match = await matchReply(user.id, "LEAD@example.test");
      expect(match.contactId).toBe(contact.id);
      expect(match.campaignId).toBe(campaign.id);
    });

    it("returns no match for an unknown sender", async () => {
      const user = await createTestUser();
      const match = await matchReply(user.id, "stranger@example.test");
      expect(match.contactId).toBeNull();
      expect(match.campaignId).toBeNull();
    });

    it("stores the same provider message id only once", async () => {
      const user = await createTestUser();
      await createTestContact(user.id, "once@example.test", "Europe/London");
      const first = await recordReply({
        userId: user.id,
        provider: "gmail",
        messageId: "dup-1",
        fromEmail: "once@example.test",
        toEmail: "me@example.com",
        receivedAt: new Date(),
      });
      const second = await recordReply({
        userId: user.id,
        provider: "gmail",
        messageId: "dup-1",
        fromEmail: "once@example.test",
        toEmail: "me@example.com",
        receivedAt: new Date(),
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await prisma.reply.count({ where: { userId: user.id } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("follow-up scheduling details", () => {
    it("clamps the follow-up into the recipient's local sending window", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
      const contact = await createTestContact(user.id, "tokyo@example.test", "Asia/Tokyo");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Bump",
          steps: { create: [{ order: 1, delayDays: 0, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

      const result = await scheduleNextFollowUp({
        userId: user.id,
        campaign: fresh,
        contact: full,
        sequence,
        step: sequence.steps[0]!,
        from: new Date(),
        minDaysBetweenContacts: 0,
      });
      expect(result.scheduled).toBe(true);

      const message = await prisma.followUpMessage.findFirst({ where: { contactId: contact.id } });
      expect(message).toBeTruthy();
      // The scheduled instant must be inside 09:00-17:00 Tokyo time.
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Tokyo",
          hour: "2-digit",
          hour12: false,
        }).format(message!.scheduledAt),
      );
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(17);
    });

    it("refuses to schedule when the campaign is not active", async () => {
      const user = await createTestUser();
      const campaign = await createTestCampaign(user.id, { status: "PAUSED" });
      const contact = await createTestContact(user.id, "paused@example.test", "Europe/London");
      const sequence = await prisma.followUpSequence.create({
        data: {
          userId: user.id,
          name: "Bump",
          steps: { create: [{ order: 1, delayDays: 1, subject: "Bump", body: "<p>Hi</p>" }] },
        },
        include: { steps: true },
      });
      const full = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      const result = await scheduleNextFollowUp({
        userId: user.id,
        campaign: fresh,
        contact: full,
        sequence,
        step: sequence.steps[0]!,
        from: new Date(),
        minDaysBetweenContacts: 0,
      });
      expect(result.scheduled).toBe(false);
      expect(await prisma.followUpMessage.count({ where: { contactId: contact.id } })).toBe(0);
    });
  });
});
