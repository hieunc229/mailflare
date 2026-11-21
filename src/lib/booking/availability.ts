import { and, inArray, isNull, lt, or, gt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { chunkIds } from "@/lib/calendar/chunks";
import { dateFromZonedFields, zonedDateFields } from "@/lib/time/utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { slotFromLocalDate, timeToMinutes } from "./utils";
import type { BookingEventRecord, ExistingCalendarEvent } from "./types";

function validBookingInterval(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 999 ? (value as number) : 1;
}

function daysInMonthUtc(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Day of the month of the nth `weekday` (0-6): week 1-5 from the first, -1 is the last; a missing week falls back to the last one. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, week: number): number {
	const dim = daysInMonthUtc(year, month);
	if (week === -1) {
		const lastDow = new Date(Date.UTC(year, month, dim)).getUTCDay();
		return dim - ((lastDow - weekday + 7) % 7);
	}
	const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
	let date = 1 + ((weekday - firstDow + 7) % 7) + (week - 1) * 7;
	while (date > dim) date -= 7;
	return date;
}

type BookingOverride = { occurrenceMs: number; startsAt: Date; endsAt: Date };

/** Whether the rule of `event` has an occurrence on the wall-clock day `day` (UTC-midnight wall fields of its zone). */
function ruleOccursOnDay(event: ExistingCalendarEvent, day: Date, firstWall: Date, interval: number): boolean {
	const days = Math.round((Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - Date.UTC(firstWall.getUTCFullYear(), firstWall.getUTCMonth(), firstWall.getUTCDate())) / 86_400_000);
	if (days < 0) return false;
	const months = (day.getUTCFullYear() - firstWall.getUTCFullYear()) * 12 + day.getUTCMonth() - firstWall.getUTCMonth();
	if (event.repeat === "daily") return days % interval === 0;
	if (event.repeat === "weekly") return days % (7 * interval) === 0;
	// A listed-days repeat steps day by day, so its interval is always 1.
	if (event.repeat === "weekdays") return parseCalendarRepeatDays(event.repeatDays).includes(day.getUTCDay());
	if (event.repeat === "yearly") {
		const years = day.getUTCFullYear() - firstWall.getUTCFullYear();
		if (years < 0 || years % interval !== 0 || day.getUTCMonth() !== firstWall.getUTCMonth()) return false;
		// February 29 clamps to February 28 outside leap years, like the calendar.
		return day.getUTCDate() === Math.min(firstWall.getUTCDate(), daysInMonthUtc(day.getUTCFullYear(), day.getUTCMonth()));
	}
	if (event.repeat === "monthly") {
		if (months < 0 || months % interval !== 0) return false;
		const dim = daysInMonthUtc(day.getUTCFullYear(), day.getUTCMonth());
		if (Number.isInteger(event.repeatWeekday) && (event.repeatWeekday as number) >= 0 && (event.repeatWeekday as number) <= 6
			&& Number.isInteger(event.repeatWeek) && (((event.repeatWeek as number) >= 1 && (event.repeatWeek as number) <= 5) || event.repeatWeek === -1)) {
			return day.getUTCDate() === nthWeekdayOfMonth(day.getUTCFullYear(), day.getUTCMonth(), event.repeatWeekday as number, event.repeatWeek as number);
		}
		return day.getUTCDate() === Math.min(event.repeatAnchorDay ?? firstWall.getUTCDate(), dim);
	}
	return false;
}

function repeatsDuring(event: ExistingCalendarEvent, start: Date, end: Date, overrides?: BookingOverride[]): boolean {
	const first = event.startsAt;
	const duration = event.endsAt.getTime() - first.getTime();
	if (event.repeat === "none") return first < end && event.endsAt > start;
	const zone = event.timeZone || "UTC";
	const interval = event.repeat === "weekdays" ? 1 : validBookingInterval(event.repeatInterval);
	const firstWall = zonedDateFields(first, zone);
	const candidate = zonedDateFields(new Date(start.getTime() - duration), zone);
	const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
	const byMs = new Map((overrides ?? []).map((override) => [override.occurrenceMs, override]));
	// Occurrences already decided below; an exclusion wins even over a moved override, like the calendar.
	const decided = new Set<number>();
	for (let offset = 0; offset < Math.ceil(duration / 86_400_000) + 2; offset++) {
		const day = new Date(candidate);
		day.setUTCDate(day.getUTCDate() + offset);
		day.setUTCHours(firstWall.getUTCHours(), firstWall.getUTCMinutes(), firstWall.getUTCSeconds(), firstWall.getUTCMilliseconds());
		if (!ruleOccursOnDay(event, day, firstWall, interval)) continue;
		const occurrence = dateFromZonedFields(day, zone);
		if (occurrence < first || (event.repeatUntil && occurrence >= event.repeatUntil) || excluded.has(occurrence.getTime())) {
			decided.add(occurrence.getTime());
			continue;
		}
		decided.add(occurrence.getTime());
		// A moved occurrence blocks at its override time, not its original time.
		const override = byMs.get(occurrence.getTime());
		const blockedStart = override?.startsAt ?? occurrence;
		const blockedEnd = override ? override.endsAt : new Date(occurrence.getTime() + duration);
		if (blockedStart < end && blockedEnd > start) return true;
	}
	// Extra occurrences (RDATEs) block at their own times.
	for (const override of byMs.values()) {
		if (excluded.has(override.occurrenceMs) || decided.has(override.occurrenceMs)) continue;
		if (override.startsAt < end && override.endsAt > start) return true;
	}
	return false;
}

export async function availableBookingSlots(env: CloudflareEnv, event: BookingEventRecord, days = 14) {
	const now = new Date();
	const today = zonedDateFields(now, event.timeZone);
	today.setUTCHours(0, 0, 0, 0);
	const end = new Date(now.getTime() + (days + 2) * 86_400_000);
	const existing = await getDb(env).select().from(calendarEvents).where(and(inArray(calendarEvents.userId, event.hostIds), lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, now), ne(calendarEvents.repeat, "none")), or(isNull(calendarEvents.responseStatus), ne(calendarEvents.responseStatus, "needs-action"))));
	// Moved/extra occurrences block at their override time: one map for the whole host set, in D1-safe chunks.
	const overridesById = new Map<string, BookingOverride[]>();
	if (existing.length) {
		const db = getDb(env);
		for (const chunk of chunkIds(existing.map((row) => row.id))) {
			const rows = await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk));
			for (const row of rows) {
				const list = overridesById.get(row.eventId) ?? [];
				list.push({ occurrenceMs: row.occurrenceMs, startsAt: row.startsAt, endsAt: row.endsAt });
				overridesById.set(row.eventId, list);
			}
		}
	}
	const slots: { startsAt: string; endsAt: string; localDate: string; time: string }[] = [];
	for (let offset = 0; offset < days; offset++) {
		const day = new Date(today);
		day.setUTCDate(day.getUTCDate() + offset);
		if (!event.weekdays.includes(day.getUTCDay())) continue;
		const localDate = day.toISOString().slice(0, 10);
		for (const range of event.timeRanges) for (let minute = timeToMinutes(range.startTime); minute + event.durationMinutes <= timeToMinutes(range.endTime); minute += 15) {
			const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
			const slot = slotFromLocalDate(event, localDate, time);
			if (!slot || slot.startsAt.getTime() < now.getTime() + 60 * 60_000) continue;
			if (existing.some((calendarEvent) => repeatsDuring(calendarEvent, slot.startsAt, slot.endsAt, overridesById.get(calendarEvent.id)))) continue;
			slots.push({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), localDate, time });
		}
	}
	return slots;
}
