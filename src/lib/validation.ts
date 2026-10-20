import { z } from "zod";
import { CONTACT_FIELDS } from "./csv";
import { normalizeTimeZone } from "./email-normalize";
import { sendingWindowSchema } from "./scheduling";

/**
 * Zod validation for every API input. Nothing reaches Prisma unvalidated.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const registerSchema = z.object({
  email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Pagination / common
// ---------------------------------------------------------------------------
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
const campaignBody = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(200_000),
  templateId: z.string().cuid().nullish(),
  serviceId: z.string().cuid().nullish(),
  followUpSequenceId: z.string().cuid().nullish(),
  fromName: z.string().max(200).nullish(),
  replyTo: z.string().email().max(320).nullish(),
  windowStartMinute: z.number().int().min(0).max(1439).default(540),
  windowEndMinute: z.number().int().min(1).max(1440).default(1020),
  sendingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  timeZoneFallback: z.enum(["HOLD", "FALLBACK"]).default("HOLD"),
  fallbackTimeZone: z
    .string()
    .max(100)
    .optional()
    .transform((tz) => (tz && tz.trim() ? normalizeTimeZone(tz) : null)),
  dailyLimit: z.number().int().min(1).max(100_000).nullish(),
  startAt: z.coerce.date().nullish(),
  endAt: z.coerce.date().nullish(),
  requiresApproval: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  // Opt-in tracking. Both default to OFF so nothing is tracked silently.
  trackingEnabled: z.boolean().default(false),
  clickTrackingEnabled: z.boolean().default(false),
});

export const campaignCreateSchema = campaignBody.superRefine((v, ctx) => {
  const check = sendingWindowSchema.safeParse({
    startMinute: v.windowStartMinute,
    endMinute: v.windowEndMinute,
    days: v.sendingDays,
  });
  if (!check.success) {
    for (const issue of check.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  }
  if (v.timeZoneFallback === "FALLBACK" && !v.fallbackTimeZone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fallbackTimeZone"],
      message: "A fallback IANA time zone is required when fallback mode is FALLBACK.",
    });
  }
});

export const campaignUpdateSchema = campaignBody.partial();

export const scheduleSchema = z
  .object({
    windowStartMinute: z.number().int().min(0).max(1439),
    windowEndMinute: z.number().int().min(1).max(1440),
    sendingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .superRefine((v, ctx) => {
    if (v.windowEndMinute <= v.windowStartMinute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEndMinute"],
        message: "End of the window must be after its start.",
      });
    }
  });

// ---------------------------------------------------------------------------
// Contacts & import
// ---------------------------------------------------------------------------

export const contactCreateSchema = z.object({
  email: z.string().email().max(320),
  firstName: z.string().max(200).nullish(),
  lastName: z.string().max(200).nullish(),
  company: z.string().max(300).nullish(),
  website: z.string().max(500).nullish(),
  title: z.string().max(200).nullish(),
  timeZone: z
    .string()
    .max(100)
    .nullish()
    .transform((tz) => (tz ? normalizeTimeZone(tz) : null)),
  country: z.string().max(100).nullish(),
  source: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
  tags: z.array(z.string().min(1).max(60)).max(50).nullish(),
  consentAt: z.coerce.date().nullish(),
  consentSource: z.string().max(200).nullish(),
});

export const contactUpdateSchema = contactCreateSchema.partial().omit({ email: true });

export const importMappingSchema = z.object({
  campaignId: z.string().cuid().optional(),
  mapping: z.object(
    Object.fromEntries(
      CONTACT_FIELDS.map((f) => [f, z.string().max(200).optional()]),
    ) as Record<(typeof CONTACT_FIELDS)[number], z.ZodOptional<z.ZodString>>,
  ),
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export const templateSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(200_000),
  description: z.string().max(1000).nullish(),
});

// ---------------------------------------------------------------------------
// Sender accounts
// ---------------------------------------------------------------------------
export const smtpAccountSchema = z.object({
  email: z.string().email().max(320).transform((e) => e.trim().toLowerCase()),
  displayName: z.string().max(200).nullish(),
  host: z.string().min(1).max(300),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1).max(300),
  password: z.string().min(1).max(500),
  dailyCap: z.number().int().min(1).max(2000).optional(),
});

export const senderSettingsSchema = z.object({
  dailyCap: z.number().int().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Unsubscribe (public endpoint)
// ---------------------------------------------------------------------------
export const unsubscribeSchema = z.object({
  token: z.string().min(10).max(2000),
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Service profiles
// ---------------------------------------------------------------------------

export const serviceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(5000).nullish(),
  targetIndustries: z.array(z.string().min(1).max(120)).max(30).default([]),
  idealCustomerProfile: z.string().max(5000).nullish(),
  defaultSubject: z.string().max(500).nullish(),
  defaultBody: z.string().max(200_000).nullish(),
  defaultCta: z.string().max(500).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Colour must be a hex value like #6366f1.")
    .default("#6366f1"),
  isActive: z.boolean().default(true),
});

export const serviceUpdateSchema = serviceCreateSchema.partial();

// ---------------------------------------------------------------------------
// Follow-up sequences
// ---------------------------------------------------------------------------

const followUpStepSchema = z.object({
  order: z.number().int().min(1).max(50),
  delayDays: z.number().int().min(0).max(365).default(3),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(200_000),
});

export const followUpSequenceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  serviceId: z.string().cuid().nullish(),
  isActive: z.boolean().default(true),
  steps: z.array(followUpStepSchema).min(1).max(20),
});

export const followUpSequenceUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  serviceId: z.string().cuid().nullish(),
  isActive: z.boolean().optional(),
  steps: z.array(followUpStepSchema).min(1).max(20).optional(),
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export const replyUpdateSchema = z.object({
  isRead: z.boolean().optional(),
  outcome: z.enum(["INTERESTED", "NOT_INTERESTED", "NEEDS_INFO", "OTHER"]).nullish(),
  contactId: z.string().cuid().nullish(),
});
