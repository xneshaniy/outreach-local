import { describe, expect, it } from "vitest";
import { detectMapping, parseContactsCsv } from "@/lib/csv";

const CSV = `Email,First Name,Last Name,Company,Website,Time Zone
ada@example.com,Ada,Lovelace,Acme,https://acme.example,Europe/London
bad-address,Bo,Bad,,,,,
ADA@EXAMPLE.COM,Ada,Duplicate,Acme,,Europe/London
charlie@foo.io,Charlie,Chaplin,Foo Inc,https://foo.io,America/New_York
Joe.Doe+news@GMAIL.COM,Joe,Doe,Acme,,America/Chicago
j.o.e.doe@gmail.com,Joe,Dup2,Acme,,America/Chicago
wei@example.net,Wei,Ren,Bar,,Not/AZone
`;

describe("detectMapping", () => {
  it("auto-detects common headers", () => {
    const mapping = detectMapping(["Email", "First Name", "Company", "time_zone"]);
    expect(mapping.email).toBe("Email");
    expect(mapping.firstName).toBe("First Name");
    expect(mapping.company).toBe("Company");
    expect(mapping.timeZone).toBe("time_zone");
  });
});

describe("parseContactsCsv", () => {
  const mapping = {
    email: "Email",
    firstName: "First Name",
    lastName: "Last Name",
    company: "Company",
    website: "Website",
    timeZone: "Time Zone",
  };

  it("parses valid rows and flags invalid emails", () => {
    const result = parseContactsCsv(CSV, mapping);
    expect(result.total).toBe(7);
    // ada, charlie, joe, wei are valid emails; bad-address is not.
    expect(result.valid.map((r) => r.emailNormalized)).toContain("charlie@foo.io");
    expect(result.invalid.some((r) => r.email === "bad-address")).toBe(true);
  });

  it("dedupes within the file using normalization (case + gmail tag)", () => {
    const result = parseContactsCsv(CSV, mapping);
    const normalized = result.valid.map((r) => r.emailNormalized);
    // Case-only variant of ada@example.com collapses.
    expect(normalized.filter((e) => e === "ada@example.com")).toHaveLength(1);
    // Gmail dot/+tag variants of the same mailbox collapse.
    expect(normalized.filter((e) => e === "joedoe@gmail.com")).toHaveLength(1);
    expect(result.duplicatesInFile).toBe(2);
  });

  it("nulls out invalid time zones so scheduling can HOLD them", () => {
    const result = parseContactsCsv(CSV, mapping);
    const invalidTz = result.valid.find((r) => r.email === "wei@example.net");
    expect(invalidTz?.timeZone).toBeNull();
  });

  it("throws when no email column is mapped", () => {
    expect(() => parseContactsCsv(CSV, {})).toThrow(/email column/i);
  });

  it("survives a header-only file", () => {
    const result = parseContactsCsv("Email,First Name\n", mapping);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(0);
  });
});
