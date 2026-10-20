import type { Contact } from "@prisma/client";
import { contactVars, extractVariables } from "./template";

/**
 * Personalisation analysis.
 *
 * Before a campaign starts we check that the message does not rely on data
 * the audience does not have. A template that starts with "Hi {{first_name}}"
 * but the list has no first names produces "Hi " — a bad first impression and
 * a spam signal. This module reports:
 *
 *  - `missing`: variables used by the template that no contact provides.
 *  - `coverage`: how many recipients would end up with an empty value.
 *  - `incomplete`: the most common empty values, for the pre-flight report.
 */

/** Variables that are always available (never reported as missing). */
const ALWAYS_AVAILABLE = new Set(["email", "unsubscribe_url"]);

export type PersonalizationReport = {
  variables: string[];
  /** Variables no contact in the audience can fill in. */
  missing: string[];
  /** Variables some contacts can fill in (partial coverage). */
  partial: string[];
  /** How many contacts were inspected. */
  contactsChecked: number;
  /** Per-variable count of contacts that HAVE a value. */
  coverage: Record<string, number>;
  /** Example values for the variables (first non-empty value found). */
  examples: Record<string, string>;
};

function isEmptyValue(value: string | undefined | null): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Analyse a template against a set of contacts.
 *
 * `contacts` may be a large list; the caller can pass a sample (the UI uses
 * up to 500 contacts) to keep the report fast.
 */
export function analyzePersonalization(
  template: string,
  contacts: Array<
    Pick<Contact, "email" | "firstName" | "lastName" | "company" | "website" | "title" | "customFields">
  >,
): PersonalizationReport {
  const variables = extractVariables(template).filter((v) => !ALWAYS_AVAILABLE.has(v));
  const coverage: Record<string, number> = {};
  const examples: Record<string, string> = {};

  for (const variable of variables) {
    coverage[variable] = 0;
  }

  for (const contact of contacts) {
    const vars = contactVars(contact);
    for (const variable of variables) {
      const value = vars[variable];
      if (!isEmptyValue(value)) {
        coverage[variable]! += 1;
        if (!examples[variable]) examples[variable] = String(value);
      }
    }
  }

  const total = contacts.length;
  const missing: string[] = [];
  const partial: string[] = [];
  for (const variable of variables) {
    const count = coverage[variable] ?? 0;
    if (total === 0) {
      partial.push(variable);
    } else if (count === 0) {
      missing.push(variable);
    } else if (count < total) {
      partial.push(variable);
    }
  }

  return {
    variables,
    missing,
    partial,
    contactsChecked: total,
    coverage,
    examples,
  };
}

/**
 * A short, human-readable summary for the campaign pre-flight check.
 */
export function describePersonalization(report: PersonalizationReport): string[] {
  const problems: string[] = [];
  if (report.missing.length > 0) {
    problems.push(
      `No contact has a value for: ${report.missing.join(", ")}. Those placeholders will render as empty text.`,
    );
  }
  if (report.partial.length > 0) {
    problems.push(
      `Some contacts are missing: ${report.partial.join(", ")}. Consider a fallback phrase.`,
    );
  }
  return problems;
}
