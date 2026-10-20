import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/unsubscribe/route";
import { prisma } from "@/lib/db";
import { claimDueJobs } from "@/lib/queue";
import { checkSuppression } from "@/lib/suppression";
import { signUnsubscribeToken } from "@/lib/template";
import {
  createScheduledRecipient,
  createTestCampaign,
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * Spec §9: the public unsubscribe endpoint must create a durable suppression
 * record, cancel outstanding work, and be idempotent + forgery-proof.
 */

function request(path: string, init: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { duplex: "half", ...init } as never);
}

describe.runIf(dbEnabled)("unsubscribe endpoint -> suppression", () => {
  beforeAll(preflight);
  beforeEach(resetDatabase);

  async function scenario() {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id, { status: "ACTIVE" });
    const contact = await createTestContact(user.id, "ada@example.test", "Europe/London");
    const { recipient, job } = await createScheduledRecipient({
      campaignId: campaign.id,
      userId: user.id,
      contactId: contact.id,
      scheduledAt: new Date(Date.now() + 60_000),
    });
    const token = signUnsubscribeToken({ c: contact.id, u: user.id, p: campaign.id });
    return { user, campaign, contact, recipient, job, token };
  }

  it("unsubscribes with a valid token: suppression, contact status and pending work", async () => {
    const { user, campaign, contact, recipient, job, token } = await scenario();

    const res = await POST(
      request("/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ token, reason: "Not interested" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alreadyUnsubscribed: boolean };
    expect(body).toEqual({ ok: true, alreadyUnsubscribed: false });

    // Durable GLOBAL suppression.
    const suppressions = await prisma.suppression.findMany({ where: { userId: user.id } });
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({
      scope: "GLOBAL",
      reason: "UNSUBSCRIBE",
      emailNormalized: "ada@example.test",
      source: "unsubscribe_endpoint",
    });

    // Contact status flips and outstanding work is cancelled immediately.
    const updated = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(updated?.status).toBe("UNSUBSCRIBED");
    const jobRow = await prisma.sendJob.findUnique({ where: { id: job.id } });
    expect(jobRow?.status).toBe("CANCELLED");
    const recipientRow = await prisma.campaignRecipient.findUnique({ where: { id: recipient.id } });
    expect(recipientRow?.status).toBe("CANCELLED");
    expect(recipientRow?.skipReason).toBe("UNSUBSCRIBED");

    // Audit event is recorded (token hash only — never the raw token).
    const events = await prisma.unsubscribeEvent.findMany({ where: { userId: user.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.emailNormalized).toBe("ada@example.test");
    expect(events[0]!.tokenHash).not.toBe(token);

    // And every later eligibility check says "suppressed".
    const check = await checkSuppression(user.id, "ada@example.test", campaign.id);
    expect(check.suppressed).toBe(true);
    expect(check.reason).toBe("GLOBAL_SUPPRESSION");

    // Cancelled work is not claimable any more.
    expect(await claimDueJobs("worker-1", 10)).toHaveLength(0);
  });

  it("is idempotent: a second unsubscribe creates no duplicate suppression", async () => {
    const { user, contact, token } = await scenario();
    const make = () =>
      request("/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

    const first = (await (await POST(make())).json()) as { alreadyUnsubscribed: boolean };
    const second = (await (await POST(make())).json()) as { alreadyUnsubscribed: boolean };

    expect(first.alreadyUnsubscribed).toBe(false);
    expect(second.alreadyUnsubscribed).toBe(true);
    expect(await prisma.suppression.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.contact.findUnique({ where: { id: contact.id } })).toMatchObject({
      status: "UNSUBSCRIBED",
    });
  });

  it("accepts RFC 8058 one-click POSTs from mail providers", async () => {
    const { user, token } = await scenario();
    const res = await POST(
      request("/api/unsubscribe", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "ExampleMail/1.0",
          "x-forwarded-for": "198.51.100.4",
        },
        body: new URLSearchParams({ token, "List-Unsubscribe": "One-Click" }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const suppression = await prisma.suppression.findFirst({ where: { userId: user.id } });
    expect(suppression).toMatchObject({ reason: "LIST_UNSUBSCRIBE" });
    const event = await prisma.unsubscribeEvent.findFirst({ where: { userId: user.id } });
    expect(event?.reason).toContain("One-Click");
  });

  it("rejects tampered and forged tokens without touching the database", async () => {
    const { user, contact, token } = await scenario();
    const [body, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ c: contact.id, u: user.id, p: "someone-elses-campaign" })).toString(
      "base64url",
    )}.${sig}`;
    expect(forged).not.toBe(token);

    for (const t of [forged, `${body}.AAAA${sig!.slice(4)}`, "garbage", ""]) {
      const res = await POST(
        request("/api/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: t }),
        }),
      );
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error?: { code?: string } };
      expect(payload.error?.code).toBe("INVALID_TOKEN");
    }

    expect(await prisma.suppression.count({ where: { userId: user.id } })).toBe(0);
    const unchanged = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(unchanged?.status).toBe("ACTIVE");
  });

  it("validates the link on GET before showing the confirmation page", async () => {
    const { token } = await scenario();

    const ok = await GET(
      request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, tokenValid: true });

    const bad = await GET(request("/api/unsubscribe?token=nope", { method: "GET" }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("text/html");
  });
});
