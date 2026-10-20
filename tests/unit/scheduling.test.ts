import { describe, expect, it } from "vitest";
import {
  clampToWindow,
  DEFAULT_SENDING_WINDOW,
  getLocalParts,
  isWithinSendingWindow,
  nextSendingInstant,
  zonedTimeToUtc,
  type SendingWindow,
} from "@/lib/scheduling";

/**
 * Recipient-local scheduling, including daylight-saving transitions.
 */

const WORKDAYS: SendingWindow = { startMinute: 540, endMinute: 1020, days: [1, 2, 3, 4, 5] };

describe("getLocalParts", () => {
  it("reads wall-clock time in the recipient zone", () => {
    // 2026-06-15T12:00:00Z
    const date = new Date("2026-06-15T12:00:00Z");
    const karachi = getLocalParts(date, "Asia/Karachi"); // UTC+5, no DST
    expect(karachi.hour).toBe(17);
    expect(karachi.minute).toBe(0);
    expect(karachi.weekday).toBe(1); // Monday

    const ny = getLocalParts(date, "America/New_York"); // UTC-4 (EDT)
    expect(ny.hour).toBe(8);
  });

  it("throws for invalid time zones", () => {
    expect(() => getLocalParts(new Date(), "Not/AZone")).toThrow();
  });
});

describe("zonedTimeToUtc", () => {
  it("converts local wall-clock time to UTC (standard offset)", () => {
    // 09:00 in Asia/Karachi (UTC+5, no DST) == 04:00 UTC
    const utc = zonedTimeToUtc(2026, 6, 15, 9, 0, "Asia/Karachi");
    expect(utc.toISOString()).toBe("2026-06-15T04:00:00.000Z");
  });

  it("handles DST in America/New_York (EST vs EDT)", () => {
    const winter = zonedTimeToUtc(2026, 1, 15, 9, 0, "America/New_York"); // EST = UTC-5
    expect(winter.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    const summer = zonedTimeToUtc(2026, 7, 15, 9, 0, "America/New_York"); // EDT = UTC-4
    expect(summer.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("resolves spring-forward gap times to a real instant", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 in America/New_York.
    // 02:30 does not exist; we accept the shifted instant instead of crashing.
    const utc = zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York");
    expect(Number.isNaN(utc.getTime())).toBe(false);
    const parts = getLocalParts(utc, "America/New_York");
    // The resulting local time is 03:30 EDT.
    expect(parts.hour).toBe(3);
    expect(parts.minute).toBe(30);
  });

  it("resolves ambiguous fall-back times to the earlier occurrence", () => {
    // 2026-11-01: 01:30 happens twice in America/New_York.
    const utc = zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York");
    // Earlier occurrence is EDT (UTC-4) => 05:30Z.
    expect(utc.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("isWithinSendingWindow", () => {
  it("accepts times inside the window on allowed days", () => {
    const Mon1000Utc = new Date("2026-06-15T10:00:00Z"); // Karachi: Mon 15:00
    expect(isWithinSendingWindow(Mon1000Utc, "Asia/Karachi", WORKDAYS)).toBe(true);
  });

  it("rejects times before the window opens", () => {
    // 2026-06-15T03:30Z -> Karachi 08:30 (before 09:00)
    const early = new Date("2026-06-15T03:30:00Z");
    expect(isWithinSendingWindow(early, "Asia/Karachi", WORKDAYS)).toBe(false);
  });

  it("rejects weekend days", () => {
    const Sat = new Date("2026-06-20T10:00:00Z"); // Saturday
    expect(isWithinSendingWindow(Sat, "Asia/Karachi", WORKDAYS)).toBe(false);
  });

  it("respects each recipient's own zone for the same instant", () => {
    const instant = new Date("2026-06-15T12:30:00Z");
    // Karachi 17:30 -> outside (window ends 17:00)
    expect(isWithinSendingWindow(instant, "Asia/Karachi", WORKDAYS)).toBe(false);
    // London 13:30 (BST) -> inside
    expect(isWithinSendingWindow(instant, "Europe/London", WORKDAYS)).toBe(true);
  });
});

describe("nextSendingInstant", () => {
  it("returns the same instant when already inside the window", () => {
    const inside = new Date("2026-06-15T10:00:00Z");
    expect(nextSendingInstant(inside, "Asia/Karachi", WORKDAYS)?.getTime()).toBe(inside.getTime());
  });

  it("moves to 09:00 recipient-local when called before the window", () => {
    const Mon0300Z = new Date("2026-06-15T03:00:00Z"); // Karachi 08:00 Monday
    const next = nextSendingInstant(Mon0300Z, "Asia/Karachi", WORKDAYS)!;
    expect(next.toISOString()).toBe("2026-06-15T04:00:00.000Z"); // 09:00 Karachi
  });

  it("skips to Monday when called during the weekend", () => {
    const Sat = new Date("2026-06-20T10:00:00Z");
    const next = nextSendingInstant(Sat, "Asia/Karachi", WORKDAYS)!;
    const parts = getLocalParts(next, "Asia/Karachi");
    expect(parts.weekday).toBe(1);
    expect(parts.hour).toBe(9);
  });

  it("handles DST transitions: window on the spring-forward day", () => {
    // Sunday 2026-03-08 is not a sending day; Monday 09:00 EDT must be 13:00Z.
    const sat = new Date("2026-03-07T12:00:00Z");
    const next = nextSendingInstant(sat, "America/New_York", WORKDAYS)!;
    expect(next.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });
});

describe("clampToWindow", () => {
  it("returns the proposed instant when inside the window", () => {
    const inside = new Date("2026-06-15T10:00:00Z");
    expect(clampToWindow(inside, "Asia/Karachi", WORKDAYS, { mode: "HOLD" })?.getTime()).toBe(inside.getTime());
  });

  it("HOLD mode returns null for unknown time zones", () => {
    expect(clampToWindow(new Date(), null, WORKDAYS, { mode: "HOLD" })).toBeNull();
  });

  it("FALLBACK mode uses the configured fallback zone", () => {
    const inside = new Date("2026-06-15T10:00:00Z");
    const result = clampToWindow(inside, null, WORKDAYS, { mode: "FALLBACK", fallbackTimeZone: "Europe/London" });
    expect(result?.getTime()).toBe(inside.getTime());
  });

  it("returns null for an invalid zone in HOLD mode", () => {
    // Note: clampToWindow trusts a pre-validated zone; invalid ones are
    // normalized to null at import time (normalizeTimeZone).
    expect(clampToWindow(new Date(), "Bad/Zone", WORKDAYS, { mode: "HOLD" })).toBeNull();
  });
});

describe("defaults", () => {
  it("matches the spec: 09:00–17:00 Mon–Fri", () => {
    expect(DEFAULT_SENDING_WINDOW).toEqual({ startMinute: 540, endMinute: 1020, days: [1, 2, 3, 4, 5] });
  });
});
