import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";
import type { calendarEvents } from "@/db/schema";

type EventRow = typeof calendarEvents.$inferSelect;

/** One edited occurrence (RECURRENCE-ID): replaces the rule occurrence at `occurrenceMs`, or adds an extra one when no rule occurrence has that start. */
export type ToolOccurrenceOverride = { occurrenceMs: number; startsAt: Date; endsAt: Date };

function validInterval(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 999 ? (value as number) : 1;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function nthWeekdayDate(year: number, month: number, weekday: number, week: number): number {
	const dim = daysInMonth(year, month);
	if (week === -1) {
		const lastDow = new Date(Date.UTC(year, month, dim)).getUTCDay();
		return dim - ((lastDow - weekday + 7) % 7);
	}
	const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
	let date = 1 + ((weekday - firstDow + 7) % 7) + (week - 1) * 7;
	while (date > dim) date -= 7;
	return date;
}

function nthWeekday(event: EventRow): { weekday: number; week: number } | null {
	return event.repeat === "monthly" && Number.isInteger(event.repeatWeekday) && (event.repeatWeekday as number) >= 0 && (event.repeatWeekday as number) <= 6
		&& Number.isInteger(event.repeatWeek) && (((event.repeatWeek as number) >= 1 && (event.repeatWeek as number) <= 5) || event.repeatWeek === -1)
		? { weekday: event.repeatWeekday as number, week: event.repeatWeek as number }
		: null;
}

function occurrenceStart(event: EventRow, index: number): Date {
	if (index === 0) return event.startsAt;
	// A listed-days repeat steps day by day and filters by weekday, so its interval is always 1.
	const interval = event.repeat === "weekdays" ? 1 : validInterval(event.repeatInterval);
	const zone = normalizeTimeZone(event.timeZone);
	const fields = zonedDateFields(event.startsAt, zone);
	if (event.repeat === "monthly") {
		const nth = nthWeekday(event);
		if (nth) {
			fields.setUTCDate(1);
			fields.setUTCMonth(fields.getUTCMonth() + index * interval);
			fields.setUTCDate(nthWeekdayDate(fields.getUTCFullYear(), fields.getUTCMonth(), nth.weekday, nth.week));
		} else {
			const day = event.repeatAnchorDay ?? fields.getUTCDate();
			fields.setUTCDate(1);
			fields.setUTCMonth(fields.getUTCMonth() + index * interval);
			fields.setUTCDate(Math.min(day, daysInMonth(fields.getUTCFullYear(), fields.getUTCMonth())));
		}
	} else if (event.repeat === "yearly") {
		const day = fields.getUTCDate();
		const month = fields.getUTCMonth();
		fields.setUTCDate(1);
		fields.setUTCFullYear(fields.getUTCFullYear() + index * interval);
		fields.setUTCMonth(month);
		fields.setUTCDate(Math.min(day, daysInMonth(fields.getUTCFullYear(), month)));
	} else fields.setUTCDate(fields.getUTCDate() + index * interval * (event.repeat === "weekly" ? 7 : 1));
	return dateFromZonedFields(fields, zone);
}

export function expandToolEvents(events: EventRow[], start: Date, end: Date, max = 500, overrides?: Map<string, ToolOccurrenceOverride[]>) {
	const result: Array<{ id: string; seriesId: string; title: string; description: string; location: string; attendees: string[]; color: string; repeat: string; timeZone: string; startsAt: string; endsAt: string }> = [];
	for (const event of events) {
		const duration = event.endsAt.getTime() - event.startsAt.getTime();
		const zone = normalizeTimeZone(event.timeZone);
		const first = zonedDateFields(event.startsAt, zone);
		const target = zonedDateFields(new Date(start.getTime() - duration), zone);
		const interval = event.repeat === "weekdays" ? 1 : validInterval(event.repeatInterval);
		const step = (event.repeat === "weekly" ? 7 : 1) * interval;
		const initial = event.repeat === "monthly" || event.repeat === "yearly"
			? Math.max(0, event.repeat === "monthly"
				? Math.floor(((target.getUTCFullYear() - first.getUTCFullYear()) * 12 + target.getUTCMonth() - first.getUTCMonth() - 1) / interval)
				: Math.floor((target.getUTCFullYear() - first.getUTCFullYear() - 1) / interval))
			: Math.max(0, Math.floor((target.getTime() - first.getTime()) / (86_400_000 * step)) - 1);
		const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
		const days = parseCalendarRepeatDays(event.repeatDays);
		const byMs = new Map((overrides?.get(event.id) ?? []).map((override) => [override.occurrenceMs, override]));
		const ruleMs = new Set<number>();
		for (let index = event.repeat === "none" ? 0 : initial; index < (event.repeat === "none" ? 1 : initial + 400); index++) {
			const at = occurrenceStart(event, index);
			if (at >= end || (event.repeatUntil && at >= event.repeatUntil)) break;
			ruleMs.add(at.getTime());
			if (at.getTime() + duration <= start.getTime() || excluded.has(at.getTime())) continue;
			if (event.repeat === "weekdays" && !days.includes(zonedDateFields(at, zone).getUTCDay())) continue;
			let attendees: string[] = [];
			try { attendees = JSON.parse(event.attendees) as string[]; } catch { /* Old malformed data remains readable. */ }
			const override = byMs.get(at.getTime());
			result.push(override
				? { id: `${event.id}@${at.getTime()}`, seriesId: event.id, title: event.title, description: event.description, location: event.location, attendees, color: event.color, repeat: event.repeat, timeZone: zone, startsAt: override.startsAt.toISOString(), endsAt: override.endsAt.toISOString() }
				: { id: event.repeat === "none" ? event.id : `${event.id}@${at.getTime()}`, seriesId: event.id, title: event.title, description: event.description, location: event.location, attendees, color: event.color, repeat: event.repeat, timeZone: zone, startsAt: at.toISOString(), endsAt: new Date(at.getTime() + duration).toISOString() });
			if (result.length >= max) return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
		}
		// Overrides on no rule occurrence (RDATEs) are extra occurrences, unless excluded or outside the window.
		for (const override of byMs.values()) {
			if (ruleMs.has(override.occurrenceMs) || excluded.has(override.occurrenceMs)) continue;
			if (override.endsAt <= start || override.startsAt >= end) continue;
			let attendees: string[] = [];
			try { attendees = JSON.parse(event.attendees) as string[]; } catch { /* Old malformed data remains readable. */ }
			result.push({ id: `${event.id}@${override.occurrenceMs}`, seriesId: event.id, title: event.title, description: event.description, location: event.location, attendees, color: event.color, repeat: event.repeat, timeZone: zone, startsAt: override.startsAt.toISOString(), endsAt: override.endsAt.toISOString() });
			if (result.length >= max) return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
		}
	}
	return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
