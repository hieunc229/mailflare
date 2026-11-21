import type { CalendarRepeat } from "./types";

export const DEFAULT_REPEAT_DAYS = [1, 2, 3, 4, 5];

export function normalizeCalendarRepeat(value: string | undefined): CalendarRepeat {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "weekdays" || value === "yearly" ? value : "none";
}

/** Step between recurrences: an integer 1..999, else 1. */
export function normalizeRepeatInterval(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 999 ? (value as number) : 1;
}

/** Weekday of an nth-weekday monthly repeat (0-6), else null. */
export function normalizeRepeatWeekday(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6 ? (value as number) : null;
}

/** Week of an nth-weekday monthly repeat (1-5, -1 = last), else null. */
export function normalizeRepeatWeek(value: unknown): number | null {
  return Number.isInteger(value) && (((value as number) >= 1 && (value as number) <= 5) || value === -1) ? (value as number) : null;
}

export function normalizeCalendarRepeatDays(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
    : [];
}

export function parseCalendarRepeatDays(value: string | undefined): number[] {
  try { return normalizeCalendarRepeatDays(JSON.parse(value ?? "[]")); } catch { return []; }
}

export function parseExcludedOccurrences(value: string | undefined): number[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((timestamp): timestamp is number => Number.isSafeInteger(timestamp) && timestamp >= 0) : [];
  } catch { return []; }
}

export function parseCalendarOccurrenceId(value: string): { seriesId: string; startsAt: Date } | null {
  const separator = value.lastIndexOf("@");
  if (separator < 1) return null;
  const timestamp = Number(value.slice(separator + 1));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  return { seriesId: value.slice(0, separator), startsAt: new Date(timestamp) };
}
