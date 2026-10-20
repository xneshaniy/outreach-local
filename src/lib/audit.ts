import type { Prisma } from "@prisma/client";
import type { PrismaClientWithRetry, TxLike } from "./db";

/**
 * Append-only audit trail for security-relevant actions.
 * Never records message bodies, tokens, or passwords.
 */
export type AuditInput = {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

type DbLike = TxLike | PrismaClientWithRetry;

export async function audit(db: DbLike, input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        // Prisma Json field: pass through as input object.
        metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });
  }catch {
    // Auditing must never break the primary flow; failures are visible via
    // database monitoring / logs of the caller.
  }
}
