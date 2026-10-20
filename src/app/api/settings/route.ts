import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { z } from "zod";
import { audit } from "@/lib/audit";

/** POST /api/settings — workspace-level user preferences (name, contact frequency). */
const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  minDaysBetweenContacts: z.number().int().min(0).max(60).optional(),
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = schema.parse(await req.json());

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.minDaysBetweenContacts !== undefined ? { minDaysBetweenContacts: body.minDaysBetweenContacts } : {}),
    },
    select: { id: true, email: true, name: true, role: true, minDaysBetweenContacts: true },
  });

  await audit(prisma, {
    userId: user.id,
    action: "settings.update",
    entityType: "User",
    entityId: user.id,
    metadata: { minDaysBetweenContacts: body.minDaysBetweenContacts },
  });

  return json({ user: updated });
});
