import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hmacSign, hmacVerify, randomToken, safeEqual, sha256 } from "@/lib/crypto";

/**
 * Provider tokens are stored with AES-256-GCM (authenticated encryption).
 * Tampering or AAD mix-up must fail loudly, never silently.
 */
describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    const secret = "1//0abcDEF-refresh-token-value";
    const encrypted = encryptSecret(secret, "sender:acc1:refreshToken");
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, "sender:acc1:refreshToken")).toBe(secret);
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const a = encryptSecret("same-value", "aad");
    const b = encryptSecret("same-value", "aad");
    expect(a).not.toBe(b);
  });

  it("fails when the ciphertext is tampered with", () => {
    const encrypted = encryptSecret("secret-value", "aad");
    const parts = encrypted.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(":");
    expect(() => decryptSecret(tampered, "aad")).toThrow();
  });

  it("fails when the AAD context differs (prevents token mix-up between accounts)", () => {
    const encrypted = encryptSecret("secret-value", "sender:acc1:refreshToken");
    expect(() => decryptSecret(encrypted, "sender:acc2:refreshToken")).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-encrypted")).toThrow();
    expect(() => decryptSecret("v2:a:b:c")).toThrow();
  });
});

describe("hmac tokens", () => {
  it("signs and verifies", () => {
    const sig = hmacSign("payload", "secret");
    expect(hmacVerify("payload", sig, "secret")).toBe(true);
  });

  it("rejects tampered payloads and wrong secrets", () => {
    const sig = hmacSign("payload", "secret");
    expect(hmacVerify("payloadX", sig, "secret")).toBe(false);
    expect(hmacVerify("payload", sig, "other-secret")).toBe(false);
  });
});

describe("misc", () => {
  it("safeEqual compares securely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("randomToken is url-safe and unique", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).not.toMatch(/[+/=]/);
  });

  it("sha256 is stable", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
