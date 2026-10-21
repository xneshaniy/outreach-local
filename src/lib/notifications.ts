import { prisma } from "./db";
import { logger } from "./logger";

/**
 * In-app notifications.
 *
 * The worker and the API raise a notification when something needs the
 * operator's attention. Notifications are read/unread and the full history is
 * kept, so nothing is lost by not looking at the bell straight away.
 *
 * Creating a notification must never break the operation that raised it, so
 * every failure is logged and swallowed.
 */

export type NotificationType =
  | "REPLY"
  | "INTERESTED"
  | "CAMPAIGN_COMPLETED"
  | "CAMPAIGN_FAILED"
  | "PROVIDER_DISCONNECTED"
  | "QUEUE_FAILURE"
  | "IMPORT_COMPLETED"
  | "CONFIG_PROBLEM"
  | "TASK_DUE"
  | "DEAD_LETTER"
  | "SYSTEM";

export type NotifyInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

/** Raise a notification. Never throws. */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body?.slice(0, 2000) ?? null,
        link: input.link?.slice(0, 500) ?? null,
        entityType: input.entityType?.slice(0, 60) ?? null,
        entityId: input.entityId?.slice(0, 60) ?? null,
      },
    });
  } catch (err) {
    logger.warn("Could not create notification", {
      type: input.type,
      error: (err as Error).message,
    });
  }
}

/** Raise the same notification for every owner of the given workspace. */
export async function notifyWorkspaceUsers(
  userIds: string[],
  input: Omit<NotifyInput, "userId">,
): Promise<void> {
  for (const userId of userIds) {
    await notify({ ...input, userId });
  }
}

export async function listNotifications(
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<{ items: unknown[]; unread: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const where = { userId, ...(options.unreadOnly ? { isRead: false } : {}) };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { items, unread };
}

export async function markRead(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}
