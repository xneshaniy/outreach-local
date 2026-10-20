import { prisma } from "./db";

/**
 * Service profiles.
 *
 * A "service" is one business line the workspace offers (lead generation,
 * virtual assistance, CRM automation, email outreach, e-commerce, ...).
 * Each service carries its own description, target industries, ideal customer
 * profile, default subject/body and call to action, so campaigns and
 * templates can be grouped and reused per business line.
 */

/** URL-safe slug from a display name. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "service";
}

/**
 * Make a slug unique inside the workspace by appending -2, -3, ...
 */
export async function uniqueServiceSlug(userId: string, name: string, excludeId?: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const existing = await prisma.service.findUnique({
      where: { userId_slug: { userId, slug: candidate } },
      select: { id: true },
    });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Starter service profiles. They are suggestions the user can rename, edit or
 * delete — they are only created when the workspace has no services yet.
 */
export const SERVICE_PRESETS: Array<{
  name: string;
  slug: string;
  description: string;
  targetIndustries: string[];
  idealCustomerProfile: string;
  defaultSubject: string;
  defaultBody: string;
  defaultCta: string;
  color: string;
}> = [
  {
    name: "Lead Generation & List Building",
    slug: "lead-generation",
    description:
      "Research, qualify and deliver clean, targeted prospect lists — verified emails with company, role and timezone so you can reach the right people.",
    targetIndustries: ["SaaS", "Agencies", "Consulting", "E-commerce", "Professional services"],
    idealCustomerProfile:
      "B2B companies with a sales team that needs a steady flow of qualified decision makers in a specific market.",
    defaultSubject: "A {{company}}-focused list of {{target_industry}} decision makers",
    defaultBody:
      "<p>Hi {{first_name}},</p><p>I build verified prospect lists for {{company}}-type teams — correct role, working email, and the timezone so you can reach them at a sensible hour.</p><p>{{cta}}</p><p>Best,<br/>The Team</p>",
    defaultCta: "Could I send you a 10-row sample so you can judge the quality?",
    color: "#6366f1",
  },
  {
    name: "Virtual Assistance",
    slug: "virtual-assistance",
    description:
      "Reliable, organised remote support for busy founders and small teams — inbox, calendar, research, reporting and the routine admin that piles up.",
    targetIndustries: ["Founders", "Agencies", "Consultants", "E-commerce", "Real estate"],
    idealCustomerProfile:
      "Founder-led or small teams (2–20 people) without a dedicated operations hire.",
    defaultSubject: "Getting the admin off your plate",
    defaultBody:
      "<p>Hi {{first_name}},</p><p>I help small teams take the repetitive work off their plate — inbox, calendar, research and reporting, done properly and on time.</p><p>{{cta}}</p><p>Best,<br/>The Team</p>",
    defaultCta: "What is the one recurring task you would happily never see again?",
    color: "#0ea5e9",
  },
  {
    name: "CRM Management & Automation",
    slug: "crm-automation",
    description:
      "Clean, well-structured CRM data with automated follow-ups, pipelines and reporting that reflects what actually happened.",
    targetIndustries: ["Sales teams", "Agencies", "Real estate", "Coaching", "Recruitment"],
    idealCustomerProfile:
      "Teams whose pipeline is spread across spreadsheets and inboxes and who need one source of truth.",
    defaultSubject: "Your CRM, cleaned up and actually automated",
    defaultBody:
      "<p>Hi {{first_name}},</p><p>I clean up CRM data, rebuild the pipeline so it reflects reality, and automate the follow-ups your team forgets.</p><p>{{cta}}</p><p>Best,<br/>The Team</p>",
    defaultCta: "Can I record a short walkthrough of what your pipeline looks like today?",
    color: "#10b981",
  },
  {
    name: "Email Outreach & Follow-ups",
    slug: "email-outreach",
    description:
      "Personalised cold email with proper deliverability hygiene — one-at-a-time sending windows, respectful volume, and automatic suppression the moment someone opts out.",
    targetIndustries: ["B2B SaaS", "Agencies", "Consulting", "Recruitment", "IT services"],
    idealCustomerProfile:
      "Businesses that need to reach a defined audience of decision makers and can send a handful of genuinely personal emails a day.",
    defaultSubject: "Quick idea for {{company}}",
    defaultBody:
      "<p>Hi {{first_name}},</p><p>I work with {{company}}-type teams on {{target_industry}} outreach — carefully targeted, sent inside each recipient's working hours.</p><p>{{cta}}</p><p>Best,<br/>The Team</p>",
    defaultCta: "Is this something you would like a short sample of?",
    color: "#f59e0b",
  },
  {
    name: "E-commerce Management",
    slug: "ecommerce-management",
    description:
      "Store operations that keep running — listings, customer service, order issues, reviews and the analytics that tell you what to stock next.",
    targetIndustries: ["DTC brands", "Amazon sellers", "Shopify stores", "Wholesalers", "Marketplaces"],
    idealCustomerProfile:
      "Online stores doing real volume where operations have outgrown a single generalist.",
    defaultSubject: "Store operations for {{company}}",
    defaultBody:
      "<p>Hi {{first_name}},</p><p>I keep online stores running smoothly — listings, customer messages, order problems and the numbers behind them.</p><p>{{cta}}</p><p>Best,<br/>The Team</p>",
    defaultCta: "What is the part of store operations that keeps landing on your desk?",
    color: "#ec4899",
  },
];

/**
 * Create the starter service profiles for a workspace that has none.
 * Idempotent: returns the existing services when the workspace already has some.
 */
export async function ensureStarterServices(userId: string) {
  const existing = await prisma.service.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  if (existing.length > 0) return existing;

  const created = [];
  for (const preset of SERVICE_PRESETS) {
    created.push(
      await prisma.service.create({
        data: {
          userId,
          name: preset.name,
          slug: preset.slug,
          description: preset.description,
          targetIndustries: preset.targetIndustries,
          idealCustomerProfile: preset.idealCustomerProfile,
          defaultSubject: preset.defaultSubject,
          defaultBody: preset.defaultBody,
          defaultCta: preset.defaultCta,
          color: preset.color,
        },
      }),
    );
  }
  return created;
}
