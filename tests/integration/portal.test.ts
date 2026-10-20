import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { campaignMetrics, dailySeries } from "@/lib/metrics";
import { buildDedupeKey, buildOpenPixelUrl, signTrackingToken } from "@/lib/tracking";
import { GET as openPixel } from "@/app/api/track/open/route";
import { GET as clickRedirect } from "@/app/api/track/click/route";
import {
  createTestCampaign,
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * The client session is read through next/headers, so the cookie jar is
 * mocked. Without a cookie the portal must refuse the request.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "eop_client_session" && clientCookie.value
        ? { name: "eop_client_session", value: clientCookie.value }
        : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const clientCookie = vi.hoisted(() => ({ value: null as string | null }));


/**
 * Spec: client portal access control and open/click tracking.
 *
 * The critical property: a client can only ever see the campaigns that were
 * explicitly assigned to it — never another client's, through any route.
 */

async function makeClient(userId: string, email: string) {
  return prisma.client.create({
    data: {
      userId,
      email,
      passwordHash: await hashPassword("Client-Password-123!"),
      name: email.split("@")[0]!,
      company: email.split("@")[1]!,
      isActive: true,
    },
  });
}

describe.runIf(dbEnabled)("client portal and tracking", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  // -------------------------------------------------------------------------
  describe("access control", () => {
    it("gives a client only the campaigns assigned to it", async () => {
      const owner = await createTestUser();
      const client = await makeClient(owner.id, "alpha@example.test");
      const other = await makeClient(owner.id, "beta@example.test");

      const mine = await createTestCampaign(owner.id, { name: "My campaign" });
      await createTestCampaign(owner.id, { name: "Their campaign" });

      await prisma.clientCampaignAccess.create({
        data: { clientId: client.id, campaignId: mine.id },
      });

      const { getClientCampaignIds } = await import("@/lib/auth/client-session");
      expect(await getClientCampaignIds(client.id)).toEqual([mine.id]);
      expect(await getClientCampaignIds(other.id)).toEqual([]);
    });

    it("does not let a client reach another client's campaign by id", async () => {
      const owner = await createTestUser();
      const client = await makeClient(owner.id, "alpha@example.test");
      const campaign = await createTestCampaign(owner.id, { name: "Not yours" });

      const { clientCanAccessCampaign } = await import("@/lib/auth/client-session");
      expect(await clientCanAccessCampaign(client.id, campaign.id)).toBe(false);
    });

    it("keeps clients of different workspaces separate", async () => {
      const ownerA = await createTestUser();
      const ownerB = await createTestUser();
      const clientA = await makeClient(ownerA.id, "a@example.test");
      const campaignB = await createTestCampaign(ownerB.id, { name: "B campaign" });

      const { clientCanAccessCampaign } = await import("@/lib/auth/client-session");
      // Even the campaign id is known, the client has no access.
      expect(await clientCanAccessCampaign(clientA.id, campaignB.id)).toBe(false);
    });

    it("refuses portal API calls without a client session", async () => {
      clientCookie.value = null;
      const { GET } = await import("@/app/api/portal/summary/route");
      const res = await GET(new NextRequest("http://localhost:3000/api/portal/summary"));
      expect(res.status).toBe(401);
    });

    it("lets a signed-in client read its own summary", async () => {
      const owner = await createTestUser();
      const client = await makeClient(owner.id, "alpha@example.test");
      const campaign = await createTestCampaign(owner.id, { name: "Mine" });
      await prisma.clientCampaignAccess.create({
        data: { clientId: client.id, campaignId: campaign.id },
      });

      const { createClientSessionToken } = await import("@/lib/auth/client-session");
      clientCookie.value = await createClientSessionToken({
        cid: client.id,
        uid: owner.id,
        email: client.email,
        sv: 0,
      });

      const { GET } = await import("@/app/api/portal/summary/route");
      const res = await GET(new NextRequest("http://localhost:3000/api/portal/summary"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { campaigns: number; client: { email: string } };
      expect(body.campaigns).toBe(1);
      expect(body.client.email).toBe(client.email);

      clientCookie.value = null;
    });

    it("does not let one client read another client's campaign report", async () => {
      const owner = await createTestUser();
      const clientA = await makeClient(owner.id, "alpha@example.test");
      const clientB = await makeClient(owner.id, "beta@example.test");
      const campaignB = await createTestCampaign(owner.id, { name: "B private campaign" });
      await prisma.clientCampaignAccess.create({
        data: { clientId: clientB.id, campaignId: campaignB.id },
      });

      const { createClientSessionToken } = await import("@/lib/auth/client-session");
      clientCookie.value = await createClientSessionToken({
        cid: clientA.id,
        uid: owner.id,
        email: clientA.email,
        sv: 0,
      });

      const { GET } = await import("@/app/api/portal/campaigns/[id]/route");
      const res = await GET(
        new NextRequest(`http://localhost:3000/api/portal/campaigns/${campaignB.id}`),
        { params: Promise.resolve({ id: campaignB.id }) },
      );
      // 404, not 403 — the client must not even learn the campaign exists.
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("B private campaign");

      clientCookie.value = null;
    });

    it("does not let one client export another client's report", async () => {
      const owner = await createTestUser();
      const clientA = await makeClient(owner.id, "alpha@example.test");
      const clientB = await makeClient(owner.id, "beta@example.test");
      const campaignB = await createTestCampaign(owner.id, { name: "Secret campaign" });
      await prisma.clientCampaignAccess.create({
        data: { clientId: clientB.id, campaignId: campaignB.id },
      });

      const { createClientSessionToken } = await import("@/lib/auth/client-session");
      clientCookie.value = await createClientSessionToken({
        cid: clientA.id,
        uid: owner.id,
        email: clientA.email,
        sv: 0,
      });

      const { GET } = await import("@/app/api/portal/reports/export/route");
      const res = await GET(new NextRequest("http://localhost:3000/api/portal/reports/export"));
      expect(res.status).toBe(200);
      const csv = await res.text();
      expect(csv).not.toContain("Secret campaign");

      clientCookie.value = null;
    });
  });

  // -------------------------------------------------------------------------
  describe("open tracking", () => {
    it("records an open against the right campaign and recipient", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "opener@example.test", "Europe/London");
      await prisma.campaign.update({ where: { id: campaign.id }, data: { trackingEnabled: true } });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const url = buildOpenPixelUrl(campaign.id, contact.id);
      const token = url.split("t=")[1]!;
      const res = await openPixel(
        new NextRequest(`http://localhost:3000/api/track/open?t=${encodeURIComponent(token)}`, {
          headers: { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15" },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/gif");

      const events = await prisma.trackingEvent.findMany({ where: { campaignId: campaign.id } });
      expect(events).toHaveLength(1);
      expect(events[0]!.contactId).toBe(contact.id);
      expect(events[0]!.type).toBe("OPEN");
      expect(events[0]!.source).toBe("HUMAN");
    });

    it("deduplicates repeated opens but keeps the total", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "opener@example.test", "Europe/London");
      await prisma.campaign.update({ where: { id: campaign.id }, data: { trackingEnabled: true } });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const token = buildOpenPixelUrl(campaign.id, contact.id).split("t=")[1]!;
      for (let i = 0; i < 3; i++) {
        await openPixel(
          new NextRequest(`http://localhost:3000/api/track/open?t=${encodeURIComponent(token)}`, {
            headers: { "user-agent": "Mozilla/5.0 Safari" },
          }),
        );
      }

      const events = await prisma.trackingEvent.findMany({ where: { campaignId: campaign.id } });
      expect(events).toHaveLength(3); // every open is recorded
      // ...but only ONE carries the dedupe key.
      expect(events.filter((e) => e.dedupeKey !== null)).toHaveLength(1);

      const metrics = await campaignMetrics(campaign.id);
      expect(metrics.totalOpens).toBe(3);
      expect(metrics.uniqueOpens).toBe(1);
    });

    it("does not count a bot open as a unique open", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "scanner@example.test", "Europe/London");
      await prisma.campaign.update({ where: { id: campaign.id }, data: { trackingEnabled: true } });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const token = buildOpenPixelUrl(campaign.id, contact.id).split("t=")[1]!;
      await openPixel(
        new NextRequest(`http://localhost:3000/api/track/open?t=${encodeURIComponent(token)}`, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
        }),
      );

      const metrics = await campaignMetrics(campaign.id);
      expect(metrics.totalOpens).toBe(1); // the raw event is kept
      expect(metrics.uniqueOpens).toBe(0); // but it is not a human open
    });

    it("ignores a forged pixel token", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      await prisma.campaign.update({ where: { id: campaign.id }, data: { trackingEnabled: true } });

      const res = await openPixel(
        new NextRequest("http://localhost:3000/api/track/open?t=forged.signature", {
          headers: { "user-agent": "Mozilla/5.0" },
        }),
      );
      // The pixel is always a valid image, but nothing was recorded.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/gif");
      expect(await prisma.trackingEvent.count()).toBe(0);
    });

    it("ignores a pixel for a campaign that has tracking off", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "x@example.test", "Europe/London");
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const token = buildOpenPixelUrl(campaign.id, contact.id).split("t=")[1]!;
      await openPixel(
        new NextRequest(`http://localhost:3000/api/track/open?t=${encodeURIComponent(token)}`),
      );
      expect(await prisma.trackingEvent.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("click tracking", () => {
    it("records a click and redirects to the target", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "clicker@example.test", "Europe/London");
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { clickTrackingEnabled: true, trackingEnabled: true },
      });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const token = signTrackingToken("click", [campaign.id, contact.id, "https://example.com/offer"]);
      const res = await clickRedirect(
        new NextRequest(`http://localhost:3000/api/track/click?t=${encodeURIComponent(token)}`, {
          headers: { "user-agent": "Mozilla/5.0 Safari" },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com/offer");

      const events = await prisma.trackingEvent.findMany({ where: { campaignId: campaign.id } });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("CLICK");
      expect(events[0]!.url).toBe("https://example.com/offer");
    });

    it("deduplicates repeated clicks to the same link", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "clicker@example.test", "Europe/London");
      await prisma.campaign.update({ where: { id: campaign.id }, data: { clickTrackingEnabled: true } });
      await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SCHEDULED", scheduledAt: new Date() },
      });

      const token = signTrackingToken("click", [campaign.id, contact.id, "https://example.com/offer"]);
      for (let i = 0; i < 4; i++) {
        await clickRedirect(
          new NextRequest(`http://localhost:3000/api/track/click?t=${encodeURIComponent(token)}`, {
            headers: { "user-agent": "Mozilla/5.0 Safari" },
          }),
        );
      }

      const metrics = await campaignMetrics(campaign.id);
      expect(metrics.totalClicks).toBe(4);
      expect(metrics.uniqueClicks).toBe(1);
    });

    it("refuses to redirect to a non-http target", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "clicker@example.test", "Europe/London");
      await prisma.campaign.update({ where: { id: campaign.id }, data: { clickTrackingEnabled: true } });

      const token = signTrackingToken("click", [campaign.id, contact.id, "javascript:alert(1)"]);
      const res = await clickRedirect(
        new NextRequest(`http://localhost:3000/api/track/click?t=${encodeURIComponent(token)}`),
      );
      expect(res.status).toBe(400);
      expect(await prisma.trackingEvent.count()).toBe(0);
    });

    it("rejects a forged click token", async () => {
      const res = await clickRedirect(
        new NextRequest("http://localhost:3000/api/track/click?t=forged.signature"),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("metrics", () => {
    it("computes the rates from real rows and labels the denominator", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contacts = [];
      for (let i = 0; i < 4; i++) {
        contacts.push(await createTestContact(owner.id, `m${i}@example.test`, "Europe/London"));
      }
      for (const c of contacts) {
        const recipient = await prisma.campaignRecipient.create({
          data: { campaignId: campaign.id, contactId: c.id, status: "SENT", sentAt: new Date(), scheduledAt: new Date() },
          select: { id: true },
        });
        await prisma.sendJob.create({
          data: {
            campaignRecipientId: recipient.id,
            campaignId: campaign.id,
            contactId: c.id,
            userId: owner.id,
            status: "SENT",
            scheduledAt: new Date(),
            idempotencyKey: `job:${recipient.id}`,
            providerMessageId: `msg-${c.id}`,
          },
        });
      }

      // Two of the four open the message.
      for (const c of contacts.slice(0, 2)) {
        await prisma.trackingEvent.create({
          data: {
            campaignId: campaign.id,
            contactId: c.id,
            type: "OPEN",
            source: "HUMAN",
            dedupeKey: buildDedupeKey("OPEN", campaign.id, c.id),
          },
        });
      }
      // One replies.
      await prisma.reply.create({
        data: {
          userId: owner.id,
          campaignId: campaign.id,
          contactId: contacts[0]!.id,
          provider: "gmail",
          messageId: "r1",
          fromEmail: contacts[0]!.email,
          toEmail: "me@example.test",
          receivedAt: new Date(),
        },
      });

      const m = await campaignMetrics(campaign.id);
      expect(m.sent).toBe(4);
      expect(m.uniqueOpens).toBe(2);
      expect(m.openRate).toBe(50); // 2 of 4 sent
      expect(m.openRateDenominator).toBe("sent");
      expect(m.replies).toBe(1);
      expect(m.replyRate).toBe(25);
      // Delivery was never confirmed -> reported as unavailable, never guessed.
      expect(m.delivered).toBeNull();
    });

    it("reports delivery only when the provider confirmed it", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "d@example.test", "Europe/London");
      const recipient = await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SENT", sentAt: new Date(), scheduledAt: new Date() },
        select: { id: true },
      });
      await prisma.sendJob.create({
        data: {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          contactId: contact.id,
          userId: owner.id,
          status: "SENT",
          scheduledAt: new Date(),
          idempotencyKey: `job:${recipient.id}`,
          deliveredAt: new Date(),
        },
      });

      const m = await campaignMetrics(campaign.id);
      expect(m.delivered).toBe(1);
      expect(m.openRateDenominator).toBe("delivered");
    });

    it("produces a daily series", async () => {
      const owner = await createTestUser();
      const campaign = await createTestCampaign(owner.id, { status: "ACTIVE" });
      const contact = await createTestContact(owner.id, "s@example.test", "Europe/London");
      const recipient = await prisma.campaignRecipient.create({
        data: { campaignId: campaign.id, contactId: contact.id, status: "SENT", sentAt: new Date(), scheduledAt: new Date() },
        select: { id: true },
      });
      await prisma.sendJob.create({
        data: {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          contactId: contact.id,
          userId: owner.id,
          status: "SENT",
          scheduledAt: new Date(),
          updatedAt: new Date(),
          idempotencyKey: `job:${recipient.id}`,
        },
      });

      const series = await dailySeries(campaign.id);
      expect(series.length).toBeGreaterThan(0);
      expect(series[0]!.sent).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("client accounts", () => {
    it("stores a hashed password, never the plain one", async () => {
      const owner = await createTestUser();
      const client = await makeClient(owner.id, "hash@example.test");
      expect(client.passwordHash).not.toBe("Client-Password-123!");
      expect(client.passwordHash.startsWith("$2")).toBe(true);
    });

    it("refuses to sign in with a wrong password", async () => {
      const owner = await createTestUser();
      await makeClient(owner.id, "login@example.test");
      const { verifyPassword } = await import("@/lib/auth/password");
      const client = await prisma.client.findUniqueOrThrow({ where: { email: "login@example.test" } });
      expect(await verifyPassword("Client-Password-123!", client.passwordHash)).toBe(true);
      expect(await verifyPassword("wrong-password", client.passwordHash)).toBe(false);
    });
  });
});
