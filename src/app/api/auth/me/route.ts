import { handleApi, json } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/** GET /api/auth/me — current session user + workspace summary. */
export const GET = handleApi(async () => {
  const user = await getCurrentUser();
  if (!user) throw ApiError.unauthorized();

  const [senders, campaigns, contacts] = await Promise.all([
    prisma.senderAccount.count({ where: { userId: user.id } }),
    prisma.campaign.count({ where: { userId: user.id } }),
    prisma.contact.count({ where: { userId: user.id } }),
  ]);

  return json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      minDaysBetweenContacts: user.minDaysBetweenContacts,
    },
    counts: { senders, campaigns, contacts },
  });
});
