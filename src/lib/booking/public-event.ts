import type { BookingEventRecord } from "./types";

/**
 * What a visitor's booking page may know about an event type: what it draws, and the owner's id (the page checks it against the URL).
 * An allowlist, so a column added to `booking_events` later is not published by accident: no hosts, rooms, enabled flag or timestamps.
 */
export function toPublicBookingEvent(event: BookingEventRecord) {
	const { id, slug, userId, name, description, color, durationMinutes, location, weekdays, startTime, endTime, timeRanges, timeZone } = event;
	return { id, slug, userId, name, description, color, durationMinutes, location, weekdays, startTime, endTime, timeRanges, timeZone };
}
