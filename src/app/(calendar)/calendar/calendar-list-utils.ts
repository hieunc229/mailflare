import type { CalendarSummary } from "@/lib/calendar/calendars-types";
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
	if (status === 403) return "calendar.calendars.error.denied";
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

type Translate = (key: never, values?: Record<string, string | number>) => string;
type Listed = Pick<CalendarSummary, "name" | "role" | "ownerName" | "ownerId">;

/** The name a calendar goes by: its own, else the localised default label, or "<owner>'s calendar" for someone else's unnamed default. */
export function calendarLabel(calendar: Listed, t: Translate): string {
	if (calendar.name) return calendar.name;
	return calendar.role === "owner" ? t("calendar.defaultName" as never) : t("calendar.shared.calendarOf" as never, { owner: calendar.ownerName ?? "" });
}

/** Roles that may change events (the editor offers only these calendars). */
export const canWriteEvents = (role: CalendarSummary["role"] | undefined): boolean => role === undefined || role === "owner" || role === "edit" || role === "manage";
/** Roles that may change a calendar's name and colour and who it is shared with. */
export const canManageCalendar = (role: CalendarSummary["role"]): boolean => role === "owner" || role === "manage";

/**
 * Calendars the event editor offers. A new event may go to any calendar the user can write to; an existing one stays with its owner
 * (the server refuses a move to someone else's calendar), so only the owner's calendars it can reach are offered.
 */
export function writableCalendars<T extends Pick<CalendarSummary, "id" | "role" | "ownerId">>(calendars: T[], editing: { calendarId?: string; role?: string } | null): T[] {
	const writable = calendars.filter((calendar) => canWriteEvents(calendar.role));
	if (!editing) return writable;
	if (!editing.role || editing.role === "owner") return writable.filter((calendar) => calendar.role === "owner");
	const current = calendars.find((calendar) => calendar.id === editing.calendarId);
	return writable.filter((calendar) => calendar.role !== "owner" && calendar.ownerId === current?.ownerId);
}

/** The translation key for a failed sharing request, chosen by the response status so the server's English text is never shown. */
export function shareErrorKey(status: number, code?: string): string {
	if (status === 404) return "calendar.share.error.notFound";
	if (status === 400) return "calendar.share.error.invalid";
	if (status === 409) return code === "ALREADY_SHARED" ? "calendar.share.error.exists" : code === "SHARE_LIMIT" ? "calendar.share.error.limit" : "calendar.share.error.conflict";
	if (status === 403) return "calendar.share.error.denied";
	return "calendar.share.error.generic";
}

/** The translation key for a refused event save or delete, or null when the server's own text is the better message (a validation error). */
export function eventErrorKey(status: number, code?: string): string | null {
	if (code === "INVITE_REQUIRES_OWNER") return "calendar.share.inviteRefused";
	return status === 403 || status === 404 ? "calendar.share.error.eventDenied" : null;
}
