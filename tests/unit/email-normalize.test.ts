import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail, normalizeTimeZone } from "@/lib/email-normalize";

/**
 * Email normalization must be IDENTICAL wherever dedupe/suppression happens.
 */
describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("strips +tags for Gmail addresses", () => {
    expect(normalizeEmail("user+newsletter@gmail.com")).toBe("user@gmail.com");
  });

  it("removes dots in the Gmail local part", () => {
    expect(normalizeEmail("f.i.r.s.t.last@gmail.com")).toBe("firstlast@gmail.com");
  });

  it("treats googlemail.com as gmail", () => {
    expect(normalizeEmail("user.name+x@googlemail.com")).toBe("username@gmail.com");
  });

  it("does NOT strip dots for other providers", () => {
    expect(normalizeEmail("first.last@company.co.uk")).toBe("first.last@company.co.uk");
  });

  it("does NOT strip +tags for other providers", () => {
    expect(normalizeEmail("user+tag@company.co.uk")).toBe("user+tag@company.co.uk");
  });

  it("makes duplicate imports collide (spec §5)", () => {
    // Case + whitespace differences only: same address everywhere.
    expect(normalizeEmail("Ada@Example.com")).toBe("ada@example.com");
    expect(normalizeEmail("ada@EXAMPLE.com")).toBe("ada@example.com");
    expect(normalizeEmail(" ada@example.com ")).toBe("ada@example.com");
    // Gmail-family variants of ONE mailbox collapse to a single address.
    expect(normalizeEmail("Ada.Lovelace+news@GMAIL.com")).toBe("adalovelace@gmail.com");
    expect(normalizeEmail("adalovelace@googlemail.com")).toBe("adalovelace@gmail.com");
  });
});

describe("isValidEmail", () => {
  it("accepts common addresses", () => {
    expect(isValidEmail("ada@example.com")).toBe(true);
    expect(isValidEmail("ada.lovelace+news@sub.domain.co.uk")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidEmail("plainaddress")).toBe(false);
    expect(isValidEmail("@no-local.com")).toBe(false);
    expect(isValidEmail("user@nodot")).toBe(false);
    expect(isValidEmail("two @@example.com")).toBe(false);
    expect(isValidEmail("spaces in@example.com")).toBe(false);
  });

  it("rejects over-long addresses", () => {
    expect(isValidEmail(`${"a".repeat(320)}@example.com`)).toBe(false);
  });
});

describe("normalizeTimeZone", () => {
  it("accepts IANA names", () => {
    expect(normalizeTimeZone("Asia/Karachi")).toBe("Asia/Karachi");
    expect(normalizeTimeZone(" america/new_york ")).toBe("america/new_york");
  });

  it("rejects garbage", () => {
    expect(normalizeTimeZone("Not/AZone")).toBeNull();
    expect(normalizeTimeZone("")).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
    expect(normalizeTimeZone(undefined)).toBeNull();
  });
});
