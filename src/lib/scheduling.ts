import { z } from "zod";

/**
 * Recipient-local scheduling.
 *
 * All storage is UTC; the *decision* of when a message may be sent is made in
 * the recipient's IANA time zone. Daylight-saving transitions are handled by
 * converting local wall-clock times to UTC via Intl (no fixed offsets).
 */

export const MINUTES_PER_DAY = 24 * 60;

export type SendingWindow = {
  /** Minutes from local midnight (inclusive). Default 9:00 => 540. */
  startMinute: number;
  /** Minutes from local midnight (exclusive). Default 17:00 => 1020. */
  endMinute: number;
  /** 0=Sunday .. 6=Saturday. Default Mon–Fri. */
  days: number[];
};

export const DEFAULT_SENDING_WINDOW: SendingWindow = {
  startMinute: 540,
  endMinute: 1020,
  days: [1, 2, 3, 4, 5],
};

export const sendingWindowSchema = z
  .object({
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .refine((w) => w.endMinute > w.startMinute, {
    message: "endMinute must be after startMinute (overnight windows are not supported).",
  });

// ---------------------------------------------------------------------------
// Intl-based time-zone math (DST-safe)
// ---------------------------------------------------------------------------

type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sunday
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Read the wall-clock parts of `date` as seen in `timeZone`. */
export function getLocalParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some ICU versions render midnight as 24
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Offset (minutes) of `timeZone` relative to UTC at the given instant. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = getLocalParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Convert a local wall-clock time in `timeZone` to the UTC instant.
 *
 * DST handling (probe + validate):
 *  - Normal times: single unambiguous result.
 *  - Fall-back (ambiguous local times): returns the FIRST (earlier) occurrence.
 *  - Spring-forward (nonexistent local times): returns the instant the clock
 *    jumps to (02:30 -> 03:30), which keeps the send inside the window.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const matches = (d: Date): boolean => {
    const p = getLocalParts(d, timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };

  // Probe offsets before / at / around the target instant; a DST transition
  // never sits within 3 hours of another one, so these cover both sides.
  const offsets = [
    tzOffsetMinutes(new Date(targetAsUtc - 3 * 3600000), timeZone),
    tzOffsetMinutes(new Date(targetAsUtc), timeZone),
    tzOffsetMinutes(new Date(targetAsUtc + 3 * 3600000), timeZone),
  ];

  const candidates = [...new Set(offsets)].map((o) => new Date(targetAsUtc - o * 60000));
  const valid = candidates.filter(matches);

  if (valid.length > 0) {
    // Ambiguous (fall-back): choose the earlier occurrence.
    return new Date(Math.min(...valid.map((d) => d.getTime())));
  }
  // Nonexistent (spring-forward gap): choose the latest candidate, i.e. the
  // post-jump wall-clock time (02:30 resolves to 03:30 local).
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/**
 * Is `date` inside the campaign's permitted sending window for the recipient?
 */
export function isWithinSendingWindow(date: Date, timeZone: string, window: SendingWindow): boolean {
  const p = getLocalParts(date, timeZone);
  if (!window.days.includes(p.weekday)) return false;
  const minuteOfDay = p.hour * 60 + p.minute;
  return minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

/**
 * Find the next UTC instant >= `from` that falls inside the recipient's local
 * sending window. Returns null when no valid instant exists within `searchDays`
 * (can only happen with an empty `days` array).
 */
export function nextSendingInstant(from: Date, timeZone: string, window: SendingWindow): Date | null {
  const maxSearchDays = 14;

  // Start from the recipient's "today" and walk forward day by day.
  for (let dayOffset = 0; dayOffset <= maxSearchDays; dayOffset++) {
    const probe = addDaysUtc(from, dayOffset);
    const p = getLocalParts(probe, timeZone);

    // Advance to a day whose weekday is allowed.
    if (!window.days.includes(p.weekday)) continue;

    const startUtc = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
    // Add the desired minutes of day to the local-midnight instant. During a
    // spring-forward gap this lands on the shifted wall-clock time, which is
    // what we want; during fall-back it lands on the earlier occurrence.
    const candidate = new Date(startUtc.getTime() + window.startMinute * 60000);

    if (candidate.getTime() >= from.getTime() && isWithinSendingWindow(candidate, timeZone, window)) {
      return candidate;
    }

    // The window for this local day already started before `from` — if we are
    // still inside it, the caller keeps the original time; otherwise move on.
    if (candidate.getTime() < from.getTime()) {
      if (isWithinSendingWindow(from, timeZone, window)) return from;
    }
  }
  return null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clamp a proposed UTC send time into the recipient's window.
 * - If the instant is inside the window, it is returned unchanged.
 * - If outside, the next valid instant is returned.
 * - If the recipient's zone is unknown/invalid:
 *     mode "HOLD"     -> null (caller must hold the recipient for review)
 *     mode "FALLBACK" -> scheduled against `fallbackTimeZone`
 */
export function clampToWindow(
  proposed: Date,
  timeZone: string | null | undefined,
  window: SendingWindow,
  opts: { mode: "HOLD" | "FALLBACK"; fallbackTimeZone?: string | null },
): Date | null {
  const zone =
    timeZone && isValidTimeZone(timeZone)
      ? timeZone
      : opts.mode === "FALLBACK" && opts.fallbackTimeZone && isValidTimeZone(opts.fallbackTimeZone)
        ? opts.fallbackTimeZone
        : null;
  if (!zone) return null;
  if (isWithinSendingWindow(proposed, zone, window)) return proposed;
  return nextSendingInstant(proposed, zone, window);
}

export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
