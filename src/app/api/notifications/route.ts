import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { listNotifications, markAllRead, markRead } from "@/lib/notifications";
import { z } from "zod";

/**
 * GET   /api/notifications — the notification list (newest first).
 * PATCH /api/notifications — mark one, several, or all as read.
 */
export const GET = handleApi(async (req: NextRequest) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const unreadOnly = url.searchParams.get("unread") === "true";
  const { items, unread } = await listNotifications(user.id, { limit, unreadOnly });
  return json({ items, unread });
});

const patchSchema = z.object({
  ids: z.array(z.string().cuid()).max(200).optional(),
  all: z.boolean().optional(),
});

export const PATCH = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = patchSchema.parse(await req.json());
  const marked = body.all ? await markAllRead(user.id) : await markRead(user.id, body.ids ?? []);
  const { unread } = await listNotifications(user.id, { limit: 1 });
  return json({ marked, unread });
});
