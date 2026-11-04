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
