import { dateFromZonedFields, zonedDateFields } from "@/lib/time/utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "@/lib/calendar/recurrence";
import { expandEvent, expandEventOccurrences } from "@/lib/calendar/rrule";
import { busyIntervals, MAX_FREE_BUSY_DAYS, mergeBusy, type BusyInterval } from "@/lib/calendar/free-busy";
import { bookingRoomsUsable } from "./rooms";
import { slotFromLocalDate, timeToMinutes } from "./utils";
import type { BookingEventRecord, ExistingCalendarEvent } from "./types";

/** @deprecated Booking reads `busyIntervals` now (D-9). Kept because tests still exercise it (rules, overrides); delete with them. */
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

export function repeatsDuring(event: ExistingCalendarEvent, start: Date, end: Date, overrides?: BookingOverride[]): boolean {
	if (event.repeat === "custom") return expandEventOccurrences(event, start, end, 1).length > 0;
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

/** @deprecated See `repeatsDuring`.
 *
 * `(start, end) => busy` for a request that tests many slots against the same events: a custom rule is expanded once for
 * [from, to), so each slot only compares numbers instead of walking the rule again.
 */
export function busyCheck(events: ExistingCalendarEvent[], from: Date, to: Date, overridesById?: Map<string, BookingOverride[]>): (start: Date, end: Date) => boolean {
	// A rule whose walk hit the work budget may have occurrences we did not see: it counts as busy for the whole window (null).
	const custom = new Map<ExistingCalendarEvent, Date[] | null>();
	for (const event of events) if (event.repeat === "custom") { const { starts, exhausted } = expandEvent(event, new Date(from.getTime() - (event.endsAt.getTime() - event.startsAt.getTime())), to, 2000); custom.set(event, exhausted ? null : starts); }
	return (start, end) => events.some((event) => {
		const starts = custom.get(event);
		if (starts === null) return true;
		if (!starts) return repeatsDuring(event, start, end, overridesById?.get(event.id));
		const duration = event.endsAt.getTime() - event.startsAt.getTime();
		return starts.some((at) => at < end && at.getTime() + duration > start.getTime());
	});
}

/** The last day a public page may ask for: `busyIntervals` reads at most 62 days, and the window is the page plus two days. */
export const MAX_BOOKING_DAYS = MAX_FREE_BUSY_DAYS - 2;

/** Whether `[start, end)` touches any of the merged, sorted intervals. */
function overlapsAny(busy: BusyInterval[], start: number, end: number): boolean {
	let low = 0;
	let high = busy.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (busy[middle][1] <= start) low = middle + 1;
		else high = middle;
	}
	return low < busy.length && busy[low][0] < end;
}

/**
 * The start times a visitor may pick (D-9): the host's and every attached room's busy time come from the one free/busy service, so
 * a booking page and the calendar editor cannot disagree about what "busy" means. A slot is offered only when the hosts and all
 * rooms are free. Rooms are Team-only (D-13), so rooms that are gone, turned off or no longer licensed offer nothing at all, and
 * a calendar or room too heavy to read is busy for the whole window (unknown is never free).
 */
export async function availableBookingSlots(env: CloudflareEnv, event: BookingEventRecord, days = 14) {
	const now = new Date();
	const today = zonedDateFields(now, event.timeZone);
	today.setUTCHours(0, 0, 0, 0);
	days = Math.min(days, MAX_BOOKING_DAYS);
	const end = new Date(now.getTime() + (days + 2) * 86_400_000);
	const resourceIds = event.resourceIds ?? [];
	if (resourceIds.length && !(await bookingRoomsUsable(env, resourceIds, event.hostIds.length))) return [];
	const intervals = await busyIntervals(env, { userIds: event.hostIds, resourceIds }, now, end);
	const busy = mergeBusy([...intervals.values()].flat());
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
			if (overlapsAny(busy, slot.startsAt.getTime(), slot.endsAt.getTime())) continue;
			slots.push({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), localDate, time });
		}
	}
	return slots;
}
