import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";
import { expandEventOccurrences } from "./rrule";
import { isInactiveCalendarResponse } from "./response-status";
import type { calendarEvents } from "@/db/schema";

type EventRow = typeof calendarEvents.$inferSelect;

function occurrenceStart(event: EventRow, index: number): Date {
	if (index === 0) return event.startsAt;
	const zone = normalizeTimeZone(event.timeZone);
	const fields = zonedDateFields(event.startsAt, zone);
	if (event.repeat === "monthly") {
		const day = event.repeatAnchorDay ?? fields.getUTCDate();
		fields.setUTCDate(1);
		fields.setUTCMonth(fields.getUTCMonth() + index);
		fields.setUTCDate(Math.min(day, new Date(Date.UTC(fields.getUTCFullYear(), fields.getUTCMonth() + 1, 0)).getUTCDate()));
	} else fields.setUTCDate(fields.getUTCDate() + index * (event.repeat === "weekly" ? 7 : 1));
	return dateFromZonedFields(fields, zone);
}

export function expandToolEvents(events: EventRow[], start: Date, end: Date, max = 500) {
	const result: Array<{ id: string; seriesId: string; title: string; description: string; location: string; attendees: string[]; color: string; repeat: string; timeZone: string; startsAt: string; endsAt: string }> = [];
	for (const event of events) {
		if (isInactiveCalendarResponse(event.responseStatus)) continue;
		const duration = event.endsAt.getTime() - event.startsAt.getTime();
		const zone = normalizeTimeZone(event.timeZone);
		if (event.repeat === "custom") {
			let attendees: string[] = [];
			try { attendees = JSON.parse(event.attendees) as string[]; } catch { /* Old malformed data remains readable. */ }
			for (const at of expandEventOccurrences(event, start, end, max - result.length)) {
				result.push({ id: `${event.id}@${at.getTime()}`, seriesId: event.id, title: event.title, description: event.description, location: event.location, attendees, color: event.color, repeat: event.repeat, timeZone: zone, startsAt: at.toISOString(), endsAt: new Date(at.getTime() + duration).toISOString() });
			}
			if (result.length >= max) return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
			continue;
		}
		const first = zonedDateFields(event.startsAt, zone);
		const target = zonedDateFields(new Date(start.getTime() - duration), zone);
		const step = event.repeat === "weekly" ? 7 : 1;
		const initial = event.repeat === "monthly" ? Math.max(0, (target.getUTCFullYear() - first.getUTCFullYear()) * 12 + target.getUTCMonth() - first.getUTCMonth() - 1) : Math.max(0, Math.floor((target.getTime() - first.getTime()) / (86_400_000 * step)) - 1);
		const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
		const days = parseCalendarRepeatDays(event.repeatDays);
		for (let index = event.repeat === "none" ? 0 : initial; index < (event.repeat === "none" ? 1 : initial + 400); index++) {
			const at = occurrenceStart(event, index);
			if (at >= end || (event.repeatUntil && at >= event.repeatUntil)) break;
			if (at.getTime() + duration <= start.getTime() || excluded.has(at.getTime())) continue;
			if (event.repeat === "weekdays" && !days.includes(zonedDateFields(at, zone).getUTCDay())) continue;
			let attendees: string[] = [];
			try { attendees = JSON.parse(event.attendees) as string[]; } catch { /* Old malformed data remains readable. */ }
			result.push({ id: event.repeat === "none" ? event.id : `${event.id}@${at.getTime()}`, seriesId: event.id, title: event.title, description: event.description, location: event.location, attendees, color: event.color, repeat: event.repeat, timeZone: zone, startsAt: at.toISOString(), endsAt: new Date(at.getTime() + duration).toISOString() });
			if (result.length >= max) return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
		}
	}
	return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
