import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin, clientIp } from "@/lib/http";
import { clearSessionCookie } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/** POST /api/auth/logout — clears the session cookie (server-verifiable). */
export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await getCurrentUser();
  if (user) {
    await audit(prisma, {
      userId: user.id,
      action: "auth.logout",
      entityType: "User",
      entityId: user.id,
      ip: clientIp(req),
    });
  }
  await clearSessionCookie();
  return json({ ok: true });
});
