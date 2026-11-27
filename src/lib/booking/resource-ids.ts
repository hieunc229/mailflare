/** Rooms per event type, the same limit as an event (spec F9 section 5). */
export const MAX_BOOKING_ROOMS = 5;

/**
 * The rooms a stored event type reserves: a JSON list of distinct ids. A value that cannot be read (damaged, hand-edited, over the limit) is `null`,
 * never an empty list: reading it as "no rooms" would offer times without checking the rooms the owner chose. Callers that serve visitors refuse the type.
 */
export function parseBookingResourceIds(value: unknown): string[] | null {
	try {
		const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
		if (Array.isArray(parsed) && parsed.length <= MAX_BOOKING_ROOMS && parsed.every((id) => typeof id === "string" && id.length > 0) && new Set(parsed).size === parsed.length) return parsed as string[];
	} catch { /* Unreadable: null below. */ }
	return null;
}
