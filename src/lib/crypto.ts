import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Cryptographic helpers.
 *
 *  - Provider tokens are encrypted with AES-256-GCM (authenticated encryption).
 *  - Unsubscribe tokens are stateless HMAC-signed payloads.
 *  - Secrets are never logged.
 */

const ENC_PREFIX = "v1";

function getKey(): Buffer {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "dev-only-insecure-encryption-key-32b", "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (base64).");
  }
  return key;
}

/**
 * Encrypt a secret with AES-256-GCM.
 * Output format: "v1:<iv-b64>:<tag-b64>:<ciphertext-b64>"
 * `aad` (additional authenticated data) binds the ciphertext to a context,
 * e.g. `sender:${accountId}:refreshToken`, preventing token mix-up attacks.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/**
 * Decrypt a value produced by `encryptSecret`. Throws on tampering.
 */
export function decryptSecret(payload: string, aad?: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) {
    throw new Error("Malformed encrypted payload.");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSign(payload: string, secret: string = process.env.AUTH_SECRET ?? "dev-only-insecure-auth-secret-change-me!!"): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function hmacVerify(payload: string, signature: string, secret: string = process.env.AUTH_SECRET ?? "dev-only-insecure-auth-secret-change-me!!"): boolean {
  const expected = Buffer.from(hmacSign(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time string comparison for API keys / signatures.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
