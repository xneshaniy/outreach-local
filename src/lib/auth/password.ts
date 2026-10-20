import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  // bcrypt.compare is constant-time w.r.t. the hash contents.
  return bcrypt.compare(plaintext, hash);
}

/**
 * Password policy: length over composition. Blocks the most common weak choices.
 */
export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters long.";
  if (password.length > 200) return "Password must be at most 200 characters long.";
  const banned = ["password", "12345678", "qwerty", "letmein", "welcome", "outreach"];
  const lower = password.toLowerCase();
  if (banned.some((b) => lower.includes(b))) return "Password is too easy to guess.";
  return null;
}
