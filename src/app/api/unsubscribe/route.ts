import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyUnsubscribeToken, hashToken } from "@/lib/template";
import { addSuppression } from "@/lib/suppression";
import { enforceRateLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";

/**
 * Public unsubscribe endpoint (no session).
 *
 * GET  /api/unsubscribe?token=...           -> confirmation page (or JSON)
 * POST /api/unsubscribe { token, reason }   -> performs the unsubscribe
 * POST with body "List-Unsubscribe=One-Click" (RFC 8058) is also accepted.
 *
 * The token is a stateless HMAC signature over {contactId, userId, campaignId?}.
 * Processing is IDEMPOTENT: repeat calls are no-ops (unique suppression rows).
 */

function htmlPage(message: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
     <style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1020;color:#e6e9f0}
     .card{max-width:26rem;padding:2rem;border-radius:1rem;background:#141b34;border:1px solid #26304f;text-align:center}
     a{color:#7aa2ff}</style></head>
     <body><div class="card"><h1>${message.includes("been unsubscribed") ? "You're unsubscribed" : "Unsubscribe"}</h1><p>${message}</p></div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const payload = verifyUnsubscribeToken(token);
  if (!payload) return htmlPage("This unsubscribe link is invalid or expired.", 400);
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  if (wantsJson) {
    return NextResponse.json({ ok: true, tokenValid: true }, { headers: { "Cache-Control": "no-store" } });
  }
  return htmlPage("Click the button below to stop receiving further emails from us.", 200);
}

export async function POST(req: NextRequest) {
  await enforceRateLimit(`rl:unsubscribe:${clientIp(req)}`, 30, 60).catch(() => undefined);

  let token = "";
  let reason: string | undefined;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    token = String(body.token ?? "");
    reason = body.reason ? String(body.reason).slice(0, 500) : undefined;
  } else {
    // RFC 8058 one-click: application/x-www-form-urlencoded
    const form = await req.formData().catch(() => null);
    token = String(form?.get("token") ?? new URL(req.url).searchParams.get("token") ?? "");
    const oneClick = form?.get("List-Unsubscribe");
    if (oneClick === "One-Click") reason = "One-Click (RFC 8058)";
  }

  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return NextResponse.json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token." } }, { status: 400 });
  }

  const { c: contactId, u: userId, p: campaignId } = payload;

  try {
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, userId },
    });
    if (!contact) {
      // Token valid but contact removed — still record the event.
      return NextResponse.json({ ok: true, alreadyUnsubscribed: true });
    }

    const already = contact.status === "UNSUBSCRIBED";

    await prisma.$transaction(async (tx) => {
      await addSuppression({
        userId,
        emailNormalized: contact.emailNormalized,
        scope: "GLOBAL",
        reason: reason?.includes("One-Click") ? "LIST_UNSUBSCRIBE" : "UNSUBSCRIBE",
        source: "unsubscribe_endpoint",
        tx,
      });

      await tx.contact.update({
        where: { id: contact.id },
        data: { status: "UNSUBSCRIBED" },
      });

      // Any queued/scheduled work for this contact is cancelled immediately.
      await tx.sendJob.updateMany({
        where: { userId, contactId: contact.id, status: { in: ["QUEUED", "AMBIGUOUS"] } },
        data: { status: "CANCELLED" },
      });
      await tx.campaignRecipient.updateMany({
        where: { campaignId: campaignId ?? undefined, contactId: contact.id, status: { notIn: ["SENT"] } },
        data: { status: "CANCELLED", skipReason: "UNSUBSCRIBED" },
      });

      await tx.unsubscribeEvent.create({
        data: {
          userId,
          campaignId: campaignId ?? null,
          contactId: contact.id,
          emailNormalized: contact.emailNormalized,
          tokenHash: hashToken(token),
          reason: reason ?? null,
          ipAddress: clientIp(req),
          userAgent: req.headers.get("user-agent"),
        },
      });
    });

    await audit(prisma, {
      userId,
      action: "contact.unsubscribe",
      entityType: "Contact",
      entityId: contact.id,
      metadata: { campaignId: campaignId ?? null, reason },
    });

    const wantsJson = contentType.includes("application/json");
    if (wantsJson) return NextResponse.json({ ok: true, alreadyUnsubscribed: already });
    return htmlPage("You have been unsubscribed. You will not receive further emails from us.");
  } catch (err) {
    logger.error("Unsubscribe failed", { error: (err as Error).message });
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not process unsubscribe." } },
      { status: 500 },
    );
  }
}
