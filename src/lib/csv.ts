import Papa from "papaparse";
import { z } from "zod";
import { isValidEmail, normalizeEmail, normalizeTimeZone } from "./email-normalize";

/**
 * CSV contact import: parsing, header auto-detection, field mapping and
 * per-row validation. Nothing here touches the database — the route layer
 * persists with `createMany(skipDuplicates)` inside the unique constraints.
 */

export const MAX_IMPORT_ROWS = 50_000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export const CONTACT_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "company",
  "website",
  "title",
  "timeZone",
  "country",
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

const FIELD_CANDIDATES: Record<ContactField, string[]> = {
  email: ["email", "e-mail", "emailaddress", "mail", "emailid"],
  firstName: ["firstname", "fname", "givenname", "first"],
  lastName: ["lastname", "lname", "surname", "familyname", "last"],
  company: ["company", "companyname", "organization", "org", "account"],
  website: ["website", "url", "web", "site", "companyurl"],
  title: ["title", "jobtitle", "role", "position"],
  timeZone: ["timezone", "time_zone", "tz", "iana"],
  country: ["country", "countrycode", "nation"],
};

/** Map CSV headers to fields; matches by normalized header name. */
export function detectMapping(headers: string[]): Partial<Record<ContactField, string>> {
  const mapping: Partial<Record<ContactField, string>> = {};
  for (const header of headers) {
    const norm = header.trim().toLowerCase().replace(/[\s_-]+/g, "");
    for (const field of CONTACT_FIELDS) {
      if (mapping[field]) continue;
      if (FIELD_CANDIDATES[field].includes(norm)) {
        mapping[field] = header;
        break;
      }
    }
  }
  return mapping;
}

export type ParsedContactRow = {
  email: string;
  emailNormalized: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  website?: string | null;
  title?: string | null;
  timeZone?: string | null;
  country?: string | null;
};

export type InvalidRow = { row: number; reason: string; email?: string };

export type ParseResult = {
  headers: string[];
  mapping: Partial<Record<ContactField, string>>;
  valid: ParsedContactRow[];
  invalid: InvalidRow[];
  /** Rows that duplicated another row *within the same file*. */
  duplicatesInFile: number;
  total: number;
};

const rowSchema = z.object({
  email: z.string().min(3).max(320),
  firstName: z.string().max(200).nullish(),
  lastName: z.string().max(200).nullish(),
  company: z.string().max(300).nullish(),
  website: z.string().max(500).nullish(),
  title: z.string().max(200).nullish(),
  timeZone: z.string().max(100).nullish(),
  country: z.string().max(100).nullish(),
});

export function parseContactsCsv(
  text: string,
  mapping: Partial<Record<ContactField, string>>,
): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  const emailCol = mapping.email;
  if (!emailCol || !headers.includes(emailCol)) {
    throw new Error("An email column is required. Map one in the import wizard.");
  }

  const valid: ParsedContactRow[] = [];
  const invalid: InvalidRow[] = [];
  const seen = new Set<string>();
  let duplicatesInFile = 0;

  const limit = Math.min(parsed.data.length, MAX_IMPORT_ROWS);
  for (let i = 0; i < limit; i++) {
    const raw = parsed.data[i] ?? {};
    const rowNumber = i + 2; // +2: 1-based + header row

    const pick = (field: ContactField): string | undefined => {
      const col = mapping[field];
      if (!col) return undefined;
      const value = raw[col];
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const candidate = {
      email: pick("email") ?? "",
      firstName: pick("firstName") ?? null,
      lastName: pick("lastName") ?? null,
      company: pick("company") ?? null,
      website: pick("website") ?? null,
      title: pick("title") ?? null,
      timeZone: pick("timeZone") ?? null,
      country: pick("country") ?? null,
    };

    const check = rowSchema.safeParse(candidate);
    if (!check.success) {
      invalid.push({ row: rowNumber, reason: "Invalid field values.", email: candidate.email || undefined });
      continue;
    }
    if (!isValidEmail(candidate.email)) {
      invalid.push({ row: rowNumber, reason: "Invalid email address.", email: candidate.email || undefined });
      continue;
    }

    const emailNormalized = normalizeEmail(candidate.email);
    if (seen.has(emailNormalized)) {
      duplicatesInFile++;
      continue; // first occurrence wins; DB constraint would skip it anyway
    }
    seen.add(emailNormalized);

    valid.push({
      email: candidate.email,
      emailNormalized,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      company: candidate.company,
      website: candidate.website,
      title: candidate.title,
      // Invalid IANA zones become null -> scheduling HOLDs these recipients.
      timeZone: normalizeTimeZone(candidate.timeZone),
      country: candidate.country,
    });
  }

  return {
    headers,
    mapping,
    valid,
    invalid,
    duplicatesInFile,
    total: parsed.data.length,
  };
}

/** Human-readable preview of detected headers for the wizard step 1. */
export function previewCsvHeaders(text: string, maxRows = 5): { headers: string[]; sample: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    preview: maxRows,
    transformHeader: (h) => h.trim(),
  });
  return { headers: parsed.meta.fields ?? [], sample: parsed.data.slice(0, maxRows) };
}
