import type { CalendarEvent } from "./types";

/** Which calendars are hidden is a per-browser choice, kept in localStorage. */
export const HIDDEN_CALENDARS_KEY = "mailflare.calendar.hidden";

export function readHiddenCalendars(): string[] {
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_CALENDARS_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch { return []; }
}

export function writeHiddenCalendars(ids: string[]): void {
	try { window.localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify(ids)); } catch { /* not remembered */ }
}

export function toggleHidden(hidden: string[], id: string): string[] {
	return hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
}

/** Events of hidden calendars drop out of every view. An event without a calendar id is in the default calendar. */
export function visibleCalendarEvents(events: CalendarEvent[], hidden: string[], defaultId: string | undefined): CalendarEvent[] {
	if (!hidden.length) return events;
	const set = new Set(hidden);
	return events.filter((event) => !set.has(event.calendarId ?? defaultId ?? ""));
}

/** The translation key for a failed save or delete, chosen by the response status so the server's English text is never shown. */
export function calendarErrorKey(action: "save" | "delete", status: number): string {
	if (status === 404) return "calendar.calendars.error.notFound";
	if (action === "save") return status === 409 ? "calendar.calendars.error.limit" : status === 400 ? "calendar.calendars.error.invalid" : "calendar.calendars.saveFailed";
	return status === 409 ? "calendar.calendars.error.defaultCalendar" : "calendar.calendars.deleteFailed";
}

/** Radio-group keyboard: the value an arrow, Home or End key selects (wrapping), or null for any other key. */
export function nextColor(values: readonly string[], current: string, key: string): string | null {
	const index = values.indexOf(current);
	const at = (position: number) => values[(position + values.length) % values.length];
	if (key === "ArrowRight" || key === "ArrowDown") return at(index + 1);
	if (key === "ArrowLeft" || key === "ArrowUp") return at(index - 1);
	if (key === "Home") return values[0];
	if (key === "End") return values[values.length - 1];
	return null;
}
