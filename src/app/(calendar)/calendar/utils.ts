import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import type { CalendarEvent, CalendarEventTimes, EventGroup, EventResizeEdge } from "./types";
import type { FolderColor } from "@/lib/folders/types";
import type { CalendarRepeat } from "@/lib/calendar/types";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { dateFromZonedFields, formatUserDate, getDisplayLocale, formatUserDateTimeLocal, getUserTimeZone, parseUserDateTimeLocal, zonedDateFields } from "@/lib/time/utils";

export const CALENDAR_START_HOUR = 0;
export const CALENDAR_END_HOUR = 24;
export const CALENDAR_HOUR_HEIGHT = 36;
export const UPCOMING_BATCH_SIZE = 14;
export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
  { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

export const EVENT_COLOR_CLASSES: Record<FolderColor, string> = {
  "#2563eb": "bg-blue-600 text-white",
  "#7c3aed": "bg-violet-600 text-white",
  "#db2777": "bg-pink-600 text-white",
  "#dc2626": "bg-red-600 text-white",
  "#ea580c": "bg-orange-600 text-white",
  "#d97706": "bg-amber-600 text-white",
  "#16a34a": "bg-green-600 text-white",
  "#0d9488": "bg-teal-600 text-white",
};

export const PAST_EVENT_COLOR_CLASSES: Record<FolderColor, string> = {
  "#2563eb": "bg-blue-200 text-blue-900",
  "#7c3aed": "bg-violet-200 text-violet-900",
  "#db2777": "bg-pink-200 text-pink-900",
  "#dc2626": "bg-red-200 text-red-900",
  "#ea580c": "bg-orange-200 text-orange-900",
  "#d97706": "bg-amber-200 text-amber-900",
  "#16a34a": "bg-green-200 text-green-900",
  "#0d9488": "bg-teal-200 text-teal-900",
};

function recurringStart(first: Date, repeat: CalendarRepeat, index: number, timeZone: string, anchorDay?: number | null): Date {
  if (index === 0) return new Date(first);
  const fields = zonedDateFields(first, timeZone);
  if (repeat === "monthly") {
    const day = anchorDay ?? fields.getUTCDate();
    fields.setUTCDate(1);
    fields.setUTCMonth(fields.getUTCMonth() + index);
    const lastDay = new Date(Date.UTC(fields.getUTCFullYear(), fields.getUTCMonth() + 1, 0)).getUTCDate();
    fields.setUTCDate(Math.min(day, lastDay));
  } else {
    fields.setUTCDate(fields.getUTCDate() + index * (repeat === "weekly" ? 7 : 1));
  }
  return dateFromZonedFields(fields, timeZone);
}

/** Pending invitations read as outlined, not filled, so they are not mistaken for confirmed events. */
export const PENDING_EVENT_CLASSES = "border-2 border-dashed border-blue-600 bg-white text-blue-700";

export function isPendingInvite(event: { responseStatus?: string | null; inviteMessageId?: string | null }): boolean {
  return event.responseStatus === "needs-action" && !!event.inviteMessageId;
}

export function calendarTimeZone(_event?: CalendarEvent | null): string {
  return getUserTimeZone();
}

export function calendarAnchorDay(event: CalendarEvent | null, value: Date): number {
  return zonedDateFields(value, calendarTimeZone(event)).getUTCDate();
}

function recurrenceStartIndex(first: Date, repeat: CalendarRepeat, after: Date, timeZone: string): number {
  const start = zonedDateFields(first, timeZone);
  const end = zonedDateFields(after, timeZone);
  if (repeat === "monthly") return Math.max(0, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() - 1);
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (86_400_000 * (repeat === "weekly" ? 7 : 1))) - 1);
}

