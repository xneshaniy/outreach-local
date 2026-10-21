import { Prisma, type Contact } from "@prisma/client";
import { prisma } from "./db";

/**
 * Saved audience segments.
 *
 * A segment is a stored filter over the contact list. It is applied when a
 * campaign is created, so the same audience can be reused without
 * re-selecting it by hand every time.
 *
 * The filters are stored as JSON and turned into a Prisma `where` clause by
 * `segmentWhere`, which is the only place that reads them - so a malformed
 * filter can never become an arbitrary query.
 */

export type SegmentFilters = {
  status?: string[];
  source?: string[];
  tags?: string[];
  stageId?: string[];
  priority?: string[];
  industry?: string[];
  /** Only contacts with a known time zone. */
  hasTimeZone?: boolean;
  /** Only contacts that have consented. */
  consentedOnly?: boolean;
  /** Only contacts that have never been sent anything. */
  neverSent?: boolean;
  /** Free-text search. */
  search?: string;
};

export const SEGMENT_FILTER_KEYS: Array<keyof SegmentFilters> = [
  "status",
  "source",
  "tags",
  "stageId",
  "priority",
  "industry",
  "hasTimeZone",
  "consentedOnly",
  "neverSent",
  "search",
];

/** Validate the stored filters. */
export function parseSegmentFilters(raw: unknown): SegmentFilters {
  const out: SegmentFilters = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;

  out.status = list(r.status);
  out.source = list(r.source);
  out.tags = list(r.tags);
  out.stageId = list(r.stageId);
  out.priority = list(r.priority);
  out.industry = list(r.industry);
  if (typeof r.hasTimeZone === "boolean") out.hasTimeZone = r.hasTimeZone;
  if (typeof r.consentedOnly === "boolean") out.consentedOnly = r.consentedOnly;
  if (typeof r.neverSent === "boolean") out.neverSent = r.neverSent;
  if (typeof r.search === "string" && r.search.trim()) out.search = r.search.trim().slice(0, 200);
  return out;
}

/** Turn the stored filters into a Prisma where clause. */
export function segmentWhere(userId: string, filters: SegmentFilters): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { userId, isArchived: false };
  const and: Prisma.ContactWhereInput[] = [];

  if (filters.status?.length) where.status = { in: filters.status as Contact["status"][] };
  if (filters.source?.length) where.source = { in: filters.source };
  if (filters.stageId?.length) where.stageId = { in: filters.stageId };
  if (filters.priority?.length) where.priority = { in: filters.priority as never };
  if (filters.industry?.length) where.industry = { in: filters.industry };
  if (filters.tags?.length) {
    // A contact must carry EVERY requested tag.
    for (const tag of filters.tags) and.push({ tags: { has: tag } });
  }
  if (filters.hasTimeZone === true) and.push({ timeZone: { not: null } });
  if (filters.hasTimeZone === false) and.push({ timeZone: null });
  if (filters.consentedOnly === true) and.push({ consentAt: { not: null } });
  if (filters.neverSent === true) and.push({ sentCount: 0 });
  if (filters.search) {
    and.push({
      OR: [
        { email: { contains: filters.search, mode: "insensitive" } },
        { firstName: { contains: filters.search, mode: "insensitive" } },
        { lastName: { contains: filters.search, mode: "insensitive" } },
        { company: { contains: filters.search, mode: "insensitive" } },
      ],
    });
  }
  if (and.length > 0) where.AND = and;
  return where;
}

/** The contacts a segment selects. */
export async function segmentContacts(
  userId: string,
  filters: SegmentFilters,
  take = 500,
): Promise<Contact[]> {
  return prisma.contact.findMany({
    where: segmentWhere(userId, filters),
    orderBy: { createdAt: "desc" },
    take,
  });
}

/** How many contacts a segment selects. */
export async function segmentCount(userId: string, filters: SegmentFilters): Promise<number> {
  return prisma.contact.count({ where: segmentWhere(userId, filters) });
}
