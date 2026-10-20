import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import { buildDedupeKey, classifyTrackingRequest, verifyTrackingToken } from "@/lib/tracking";

/**
 * GET /api/track/click?t=<token> — tracked link redirect.
 *
 * Public (the recipient is not logged in). The token is signed and binds the
 * campaign, the recipient and the target URL, so a third party cannot forge a
 * click or redirect a visitor somewhere else.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const parts = verifyTrackingToken("click", token);

  if (!parts || parts.length !== 3) {
    return NextResponse.json({ error: { code: "INVALID_TOKEN", message: "Invalid tracking link." } }, { status: 400 });
  }

  const [campaignId, contactId, targetUrl] = parts as [string, string, string];

  // Only follow http(s) targets — never javascript:, data: or file: URLs.
  let destination: URL;
  try {
    destination = new URL(targetUrl);
    if (destination.protocol !== "http:" && destination.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return NextResponse.json({ error: { code: "INVALID_TARGET", message: "Invalid target URL." } }, { status: 400 });
  }

  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, clickTrackingEnabled: true },
      select: { id: true },
    });
    if (!campaign) {
      // Tracking was turned off after the email went out — still redirect, but
      // do not record anything.
      return redirect(destination);
    }

    const recipient = await prisma.campaignRecipient.findFirst({
      where: { campaignId, contactId },
      select: { id: true },
    });
    if (!recipient) return redirect(destination);

    const source = classifyTrackingRequest({
      userAgent: req.headers.get("user-agent"),
      ipAddress: clientIp(req),
    });

    const dedupeKey = buildDedupeKey("CLICK", campaignId, contactId, targetUrl);
    try {
      await prisma.trackingEvent.create({
        data: {
          campaignId,
          contactId,
          type: "CLICK",
          source,
          url: targetUrl,
          dedupeKey,
          userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
          ipAddress: clientIp(req),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        // Already counted as a unique click — record the repeat without the
        // dedupe key so the total stays accurate.
        await prisma.trackingEvent
          .create({
            data: {
              campaignId,
              contactId,
              type: "CLICK",
              source,
              url: targetUrl,
              dedupeKey: null,
              userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
              ipAddress: clientIp(req),
            },
          })
          .catch(() => undefined);
      } else {
        logger.warn("Could not record a click event", { error: (err as Error).message });
      }
    }
  } catch (err) {
    logger.warn("Tracked link failed", { error: (err as Error).message });
  }

  return redirect(destination);
}

function redirect(destination: URL): NextResponse {
  return NextResponse.redirect(destination.toString(), {
    status: 302,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
