import { describe, expect, it } from "vitest";
import { analyzePersonalization, describePersonalization } from "@/lib/personalization";
import { slugify } from "@/lib/services";
import { dryRunMessageId, isDryRunMessageId, DRY_RUN_MESSAGE_PREFIX } from "@/lib/email/dry-run";
import { extractVariables, renderTemplate } from "@/lib/template";

/**
 * Unit tests for the new outreach features: personalisation analysis, service
 * slugs and the dry-run provider.
 */

const contact = (over: Partial<Record<string, unknown>> = {}) => ({
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Analytical Engines",
  website: "https://example.com",
  title: "CTO",
  customFields: null,
  ...over,
});

describe("analyzePersonalization", () => {
  it("reports variables that every contact can fill in", () => {
    const report = analyzePersonalization("Hi {{first_name}}, {{company}}", [
      contact(),
      contact({ firstName: "Grace" }),
    ]);
    expect(report.variables).toEqual(["company", "first_name"]);
    expect(report.missing).toEqual([]);
    expect(report.partial).toEqual([]);
    expect(report.coverage.first_name).toBe(2);
    expect(report.coverage.company).toBe(2);
  });

  it("reports variables that no contact has", () => {
    const report = analyzePersonalization("Hi {{first_name}}, {{title}}", [
      contact({ title: "" }),
      contact({ title: null }),
    ]);
    expect(report.missing).toContain("title");
    expect(report.missing).not.toContain("first_name");
  });

  it("reports partially covered variables", () => {
    const report = analyzePersonalization("Hi {{first_name}}", [
      contact(),
      contact({ firstName: null }),
    ]);
    expect(report.partial).toContain("first_name");
    expect(report.missing).not.toContain("first_name");
    expect(report.coverage.first_name).toBe(1);
  });

  it("never reports the unsubscribe url as missing", () => {
    const report = analyzePersonalization("Unsubscribe: {{unsubscribe_url}}", [contact()]);
    expect(report.variables).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("handles an empty audience without crashing", () => {
    const report = analyzePersonalization("Hi {{first_name}}", []);
    expect(report.contactsChecked).toBe(0);
    expect(report.missing).toEqual([]);
    expect(report.partial).toEqual(["first_name"]);
  });

  it("reads custom fields as variables", () => {
    const report = analyzePersonalization("Hi {{industry}}", [
      contact({ customFields: { industry: "SaaS" } }),
    ]);
    expect(report.missing).toEqual([]);
    expect(report.examples.industry).toBe("SaaS");
  });

  it("produces a human-readable summary", () => {
    const report = analyzePersonalization("Hi {{title}}", [contact({ title: null })]);
    const problems = describePersonalization(report);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("title");
  });
});

describe("slugify", () => {
  it("lower-cases and hyphenates", () => {
    expect(slugify("Lead Generation & List Building")).toBe("lead-generation-list-building");
  });

  it("strips accents and punctuation", () => {
    expect(slugify("Café & CRM — Automatisation")).toBe("cafe-crm-automatisation");
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("service");
    expect(slugify("")).toBe("service");
  });
});

describe("dry run provider", () => {
  it("produces a deterministic, clearly-marked message id", () => {
    const a = dryRunMessageId("job-1", 1);
    const b = dryRunMessageId("job-1", 1);
    const c = dryRunMessageId("job-1", 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(DRY_RUN_MESSAGE_PREFIX)).toBe(true);
  });

  it("recognises its own message ids", () => {
    expect(isDryRunMessageId(dryRunMessageId("job-1", 1))).toBe(true);
    expect(isDryRunMessageId("gmail-message-id")).toBe(false);
    expect(isDryRunMessageId(null)).toBe(false);
    expect(isDryRunMessageId(undefined)).toBe(false);
  });
});

describe("template variables", () => {
  it("extracts the variables a template uses", () => {
    expect(extractVariables("Hi {{first_name}}, {{ company }}!")).toEqual(["company", "first_name"]);
  });

  it("renders unknown variables as empty strings", () => {
    expect(renderTemplate("Hi {{unknown}}", { first_name: "Ada" })).toBe("Hi ");
  });

  it("escapes HTML in values", () => {
    expect(renderTemplate("Hi {{first_name}}", { first_name: "<script>" })).toBe(
      "Hi &lt;script&gt;",
    );
  });
});
