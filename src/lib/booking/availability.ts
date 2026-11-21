import { and, inArray, isNull, lt, or, gt, ne, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { dateFromZonedFields, zonedDateFields } from "@/lib/time/utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { expandEvent, expandEventOccurrences } from "@/lib/calendar/rrule";
import { OFF_CALENDAR_RESPONSES } from "@/lib/calendar/response-status";
import { slotFromLocalDate, timeToMinutes } from "./utils";
import type { BookingEventRecord, ExistingCalendarEvent } from "./types";

export function repeatsDuring(event: ExistingCalendarEvent, start: Date, end: Date): boolean {
	if (event.repeat === "custom") return expandEventOccurrences(event, start, end, 1).length > 0;
	const first = event.startsAt;
	const duration = event.endsAt.getTime() - first.getTime();
	if (event.repeat === "none") return first < end && event.endsAt > start;
	const zone = event.timeZone || "UTC";
	const firstWall = zonedDateFields(first, zone);
	const candidate = zonedDateFields(new Date(start.getTime() - duration), zone);
	const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
	for (let offset = 0; offset < Math.ceil(duration / 86_400_000) + 2; offset++) {
		const day = new Date(candidate);
		day.setUTCDate(day.getUTCDate() + offset);
		day.setUTCHours(firstWall.getUTCHours(), firstWall.getUTCMinutes(), firstWall.getUTCSeconds(), firstWall.getUTCMilliseconds());
		const days = Math.round((Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - Date.UTC(firstWall.getUTCFullYear(), firstWall.getUTCMonth(), firstWall.getUTCDate())) / 86_400_000);
		if (days < 0) continue;
		const months = (day.getUTCFullYear() - firstWall.getUTCFullYear()) * 12 + day.getUTCMonth() - firstWall.getUTCMonth();
		const occurs = event.repeat === "daily" || (event.repeat === "weekly" && days % 7 === 0) || (event.repeat === "weekdays" && parseCalendarRepeatDays(event.repeatDays).includes(day.getUTCDay())) || (event.repeat === "monthly" && months >= 0 && day.getUTCDate() === Math.min(event.repeatAnchorDay ?? firstWall.getUTCDate(), new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate()));
		if (!occurs) continue;
		const occurrence = dateFromZonedFields(day, zone);
		if (occurrence < first || (event.repeatUntil && occurrence >= event.repeatUntil) || excluded.has(occurrence.getTime())) continue;
		if (occurrence < end && occurrence.getTime() + duration > start.getTime()) return true;
	}
	return false;
}

/**
 * `(start, end) => busy` for a request that tests many slots against the same events: a custom rule is expanded once for
 * [from, to), so each slot only compares numbers instead of walking the rule again.
 */
export function busyCheck(events: ExistingCalendarEvent[], from: Date, to: Date): (start: Date, end: Date) => boolean {
	// A rule whose walk hit the work budget may have occurrences we did not see: it counts as busy for the whole window (null).
	const custom = new Map<ExistingCalendarEvent, Date[] | null>();
	for (const event of events) if (event.repeat === "custom") { const { starts, exhausted } = expandEvent(event, new Date(from.getTime() - (event.endsAt.getTime() - event.startsAt.getTime())), to, 2000); custom.set(event, exhausted ? null : starts); }
	return (start, end) => events.some((event) => {
		const starts = custom.get(event);
		if (starts === null) return true;
		if (!starts) return repeatsDuring(event, start, end);
		const duration = event.endsAt.getTime() - event.startsAt.getTime();
		return starts.some((at) => at < end && at.getTime() + duration > start.getTime());
	});
}

export async function availableBookingSlots(env: CloudflareEnv, event: BookingEventRecord, days = 14) {
	const now = new Date();
	const today = zonedDateFields(now, event.timeZone);
	today.setUTCHours(0, 0, 0, 0);
	const end = new Date(now.getTime() + (days + 2) * 86_400_000);
	const existing = await getDb(env).select().from(calendarEvents).where(and(inArray(calendarEvents.userId, event.hostIds), lt(calendarEvents.startsAt, end), or(gt(calendarEvents.endsAt, now), ne(calendarEvents.repeat, "none")), or(isNull(calendarEvents.responseStatus), notInArray(calendarEvents.responseStatus, [...OFF_CALENDAR_RESPONSES]))));
	const busy = busyCheck(existing, now, end);
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
			if (busy(slot.startsAt, slot.endsAt)) continue;
			slots.push({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), localDate, time });
		}
	}
	return slots;
}
