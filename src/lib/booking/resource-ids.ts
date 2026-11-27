/** Rooms per event type, the same limit as an event (spec F9 section 5). */
export const MAX_BOOKING_ROOMS = 5;

/** The rooms a stored event type reserves: a JSON list of distinct ids; anything else (a bad or missing value) is no rooms. */
export function parseBookingResourceIds(value: unknown): string[] {
	try {
		const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
		if (Array.isArray(parsed) && parsed.length <= MAX_BOOKING_ROOMS && parsed.every((id) => typeof id === "string" && id.length > 0) && new Set(parsed).size === parsed.length) return parsed as string[];
	} catch { /* An unreadable list books no room, as before rooms existed. */ }
	return [];
}
