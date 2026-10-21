import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import {
  buildDedupeKey,
  classifyTrackingRequest,
  TRACKING_PIXEL_GIF,
  verifyTrackingToken,
} from "@/lib/tracking";

/**
 * GET /api/track/open?t=<token> — the 1x1 tracking pixel.
 *
 * Public (email clients are not logged in). The token is signed, so a forged
 * or guessed token is rejected and no event is recorded.
 *
 * The response is a 1x1 transparent GIF. It is ALWAYS a valid image, even when
 * the event could not be recorded — a broken image in someone's inbox is
 * worse than a missed statistic.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const parts = verifyTrackingToken("open", token);

  if (!parts || parts.length !== 2) {
    return pixelResponse();
  }

  const [campaignId, contactId] = parts as [string, string];

  try {
    // Only count an open for a campaign that actually has tracking on and a
    // recipient that really belongs to it.
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, trackingEnabled: true },
      select: { id: true, userId: true },
    });
    if (!campaign) return pixelResponse();

    const recipient = await prisma.campaignRecipient.findFirst({
      where: { campaignId, contactId },
      select: { id: true },
    });
    if (!recipient) return pixelResponse();

    const source = classifyTrackingRequest({
      userAgent: req.headers.get("user-agent"),
      ipAddress: clientIp(req),
    });

    // The dedupe key is only set on the FIRST event of its kind, so repeated
    // opens are still counted in the total but do not inflate the unique
    // count. A unique-index conflict simply means "already counted".
    const dedupeKey = buildDedupeKey("OPEN", campaignId, contactId);
    let firstOpen = false;
    try {
      await prisma.trackingEvent.create({
        data: {
          campaignId,
          contactId,
          type: "OPEN",
          source,
          dedupeKey,
          userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
          ipAddress: clientIp(req),
        },
      });
      firstOpen = true;
    } catch (err) {
      if ((err as { code?: string })?.code !== "P2002") {
        logger.warn("Could not record an open event", { error: (err as Error).message });
      }
      // P2002 = this recipient already has an open recorded -> record the
      // repeat without the dedupe key so the total stays accurate.
      if ((err as { code?: string })?.code === "P2002") {
        await prisma.trackingEvent
          .create({
            data: {
              campaignId,
              contactId,
              type: "OPEN",
              source,
              dedupeKey: null,
              userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
              ipAddress: clientIp(req),
            },
          })
          .catch(() => undefined);
      }
    }
    // The timeline records the FIRST open of a message (and only a
    // human one - a scanner fetch is not an engagement).
    if (firstOpen && source !== "BOT") {
      const { recordActivity } = await import("@/lib/activity");
      await recordActivity({
        userId: campaign.userId,
        contactId,
        type: "EMAIL_OPENED",
        summary: "Opened the email",
        detail: { campaignId, source },
      });
    }
  } catch (err) {
    logger.warn("Tracking pixel failed", { error: (err as Error).message });
  }

  return pixelResponse();
}

function pixelResponse(): NextResponse {
  return new NextResponse(TRACKING_PIXEL_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRACKING_PIXEL_GIF.length),
      // Never cached: a cached pixel would not be counted at all.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
