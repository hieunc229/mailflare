import { dateFromZonedFields, zonedDateFields } from "@/lib/time/utils";

/** The most people the free/busy endpoint answers for at once (spec F9 section 5). */
export const MAX_GUESTS = 50;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
/** Working hours the "Find a time" suggestions stay inside, and how far ahead they look (spec F9 8.6). */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;
export const FIND_DAYS = 14;
/** The longest event a working-day slot can hold. */
export const MAX_FIND_DURATION_MS = (WORK_END_HOUR - WORK_START_HOUR) * 3_600_000;
const STEP_MS = 30 * 60_000;

/** The guest field's addresses: split on commas, semicolons and spaces, lower-cased, valid and unique; the first 50 only. */
export function parseGuestAddresses(text: string): { addresses: string[]; truncated: boolean } {
	const unique = [...new Set(text.split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter((item) => item.length <= 254 && EMAIL.test(item)))];
	return { addresses: unique.slice(0, MAX_GUESTS), truncated: unique.length > MAX_GUESTS };
}

/** The day an event starts on, and the three-day span (a day either side) to ask the server for, in the person's zone. */
export function availabilityWindow(start: Date, zone: string): { dayStart: Date; dayEnd: Date; from: Date; to: Date } {
	const midnight = (offset: number) => {
		const fields = zonedDateFields(start, zone);
		fields.setUTCDate(fields.getUTCDate() + offset);
		fields.setUTCHours(0, 0, 0, 0);
		return dateFromZonedFields(fields, zone);
	};
	return { dayStart: midnight(0), dayEnd: midnight(1), from: midnight(-1), to: midnight(2) };
}

export type BusyBlock = { left: number; width: number; from: Date; to: Date };

/** Busy intervals (ISO pairs) as blocks on one day's bar, in percent of its width; the parts outside the day are cut off. */
export function busyBlocks(busy: string[][], dayStart: Date, dayEnd: Date): BusyBlock[] {
	const span = dayEnd.getTime() - dayStart.getTime();
	const blocks: BusyBlock[] = [];
	for (const [rawFrom, rawTo] of busy) {
		const from = Math.max(new Date(rawFrom).getTime(), dayStart.getTime());
		const to = Math.min(new Date(rawTo).getTime(), dayEnd.getTime());
		if (!(to > from)) continue;
		blocks.push({ left: ((from - dayStart.getTime()) / span) * 100, width: ((to - from) / span) * 100, from: new Date(from), to: new Date(to) });
	}
	return blocks;
}

/** True when some busy interval overlaps [start, end); touching is not overlapping. */
export function overlapsAny(busy: string[][], start: Date, end: Date): boolean {
	return busy.some(([from, to]) => new Date(from).getTime() < end.getTime() && new Date(to).getTime() > start.getTime());
}

/**
 * The next free slots for everyone (`busyByPerson`: the people whose availability is known): the first fits of `durationMs` that
 * start on a half hour and end by 18:00, starting at 08:00 or `now`, over the next 14 days of the organiser's zone. Each
 * suggestion starts where the previous one ended, so three of them are three different options, not three shifts of one.
 */
export function findFreeSlots(options: { busyByPerson: string[][][]; durationMs: number; now: Date; zone: string; limit?: number }): { start: Date; end: Date }[] {
	const { busyByPerson, durationMs, now, zone, limit = 3 } = options;
	if (!(durationMs > 0) || durationMs > MAX_FIND_DURATION_MS) return [];
	const busy = busyByPerson.flat().map(([from, to]) => [new Date(from).getTime(), new Date(to).getTime()] as const).filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
	const today = zonedDateFields(now, zone);
	const slots: { start: Date; end: Date }[] = [];
	for (let offset = 0; offset < FIND_DAYS && slots.length < limit; offset++) {
		const at = (hour: number) => {
			const fields = new Date(today);
			fields.setUTCDate(fields.getUTCDate() + offset);
			fields.setUTCHours(hour, 0, 0, 0);
			return dateFromZonedFields(fields, zone).getTime();
		};
		const close = at(WORK_END_HOUR);
		let t = Math.max(at(WORK_START_HOUR), Math.ceil(now.getTime() / STEP_MS) * STEP_MS);
		while (t + durationMs <= close && slots.length < limit) {
			const clash = busy.find(([from, to]) => from < t + durationMs && to > t);
			if (clash) { t = Math.ceil(clash[1] / STEP_MS) * STEP_MS; continue; }
			slots.push({ start: new Date(t), end: new Date(t + durationMs) });
			t += durationMs;
			t = Math.ceil(t / STEP_MS) * STEP_MS;
		}
	}
	return slots;
}

