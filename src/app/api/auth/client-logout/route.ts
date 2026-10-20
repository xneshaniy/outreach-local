import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { clearClientSessionCookie } from "@/lib/auth/client-session";

/**
 * POST /api/auth/client-logout — end the client-portal session.
 */
export const POST = handleApi(async (_req: NextRequest) => {
  assertSameOrigin(_req);
  await clearClientSessionCookie();
  return json({ ok: true });
});