export function expandCalendarEvents(events: CalendarEvent[], rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
  const occurrences: CalendarEvent[] = [];
  for (const event of events) {
    const first = new Date(event.startsAt);
    const duration = new Date(event.endsAt).getTime() - first.getTime();
    if (event.repeat === "none") {
      if (first < rangeEnd && first.getTime() + duration > rangeStart.getTime()) occurrences.push(event);
      continue;
    }
    const until = event.repeatUntil ? new Date(event.repeatUntil).getTime() : Infinity;
    const repeatDays = parseCalendarRepeatDays(event.repeatDays);
    const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
    const timeZone = calendarTimeZone(event);
    const firstIndex = recurrenceStartIndex(first, event.repeat, new Date(rangeStart.getTime() - duration), timeZone);
    for (let index = firstIndex; index < firstIndex + 20_000; index++) {
      const startsAt = recurringStart(first, event.repeat, index, timeZone, event.repeatAnchorDay);
      if (startsAt >= rangeEnd || startsAt.getTime() >= until) break;
      if (excluded.has(startsAt.getTime()) || (event.repeat === "weekdays" && !repeatDays.includes(zonedDateFields(startsAt, timeZone).getUTCDay()))) continue;
      const endsAt = new Date(startsAt.getTime() + duration);
      if (endsAt > rangeStart) occurrences.push({ ...event, id: `${event.id}@${startsAt.getTime()}`, seriesStartsAt: event.startsAt, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    }
  }
  return occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export function nextCalendarOccurrence(event: CalendarEvent, after: Date): Date | null {
  const first = new Date(event.seriesStartsAt ?? event.startsAt);
  const until = event.repeatUntil ? new Date(event.repeatUntil).getTime() : Infinity;
  const repeatDays = parseCalendarRepeatDays(event.repeatDays);
  const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
  const timeZone = calendarTimeZone(event);
  const firstIndex = recurrenceStartIndex(first, event.repeat, after, timeZone);
  for (let index = firstIndex; index < firstIndex + 20_000; index++) {
    const startsAt = recurringStart(first, event.repeat, index, timeZone, event.repeatAnchorDay);
    if (startsAt.getTime() >= until) return null;
    if (startsAt < after || excluded.has(startsAt.getTime()) || (event.repeat === "weekdays" && !repeatDays.includes(zonedDateFields(startsAt, timeZone).getUTCDay()))) continue;
    return startsAt;
  }
  return null;
}

export function rescheduleCalendarOccurrence(event: CalendarEvent, startsAt: Date, endsAt: Date, effectiveFrom: Date): CalendarEventTimes | null {
  const timeZone = calendarTimeZone(event);
  const shift = zonedDateFields(startsAt, timeZone).getTime() - zonedDateFields(new Date(event.startsAt), timeZone).getTime();
  const threshold = dateFromZonedFields(new Date(zonedDateFields(effectiveFrom, timeZone).getTime() - shift), timeZone);
  let next = nextCalendarOccurrence(event, threshold);
  while (next) {
    const savedStart = shift === 0 ? next : dateFromZonedFields(new Date(zonedDateFields(next, timeZone).getTime() + shift), timeZone);
    if (savedStart >= effectiveFrom) return { startsAt: savedStart, endsAt: new Date(savedStart.getTime() + endsAt.getTime() - startsAt.getTime()) };
    next = nextCalendarOccurrence(event, new Date(next.getTime() + 1));
  }
  return null;
}

export function startOfDay(value: Date): Date {
  const fields = zonedDateFields(value, getUserTimeZone());
  fields.setUTCHours(0, 0, 0, 0);
  return dateFromZonedFields(fields, getUserTimeZone());
}

export function addDays(value: Date, days: number): Date {
  const fields = zonedDateFields(value, getUserTimeZone());
  fields.setUTCDate(fields.getUTCDate() + days);
  fields.setUTCHours(0, 0, 0, 0);
  return dateFromZonedFields(fields, getUserTimeZone());
}

export function addMonths(value: Date, months: number): Date {
  const fields = zonedDateFields(value, getUserTimeZone());
  fields.setUTCDate(1);
  fields.setUTCMonth(fields.getUTCMonth() + months);
  fields.setUTCHours(0, 0, 0, 0);
  return dateFromZonedFields(fields, getUserTimeZone());
}

export function startOfMonth(value: Date): Date {
  return addMonths(value, 0);
}

export function defaultCalendarStart(day: Date): Date {
  const hour = Math.min(Math.max(zonedDateFields(new Date(), getUserTimeZone()).getUTCHours() + 1, CALENDAR_START_HOUR), CALENDAR_END_HOUR - 1);
  const fields = zonedDateFields(day, getUserTimeZone());
  fields.setUTCHours(hour, 0, 0, 0);
  return dateFromZonedFields(fields, getUserTimeZone());
}

export function monthGridDates(month: Date): Date[] {
  const first = startOfMonth(month);
  const gridStart = addDays(first, -zonedDateFields(first, getUserTimeZone()).getUTCDay());
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function startOfWeek(value: Date): Date {
  return addDays(startOfDay(value), -zonedDateFields(value, getUserTimeZone()).getUTCDay());
}

export function dateKey(value: Date): string {
  return zonedDateFields(value, getUserTimeZone()).toISOString().slice(0, 10);
}

export function formatLocalDateTime(value: Date): string {
  return formatUserDateTimeLocal(value);
}

export function eventEndAfterMinutes(start: string, minutes: number): string {
  const startDate = parseUserDateTimeLocal(start);
  if (!startDate) return "";
  return formatLocalDateTime(new Date(startDate.getTime() + minutes * 60_000));
}

export function currentTimePosition(value: Date): number {
  const fields = zonedDateFields(value, getUserTimeZone());
  return ((fields.getUTCHours() - CALENDAR_START_HOUR) * 60 + fields.getUTCMinutes() + fields.getUTCSeconds() / 60) * CALENDAR_HOUR_HEIGHT / 60;
}

export function formatHour(hour: number): string {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(getDisplayLocale(), { hour: "numeric" });
}

export function formatEventTime(value: Date): string {
  const minutes = zonedDateFields(value, getUserTimeZone()).getUTCMinutes();
  return formatUserDate(value, { hour: "numeric", minute: minutes ? "2-digit" : undefined });
}

export function formatEventRange(event: CalendarEvent): string {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  return `${formatEventTime(start)} – ${formatEventTime(end)}`;
}

export function groupUpcomingEvents(events: CalendarEvent[], today: Date, t: Translator = defaultTranslator): EventGroup[] {
  const todayStart = startOfDay(today);
  const tomorrowStart = addDays(todayStart, 1);
  const groups: EventGroup[] = [];

  for (const event of events) {
    const eventDate = startOfDay(new Date(event.startsAt));
    if (eventDate < todayStart) continue;
    const key = dateKey(eventDate);
    const label = key === dateKey(todayStart)
      ? t("calendar.today")
      : key === dateKey(tomorrowStart)
        ? t("calendar.tomorrow")
        : formatUserDate(eventDate, { month: "short", day: "numeric", year: "numeric" });
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.key === key) lastGroup.events.push(event);
    else groups.push({ key, label, events: [event] });
  }

  return groups;
}

export function takeUpcomingGroups(groups: EventGroup[], count: number): EventGroup[] {
  const visible: EventGroup[] = [];
  let remaining = count;
  for (const group of groups) {
    if (remaining <= 0) break;
    const events = group.events.slice(0, remaining);
    if (events.length) visible.push({ ...group, events });
    remaining -= events.length;
  }
  return visible;
}

export function eventPosition(event: CalendarEvent, day: Date): { top: number; height: number } | null {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  if (start >= dayEnd || end <= dayStart) return null;
  const startFields = zonedDateFields(start, getUserTimeZone());
  const endFields = zonedDateFields(end, getUserTimeZone());
  const startMinutes = start <= dayStart ? 0 : startFields.getUTCHours() * 60 + startFields.getUTCMinutes() + startFields.getUTCSeconds() / 60;
  const endMinutes = end >= dayEnd ? 24 * 60 : endFields.getUTCHours() * 60 + endFields.getUTCMinutes() + endFields.getUTCSeconds() / 60;
  // A repeated hour can put the end above the start on this wall-clock grid.
  const heightMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : 15;
  return {
    top: (startMinutes - CALENDAR_START_HOUR * 60) * CALENDAR_HOUR_HEIGHT / 60,
    height: heightMinutes * CALENDAR_HOUR_HEIGHT / 60,
  };
}

export function dropStartForPosition(day: Date, pixelsFromTop: number): Date {
  const minutes = Math.max(0, Math.min(24 * 60 - 15, Math.round(pixelsFromTop * 60 / CALENDAR_HOUR_HEIGHT / 15) * 15));
  const fields = zonedDateFields(startOfDay(day), getUserTimeZone());
  fields.setUTCMinutes(minutes);
  return dateFromZonedFields(fields, getUserTimeZone());
}

export function resizeEventTimes(event: CalendarEvent, day: Date, edge: EventResizeEdge, pixelsFromTop: number): { startsAt: Date; endsAt: Date } {
  const minimum = edge === "start" ? 0 : 15;
  const maximum = edge === "start" ? 24 * 60 - 15 : 24 * 60;
  const minutes = Math.max(minimum, Math.min(maximum, Math.round(pixelsFromTop * 60 / CALENDAR_HOUR_HEIGHT / 15) * 15));
  const fields = zonedDateFields(startOfDay(day), getUserTimeZone());
  fields.setUTCMinutes(minutes);
  const boundary = dateFromZonedFields(fields, getUserTimeZone());
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  if (edge === "start") {
    return { startsAt: new Date(Math.min(boundary.getTime(), endsAt.getTime() - 15 * 60_000)), endsAt };
  }
  return { startsAt, endsAt: new Date(Math.max(boundary.getTime(), startsAt.getTime() + 15 * 60_000)) };
}
