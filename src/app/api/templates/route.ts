import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { templateSchema } from "@/lib/validation";
import { audit } from "@/lib/audit";

/** GET /api/templates — list; POST /api/templates — create. */
export const GET = handleApi(async () => {
  const user = await requireUser();
  const templates = await prisma.emailTemplate.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
  });
  return json({ templates });
});

export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = templateSchema.parse(await req.json());

  const template = await prisma.emailTemplate.create({
    data: {
      userId: user.id,
      name: body.name,
      subject: body.subject,
      body: body.body,
      description: body.description ?? null,
    },
  });

  await audit(prisma, {
    userId: user.id,
    action: "template.create",
    entityType: "EmailTemplate",
    entityId: template.id,
  });

  return json({ template }, { status: 201 });
});
