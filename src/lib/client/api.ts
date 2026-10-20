"use client";

/**
 * Client-side fetch helper.
 * - Always sends cookies (session auth).
 * - Parses the standard error envelope { error: { code, message, details } }.
 * - Throws ApiClientError so pages can show field-level validation errors.
 */

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

type ApiOptions = RequestInit & { idempotencyKey?: string };

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const hasBody = options.body !== undefined && !(options.body instanceof FormData);
  if (hasBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

  const res = await fetch(path, { ...options, headers, credentials: "same-origin" });

  if (res.status === 204) return undefined as T;

  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: never } })?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

export function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiClientError && Array.isArray(err.details)) {
    return Object.fromEntries(err.details.map((d) => [d.path, d.message]));
  }
  return {};
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
