import { describe, expect, it } from "vitest";
import { isJsonParseError } from "@/lib/http";

/**
 * A malformed request body is a client mistake, not a server crash.
 *
 * `req.json()` rejects a malformed body with a SyntaxError. Without this, a
 * broken request fell through to the 500 branch, so it looked exactly like
 * the server had crashed.
 */
describe("JSON parse errors", () => {
  it("recognises the error thrown by a malformed body", () => {
    let thrown: unknown;
    try {
      JSON.parse("{not json");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(isJsonParseError(thrown)).toBe(true);
  });

  it("recognises the error thrown when a response body is parsed", async () => {
    let thrown: unknown;
    try {
      await new Response("{not json", { headers: { "content-type": "application/json" } }).json();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(isJsonParseError(thrown)).toBe(true);
  });

  it("does not treat an ordinary error as a parse error", () => {
    expect(isJsonParseError(new Error("something went wrong"))).toBe(false);
    expect(isJsonParseError(new TypeError("x is not a function"))).toBe(false);
    expect(isJsonParseError("a string")).toBe(false);
    expect(isJsonParseError(undefined)).toBe(false);
  });
});
