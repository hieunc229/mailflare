import { expandToolEvents } from "./tool-occurrences";
import type { calendarEvents } from "@/db/schema";

/** Offsets the event editor offers, in minutes before the start. */
export const REMINDER_MINUTE_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080] as const;

export const MAX_REMINDER_MINUTES = 10080;

/** Reminder offset from untrusted input: a whole number of minutes in range, otherwise no reminder. */
export function normalizeReminderMinutes(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_MINUTES ? value : null;
}

/** Push body: when the occurrence starts in the event's zone, then the place if it has one. */
export function formatReminderBody(startsAt: Date, timeZone: string, location: string): string {
	let time: string;
	try {
		time = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(startsAt);
	} catch {
		time = startsAt.toISOString();
	}
	const place = location.trim();
	return place ? `${time} · ${place}` : time;
}

/** The reminder cron period. An "at time of event" reminder has a zero-width window, so it also fires for starts up to this long ago, but only for events that existed (were last saved) before that start. */
export const REMINDER_GRACE_MS = 5 * 60_000;

/** Occurrences of `event` whose reminder is due at `now`, newer than `lastReminded` (ms), oldest first. */
export function dueReminderOccurrences(event: typeof calendarEvents.$inferSelect, now: Date, lastReminded: number, limit: number, overrides?: Array<{ occurrenceMs: number; startsAt: Date; endsAt: Date }>) {
	const lead = (event.reminderMinutes ?? 0) * 60_000;
	const grace = lead === 0 ? REMINDER_GRACE_MS : 0;
	return expandToolEvents([event], new Date(now.getTime() - grace), new Date(now.getTime() + lead + 1), 500, overrides ? new Map([[event.id, overrides]]) : undefined)
		.map((occurrence) => ({ ...occurrence, start: new Date(occurrence.startsAt) }))
		.filter((occurrence) => {
			const start = occurrence.start.getTime();
			// An occurrence already under way only counts if the event was not created or edited after it began.
			if (start <= now.getTime() && event.updatedAt.getTime() > start) return false;
			return start + grace > now.getTime() && start - lead <= now.getTime() && start > lastReminded;
		})
		.slice(0, limit);
}
