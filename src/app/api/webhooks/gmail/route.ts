import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { addSuppression } from "@/lib/suppression";
import { normalizeEmail } from "@/lib/email-normalize";
import { audit } from "@/lib/audit";

/**
 * POST /api/webhooks/gmail
 *
 * Gmail Pub/Sub push notifications (mailing history) and ESP-style bounce /
 * complaint payloads are accepted here.
 *
 * Security:
 *  - When configured, the Authorization header must carry a Google-issued
 *    OIDC JWT whose audience is our OAuth client id (signature verified by
 *    Google's JWKS). Invalid signatures are rejected and recorded.
 *  - Every event is stored with its provider event id (UNIQUE per provider),
 *    so duplicate deliveries are idempotent no-ops.
 *
 * Bounce/complaint events add GLOBAL suppressions — unsubscribed/bounced
 * recipients are never emailed again (spec §9).
 */

type GmailPushPayload = {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
};

type EspEventPayload = {
  eventType?: "BOUNCE" | "HARD_BOUNCE" | "COMPLAINT" | "DELIVERY";
  email?: string;
  eventId?: string;
  recipient?: string;
};

async function verifyGooglePush(req: NextRequest): Promise<{ ok: boolean; email?: string }> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false };
  const token = authHeader.slice(7);
  if (!env.googleConfigured) {
    // No OAuth configured → cannot verify; reject in production, allow in dev.
    return { ok: !env.isProd };
  }
  try {
    const ticket = await new google.auth.OAuth2(env.googleClientId, env.googleClientSecret).verifyIdToken({
      idToken: token,
      audience: env.googleClientId,
    });
    const payload = ticket.getPayload();
    return { ok: Boolean(payload?.email_verified ?? payload?.sub), email: payload?.email };
  } catch (err) {
    logger.warn("Webhook signature verification failed", { error: (err as Error).message });
    return { ok: false };
  }
}

export async function POST(req: NextRequest) {
  const verified = await verifyGooglePush(req);
  const body = await req.json().catch(() => ({}));

  if (!verified.ok) {
    logger.warn("Rejected webhook: invalid signature");
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE" } }, { status: 401 });
  }

  // --- Gmail Pub/Sub push: decode the inner notification --------------------
  const push = body as GmailPushPayload;
  if (push.message?.data) {
    const decoded = Buffer.from(push.message.data, "base64").toString("utf8");
    let inner: { emailAddress?: string; historyId?: string } = {};
    try {
      inner = JSON.parse(decoded);
    } catch {
      inner = {};
    }
    const externalId = push.message.messageId ?? `gmail-${inner.historyId ?? Date.now()}`;

    const ownerUserId = await resolveUserIdForAddress(inner.emailAddress);
    if (!ownerUserId) return NextResponse.json({ ok: true, ignored: "unknown_recipient" });

    // Store idempotently. Gmail push is mailbox-level: it signals that
    // something changed (e.g. a bounce reply arrived), not the event type
    // itself. We record it for the processing pipeline and surface it in the
    // audit log; operators can then review the mailbox or configure a more
    // specific ESP webhook below.
    try {
      await prisma.webhookEvent.create({
        data: {
          userId: ownerUserId,
          provider: "gmail",
          externalId,
          eventType: "GMAIL_HISTORY",
          status: "RECEIVED",
          payload: { historyId: inner.historyId, emailAddress: inner.emailAddress } as never,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") throw err; // duplicate -> idempotent
    }
    return NextResponse.json({ ok: true });
  }

  // --- ESP-style bounce / complaint event -----------------------------------
  const esp = body as EspEventPayload;
  if (esp.eventType && (esp.email || esp.recipient)) {
    const email = normalizeEmail(esp.email ?? esp.recipient ?? "");
    const userId = await resolveUserIdForAddress(email);
    if (!userId) return NextResponse.json({ ok: true, ignored: "unknown_recipient" });

    const externalId = esp.eventId ?? `${esp.eventType}:${email}`;
    try {
      await prisma.webhookEvent.create({
        data: {
          userId,
          provider: "esp",
          externalId,
          eventType: esp.eventType,
          status: "PROCESSED",
          payload: esp as never,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") return NextResponse.json({ ok: true, duplicate: true });
      throw err;
    }

    if (esp.eventType === "BOUNCE" || esp.eventType === "HARD_BOUNCE" || esp.eventType === "COMPLAINT") {
      await addSuppression({
        userId,
        emailNormalized: email,
        scope: "GLOBAL",
        reason: esp.eventType === "COMPLAINT" ? "COMPLAINT" : esp.eventType === "HARD_BOUNCE" ? "HARD_BOUNCE" : "BOUNCE",
        source: "webhook",
      });
      await prisma.contact.updateMany({
        where: { userId, emailNormalized: email },
        data: { status: esp.eventType === "COMPLAINT" ? "COMPLAINED" : "BOUNCED" },
      });
      await prisma.sendJob.updateMany({
        where: { userId, contact: { emailNormalized: email }, status: { in: ["QUEUED"] } },
        data: { status: "CANCELLED" },
      });
      await audit(prisma, {
        userId,
        action: `webhook.${esp.eventType.toLowerCase()}`,
        entityType: "Contact",
        metadata: { email, eventType: esp.eventType },
      });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: "unrecognized_payload" });
}

/** Resolve which workspace owns a contact address (for push payloads). */
async function resolveUserIdForAddress(email?: string): Promise<string | null> {
  if (!email) return null;
  const normalized = normalizeEmail(email);
  const contact = await prisma.contact.findFirst({ where: { emailNormalized: normalized } });
  return contact?.userId ?? null;
}
