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
